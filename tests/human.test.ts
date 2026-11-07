// The human check (Cloudflare Turnstile): the server's verification, and the
// way parseBody requires it on public routes. fetch stands in for Cloudflare.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("server-only", () => ({}));
const { verifyHuman, HUMAN_MESSAGE, HUMAN_UNAVAILABLE } = await import("@/lib/server/human");
const { parseBody } = await import("@/lib/server/api");
const { createHumanControl, humanHeaders } = await import("@/components/forms/human");
const { NextRequest } = await import("next/server");

const KEYS = ["NEXT_PUBLIC_TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY", "TURNSTILE_VERIFY_URL"] as const;
const saved: Record<string, string | undefined> = {};

function turnOn() {
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "1x00000000000000000000AA";
  process.env.TURNSTILE_SECRET_KEY = "1x0000000000000000000000000000000AA";
  process.env.TURNSTILE_VERIFY_URL = "https://verify.test/siteverify";
}

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

const cloudflare = (success: boolean, codes: string[] = []) =>
  vi.fn(async () => new Response(JSON.stringify({ success, "error-codes": codes }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

describe("verifyHuman", () => {
  it("is a no-op when the keys aren't both set", async () => {
    const f = cloudflare(false);
    expect(await verifyHuman(undefined, null, f)).toEqual({ ok: true, checked: false });
    process.env.TURNSTILE_SECRET_KEY = "only-the-secret";
    expect(await verifyHuman(undefined, null, f)).toEqual({ ok: true, checked: false });
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses a missing token without asking Cloudflare", async () => {
    turnOn();
    const f = cloudflare(true);
    expect(await verifyHuman(null, "10.0.0.1", f)).toMatchObject({ ok: false, status: 400, message: HUMAN_MESSAGE });
    expect(await verifyHuman("   ", "10.0.0.1", f)).toMatchObject({ ok: false, status: 400 });
    expect(await verifyHuman("x".repeat(3000), "10.0.0.1", f)).toMatchObject({ ok: false, status: 400 });
    expect(f).not.toHaveBeenCalled();
  });

  it("posts the secret, the token and the IP, and passes a good token", async () => {
    turnOn();
    const f = cloudflare(true);
    expect(await verifyHuman("good-token", "10.0.0.1", f)).toEqual({ ok: true, checked: true });
    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe("https://verify.test/siteverify");
    expect(init.method).toBe("POST");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("secret")).toBe(process.env.TURNSTILE_SECRET_KEY);
    expect(body.get("response")).toBe("good-token");
    expect(body.get("remoteip")).toBe("10.0.0.1");
  });

  it("refuses a token Cloudflare says is bad", async () => {
    turnOn();
    expect(await verifyHuman("used-token", null, cloudflare(false, ["timeout-or-duplicate"]))).toMatchObject({ ok: false, status: 400, message: HUMAN_MESSAGE });
  });

  it("fails closed, with a friendly retry message, when Cloudflare can't be reached", async () => {
    turnOn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await verifyHuman("any-token", null, down)).toEqual({ ok: false, status: 503, message: HUMAN_UNAVAILABLE, field: HUMAN_UNAVAILABLE });
    const broken = vi.fn(async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch;
    expect(await verifyHuman("any-token", null, broken)).toMatchObject({ ok: false, status: 503 });
    expect(await verifyHuman("any-token", null, cloudflare(false, ["internal-error"]))).toMatchObject({ ok: false, status: 503 });
    expect(error).toHaveBeenCalled();
  });
});

describe("parseBody with { human: true }", () => {
  const schema = z.object({ email: z.string(), website: z.string().max(0).optional() }).strict();
  let n = 0;
  const request = (body: unknown, headers: Record<string, string> = {}) =>
    new NextRequest("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `10.9.${Math.floor(++n / 250)}.${n % 250}`, ...headers },
      body: JSON.stringify(body),
    });

  it("passes without a header when the check is off", async () => {
    const r = await parseBody(request({ email: "a@b.ca" }), schema, "t-off", { human: true });
    expect(r).toEqual({ ok: true, data: { email: "a@b.ca" } });
  });

  it("with the check on: no header is a 400 with a human field error", async () => {
    turnOn();
    const f = vi.spyOn(globalThis, "fetch");
    const r = await parseBody(request({ email: "a@b.ca" }), schema, "t-none", { human: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(400);
    const body = await r.response.json();
    expect(body.error).toBe(HUMAN_MESSAGE);
    expect(body.fields.human).toBeTruthy();
    expect(f).not.toHaveBeenCalled();
  });

  it("with the check on: a good x-human-token header passes, and the IP goes with it", async () => {
    turnOn();
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(cloudflare(true));
    const r = await parseBody(request({ email: "a@b.ca" }, { "x-human-token": "ok-token" }), schema, "t-good", { human: true });
    expect(r).toEqual({ ok: true, data: { email: "a@b.ca" } });
    const body = new URLSearchParams(String((f.mock.calls[0][1] as RequestInit).body));
    expect(body.get("response")).toBe("ok-token");
    expect(body.get("remoteip")).toMatch(/^10\.9\./);
  });

  it("with the check on: a bad token is a 400", async () => {
    turnOn();
    vi.spyOn(globalThis, "fetch").mockImplementation(cloudflare(false, ["invalid-input-response"]));
    const r = await parseBody(request({ email: "a@b.ca" }, { "x-human-token": "bad-token" }), schema, "t-bad", { human: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(400);
  });

  it("checks after the honeypot (a bot gets its fake success without a call to Cloudflare) and before the schema", async () => {
    turnOn();
    const f = vi.spyOn(globalThis, "fetch");
    const bot = await parseBody(request({ email: "a@b.ca", website: "spam.example" }), schema, "t-bot", { human: true });
    expect(bot.ok).toBe(false);
    if (!bot.ok) expect(await bot.response.json()).toEqual({ ok: true });
    expect(f).not.toHaveBeenCalled();
    // An invalid body without a token is refused for the token, not the fields.
    const r = await parseBody(request({ nope: 1 }), schema, "t-order", { human: true });
    if (!r.ok) expect(r.response.status).toBe(400);
  });

  it("is not required unless asked for", async () => {
    turnOn();
    const r = await parseBody(request({ email: "a@b.ca" }), schema, "t-unasked");
    expect(r.ok).toBe(true);
  });
});

describe("the form side: humanHeaders", () => {
  it("sends no header when the form has no widget (site key unset)", async () => {
    expect(await humanHeaders(createHumanControl())).toEqual({ "content-type": "application/json" });
  });

  it("sends the widget's token, waiting for one that is on its way", async () => {
    const control = createHumanControl();
    let listener: ((t: string) => void) | null = null;
    const reset = vi.fn();
    control.attach({ token: () => null, onToken: (l) => ((listener = l), () => (listener = null)), reset });
    const pending = humanHeaders(control);
    setTimeout(() => listener?.("fresh-token"), 10);
    expect(await pending).toEqual({ "content-type": "application/json", "x-human-token": "fresh-token" });
    control.reset();
    expect(reset).toHaveBeenCalled();
  });

  it("gives up after the wait when no token comes", async () => {
    const control = createHumanControl();
    control.attach({ token: () => null, onToken: () => () => {}, reset: () => {} });
    expect(await control.token(20)).toBeNull();
  });
});
