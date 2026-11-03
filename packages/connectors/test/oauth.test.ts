import { describe, expect, it } from "vitest";
import { OAuth2Client, clientFromEnv } from "../src/index.ts";

const now = () => new Date("2026-11-03T00:00:00Z");

function fakeFetch(respond: (url: string, init: RequestInit) => { status?: number; body: unknown; text?: string }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = respond(url, init);
    return new Response(r.text ?? JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch & { calls: typeof calls };
  (fn as unknown as { calls: typeof calls }).calls = calls;
  return fn as typeof fetch & { calls: typeof calls };
}

describe("OAuth2Client", () => {
  const base = { name: "demo", authorizeUrl: "https://demo.example/authorize", tokenUrl: "https://demo.example/token", scopes: ["a", "b"] };

  it("builds authorize URLs with PKCE, custom scope separators and client id param names", () => {
    const c = new OAuth2Client({ ...base, pkce: true, clientAuth: "body", clientId: "cid", scopeSeparator: ",", clientIdParam: "client_key", extraAuthorizeParams: { prompt: "consent" } });
    const u = new URL(c.authorizeUrl({ state: "s", redirectUri: "https://app/cb", codeChallenge: "ch" }));
    expect(u.searchParams.get("client_key")).toBe("cid");
    expect(u.searchParams.get("scope")).toBe("a,b");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(c.configured).toBe(true);
    expect(new OAuth2Client({ ...base, pkce: false, clientAuth: "basic", clientId: "cid" }).configured).toBe(false); // needs a secret without PKCE
  });

  it("exchanges with basic auth, computes expiries, and unwraps data envelopes", async () => {
    const f = fakeFetch(() => ({ body: { data: { access_token: "at", refresh_token: "rt", expires_in: 3600, refresh_expires_in: "86400", open_id: "u1" } } }));
    const c = new OAuth2Client({ ...base, pkce: false, clientAuth: "basic", clientId: "cid", clientSecret: "sec" }, f, now);
    const t = await c.exchange({ code: "c", redirectUri: "https://app/cb" });
    expect(t).toMatchObject({ accessToken: "at", refreshToken: "rt", expiresAt: "2026-11-03T01:00:00.000Z", refreshExpiresAt: "2026-11-04T00:00:00.000Z" });
    expect(t.raw.open_id).toBe("u1");
    expect(String((f.calls[0]!.init.headers as Record<string, string>).authorization)).toMatch(/^Basic /);
  });

  it("keeps the old refresh token when the provider does not rotate, and maps errors", async () => {
    const ok = new OAuth2Client({ ...base, pkce: true, clientAuth: "body", clientId: "cid" }, fakeFetch(() => ({ body: { access_token: "at2" } })), now);
    expect((await ok.refresh("rt-old")).refreshToken).toBe("rt-old");
    const bad = new OAuth2Client({ ...base, pkce: true, clientAuth: "body", clientId: "cid" }, fakeFetch(() => ({ status: 400, body: { error: "invalid_grant", error_description: "expired" } })), now);
    await expect(bad.refresh("x")).rejects.toMatchObject({ kind: "auth", retryable: false });
    const slow = new OAuth2Client({ ...base, pkce: true, clientAuth: "body", clientId: "cid" }, fakeFetch(() => ({ status: 429, body: {} })), now);
    await expect(slow.refresh("x")).rejects.toMatchObject({ kind: "rate_limit", retryable: true });
    const formEncoded = new OAuth2Client({ ...base, pkce: true, clientAuth: "body", clientId: "cid" }, fakeFetch(() => ({ body: null, text: "access_token=f1&expires_in=60" })), now);
    expect((await formEncoded.refresh("x")).accessToken).toBe("f1");
  });

  it("reads client credentials from env", () => {
    expect(clientFromEnv({ META_CLIENT_ID: "1", META_CLIENT_SECRET: "2" }, "META")).toEqual({ clientId: "1", clientSecret: "2" });
    expect(clientFromEnv({}, "META")).toEqual({ clientId: undefined, clientSecret: undefined });
  });
});
