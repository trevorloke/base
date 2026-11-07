// The Starbase ("the desk") client: the payload rules that keep every
// website submission acceptable to Starbase's strict schema, and the outbox
// delivery state machine, with fetch and the database replaced by fakes.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: () => {} }));

const sb = await import("@/lib/server/starbase");
const { deliverWith, scrubbedOnceSent } = await import("@/lib/server/starbase-outbox");
type OutboxStore = import("@/lib/server/starbase-outbox").OutboxStore;
type OutboxRow = import("@/lib/server/starbase-outbox").OutboxRow;

const ALLOWED = new Set<string>(sb.STARBASE_FIELDS);
const keysOf = (o: object | null) => Object.keys(o ?? {});

describe("toStarbasePerson", () => {
  it("maps the website's fields to Starbase's names, trimmed, in a fixed order", () => {
    const p = sb.toStarbasePerson({
      firstName: "  Asha ",
      lastName: "Example",
      email: "  Asha@Example.ORG ",
      phone: " 604-555-0100 ",
      address: "13450 104 Ave",
      unit: "12",
      city: "Surrey",
      postalCode: "v3t 1v8",
      tags: ["Petition: Transit"],
      newsletter: true,
      volunteer: false,
      note: "",
      source: "petition:skytrain-south-surrey",
    });
    expect(p).toEqual({
      first_name: "Asha",
      last_name: "Example",
      email: "asha@example.org",
      phone: "604-555-0100",
      address: "13450 104 Ave",
      unit: "12",
      city: "Surrey",
      postal: "V3T 1V8",
      tags: ["Petition: Transit"],
      newsletter: true,
      source: "petition-skytrain-south-surrey",
    });
    expect(keysOf(p)).toEqual(sb.STARBASE_FIELDS.filter((f) => f in (p ?? {})));
  });

  it("drops empty values and false flags", () => {
    const p = sb.toStarbasePerson({ name: "   ", firstName: "", email: "a@b.ca", phone: null, address: undefined, tags: ["", "  "], newsletter: false, volunteer: false, note: "  " });
    expect(p).toEqual({ email: "a@b.ca" });
  });

  it("never emits a field outside Starbase's list, whatever it is given", () => {
    const input = {
      email: "donor@example.com",
      firstName: "D",
      amountCents: 5000,
      amount: 50,
      feeCents: 1000,
      rating: 5,
      role: "manager",
      slate: "council",
      stripePaymentIntentId: "pi_123",
    } as unknown as Parameters<typeof sb.toStarbasePerson>[0];
    const p = sb.toStarbasePerson(input);
    expect(keysOf(p).every((k) => ALLOWED.has(k))).toBe(true);
    expect(p).toEqual({ first_name: "D", email: "donor@example.com" });
    const raw = sb.cleanStarbasePerson({ email: "x@y.ca", money: 5, guests: 3, rsvp: true, person_id: "p" });
    expect(raw).toEqual({ email: "x@y.ca" });
  });

  it("caps every text at Starbase's own limit, after trimming", () => {
    const long = (n: number) => "x".repeat(n);
    const p = sb.toStarbasePerson({
      name: long(400),
      firstName: long(200),
      lastName: long(200),
      email: "ok@example.com",
      phone: long(60),
      address: long(1200),
      unit: long(50),
      city: long(150),
      postalCode: long(30),
      note: long(2500),
      source: long(120),
    })!;
    expect(p.name).toHaveLength(300);
    expect(p.first_name).toHaveLength(150);
    expect(p.last_name).toHaveLength(150);
    expect(p.phone).toHaveLength(40);
    expect(p.address).toHaveLength(1000);
    expect(p.unit).toHaveLength(40);
    expect(p.city).toHaveLength(120);
    expect(p.postal).toHaveLength(20);
    expect(p.note).toHaveLength(2000);
    expect(p.source!.length).toBeLessThanOrEqual(80);
  });

  it("never cuts through a surrogate pair, and trims what the cut leaves", () => {
    const p = sb.toStarbasePerson({ email: "a@b.ca", city: "x".repeat(119) + "😀" })!;
    expect(p.city).toBe("x".repeat(119));
    const q = sb.toStarbasePerson({ email: "a@b.ca", unit: "x".repeat(39) + " yz" })!;
    expect(q.unit).toBe("x".repeat(39));
  });

  it("keeps at most 20 tags of at most 40 characters, without blanks or repeats", () => {
    const tags = Array.from({ length: 30 }, (_, i) => `Tag ${i}`);
    const p = sb.toStarbasePerson({ email: "a@b.ca", tags: ["Petition:   Transit", "Petition: Transit", "", ...tags, "P".repeat(60)] })!;
    expect(p.tags).toHaveLength(20);
    expect(p.tags![0]).toBe("Petition: Transit");
    expect(new Set(p.tags).size).toBe(20);
    expect(p.tags!.every((t) => t.length >= 1 && t.length <= 40)).toBe(true);
    const long = sb.toStarbasePerson({ email: "a@b.ca", tags: ["Petition: " + "A very long campaign title that goes on and on"] })!;
    expect(long.tags![0]).toHaveLength(40);
  });

  it("needs an email or a phone, and a name or an email", () => {
    expect(sb.toStarbasePerson({ firstName: "No", lastName: "Contact" })).toBeNull();
    expect(sb.toStarbasePerson({ phone: "604 555 0100" })).toBeNull();
    expect(sb.toStarbasePerson({ name: "Pat", phone: "604 555 0100" })).toEqual({ name: "Pat", phone: "604 555 0100" });
    expect(sb.toStarbasePerson({ email: "only@example.com" })).toEqual({ email: "only@example.com" });
  });

  it("drops an email Starbase would refuse, and then may have nothing to send", () => {
    expect(sb.toStarbasePerson({ name: "Pat", email: "not-an-email" })).toBeNull();
    expect(sb.toStarbasePerson({ name: "Pat", email: "not-an-email", phone: "604 555 0100" })).toEqual({ name: "Pat", phone: "604 555 0100" });
    expect(sb.toStarbasePerson({ email: `${"a".repeat(320)}@example.com` })).toBeNull();
  });

  it("sends newsletter only with an email, and volunteer only when true", () => {
    expect(sb.toStarbasePerson({ name: "Pat", phone: "604 555 0100", newsletter: true })).toEqual({ name: "Pat", phone: "604 555 0100" });
    expect(sb.toStarbasePerson({ email: "a@b.ca", volunteer: true })).toEqual({ email: "a@b.ca", volunteer: true });
  });

  it("turns any source into a lowercase word", () => {
    expect(sb.sourceWord("newsletter-Home Page!")).toBe("newsletter-home-page");
    expect(sb.sourceWord("petition:skytrain")).toBe("petition-skytrain");
    expect(sb.sourceWord("  ")).toBeUndefined();
  });
});

describe("what each form forwards", () => {
  it("a petition or pledge signature: tag, source and newsletter only on a recorded grant", () => {
    const base = { slug: "skytrain-south-surrey", title: "SkyTrain to South Surrey", firstName: "Raj", lastName: "P", email: "raj@example.com", postalCode: "V4A 1A1", phone: null, address: null };
    expect(sb.signaturePerson({ ...base, kind: "petition", newsletter: true })).toEqual({
      first_name: "Raj",
      last_name: "P",
      email: "raj@example.com",
      postal: "V4A 1A1",
      tags: ["Petition: SkyTrain to South Surrey"],
      newsletter: true,
      source: "petition-skytrain-south-surrey",
    });
    const pledge = sb.signaturePerson({ ...base, kind: "pledge", newsletter: false })!;
    expect(pledge.tags).toEqual(["Pledge: SkyTrain to South Surrey"]);
    expect(pledge.newsletter).toBeUndefined();
  });

  it("a newsletter sign-up", () => {
    expect(sb.newsletterPerson({ email: "News@Example.com", source: "home" })).toEqual({ email: "news@example.com", newsletter: true, source: "newsletter-home" });
  });

  it("a volunteer shift: volunteer, the shift in the note, and the updates tick", () => {
    const p = sb.shiftPerson({
      name: "Harjit Gill",
      email: "harjit@example.com",
      phone: "604-555-0199",
      postalCode: "V3W 2A1",
      opening: { title: "Door-knocking in Newton", date: "2026-11-07", slot: "morning", location: "Newton Library" },
      newsletter: false,
    })!;
    expect(p).toEqual({
      name: "Harjit Gill",
      email: "harjit@example.com",
      phone: "604-555-0199",
      postal: "V3W 2A1",
      volunteer: true,
      note: "Signed up for Door-knocking in Newton, Saturday, November 7, 9 a.m.–12 p.m. at Newton Library",
      source: "volunteer-shift",
    });
    expect(sb.shiftNote({ title: "Phones", date: "2026-11-08", slot: "evening", location: "" })).toBe("Signed up for Phones, Sunday, November 8, 5–8 p.m.");
  });

  it("a membership carries no fee or money of any kind", () => {
    const membershipRow = {
      memberName: "Asha Example",
      email: "asha@example.org",
      memberPhone: "604-555-0100",
      memberAddress: "13450 104 Ave",
      memberCity: "Surrey",
      memberPostalCode: "V3T 1V8",
      interestVolunteer: true,
      interestLawnSign: true,
      updatesConsent: true,
      // What a membership row also has: none of it may leak.
      feeCents: 1000,
      votingEligible: true,
      stripeCheckoutSessionId: "cs_test_1",
      status: "active",
    };
    const p = sb.membershipPerson(membershipRow)!;
    expect(p).toEqual({
      name: "Asha Example",
      email: "asha@example.org",
      phone: "604-555-0100",
      address: "13450 104 Ave",
      city: "Surrey",
      postal: "V3T 1V8",
      tags: ["Member (joined online)"],
      newsletter: true,
      volunteer: true,
      note: "Wants to volunteer. Asked for a lawn sign",
      source: "membership",
    });
    const json = JSON.stringify(p);
    expect(json).not.toMatch(/fee|cents|amount|\$|1000|stripe|cs_test/i);
    expect(keysOf(p).every((k) => ALLOWED.has(k))).toBe(true);
    const signOnly = sb.membershipPerson({ ...membershipRow, interestVolunteer: false, updatesConsent: false })!;
    expect(signOnly.note).toBe("Asked for a lawn sign");
    expect(signOnly.volunteer).toBeUndefined();
    expect(signOnly.newsletter).toBeUndefined();
    expect(sb.membershipPerson({ ...membershipRow, interestLawnSign: false })!.note).toBeUndefined();
  });

  it("a deletion request: the email and name, and a note for the desk", () => {
    expect(sb.deletionRequestPerson({ firstName: "Pat", lastName: "Lee", email: "pat@example.com", date: "November 6, 2026" })).toEqual({
      first_name: "Pat",
      last_name: "Lee",
      email: "pat@example.com",
      note: "Asked us to delete their data (supporter portal, November 6, 2026). Please action it in Starbase too.",
      source: "supporter-portal",
    });
  });
});

describe("stableJson", () => {
  it("serializes the same person the same way whatever order its keys come back in", () => {
    const a = { source: "x", email: "a@b.ca", tags: ["b", "a"], name: "N" };
    const b = { name: "N", tags: ["b", "a"], email: "a@b.ca", source: "x" };
    expect(sb.stableJson(a)).toBe(sb.stableJson(b));
    expect(sb.stableJson(a)).toBe('{"email":"a@b.ca","name":"N","source":"x","tags":["b","a"]}');
  });
});

describe("the Starbase URL", () => {
  it("must be https, except on this machine", () => {
    expect(sb.starbaseUrlProblem("https://starbase.imaginesurrey.ca")).toBeNull();
    expect(sb.starbaseUrlProblem("http://localhost:12111")).toBeNull();
    expect(sb.starbaseUrlProblem("http://starbase.imaginesurrey.ca")).toMatch(/https/);
    expect(sb.starbaseUrlProblem("starbase")).toMatch(/web address/);
    expect(sb.starbaseUrlProblem(undefined)).toMatch(/not set/);
  });
});

// ── Delivery ───────────────────────────────────────────────────────────────

const KEY = "sbk_TestKey0123456789abcdefghij";
const URL_ = "https://starbase.test";

type Call = { url: string; init: RequestInit };

function fakeFetch(answers: (() => Promise<Response>)[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = answers.shift();
    if (!next) throw new Error("unexpected call");
    return next();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const reply = (status: number, body: unknown) => () => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const never = (call: { init?: RequestInit }) => () =>
  new Promise<Response>((_, reject) => {
    const signal = call.init?.signal;
    signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
  });

function row(over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: over.id ?? crypto.randomUUID(),
    kind: "petition",
    endpoint: "/in/v1/people",
    personId: "11111111-1111-4111-8111-111111111111",
    payload: { email: "a@b.ca", source: "petition-x" },
    status: "pending",
    attempts: 0,
    lastError: null,
    lastAttemptAt: null,
    starbasePersonId: null,
    nextAttemptAt: new Date(0),
    createdAt: new Date(),
    sentAt: null,
    ...over,
  };
}

/** The outbox in memory: claim returns due pending rows oldest first, like the database's. */
function memoryStore(rows: OutboxRow[]) {
  const linked: Record<string, string> = {};
  const store: OutboxStore = {
    async claimNext({ ignoreBackoff, ids, exclude, excludeEndpoints }) {
      const due = rows
        .filter(
          (r) =>
            r.status === "pending" &&
            !exclude.includes(r.id) &&
            !excludeEndpoints.includes(r.endpoint) &&
            (!ids || ids.includes(r.id)) &&
            (ignoreBackoff || !r.nextAttemptAt || r.nextAttemptAt.getTime() <= Date.now()),
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      return due[0] ?? null;
    },
    async save(r, patch) {
      Object.assign(r, patch);
      if (patch.starbasePersonId && r.personId) linked[r.personId] = patch.starbasePersonId;
    },
  };
  return { store, linked };
}

const sender = (f: typeof fetch, timeoutMs = 50) => (payload: Record<string, unknown>, key: string, endpoint: string) => sb.sendToStarbase(endpoint, payload, key, { url: URL_, key: KEY, fetch: f, timeoutMs });

describe("sendPerson", () => {
  it("posts JSON with the Bearer key and the Idempotency-Key", async () => {
    const { fn, calls } = fakeFetch([reply(200, { ok: true, person_id: "sb-1" })]);
    const answer = await sb.sendPerson({ source: "x", email: "a@b.ca" }, "row-id-1", { url: URL_, key: KEY, fetch: fn });
    expect(answer).toEqual({ kind: "ok", personId: "sb-1", replayed: false });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(calls[0].url).toBe(`${URL_}/in/v1/people`);
    expect(calls[0].init.method).toBe("POST");
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["idempotency-key"]).toBe("row-id-1");
    expect(calls[0].init.body).toBe('{"email":"a@b.ca","source":"x"}');
  });

  it("never throws, and refuses to send the key over plain http", async () => {
    const { fn, calls } = fakeFetch([]);
    const answer = await sb.sendPerson({ email: "a@b.ca" }, "k", { url: "http://starbase.example", key: KEY, fetch: fn });
    expect(answer.kind).toBe("config");
    expect(calls).toHaveLength(0);
    const boom = vi.fn(() => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect((await sb.sendPerson({ email: "a@b.ca" }, "k", { url: URL_, key: KEY, fetch: boom })).kind).toBe("retry");
  });

  it("sorts answers: 2xx ok, 400/409/415 refused, 401 config, 429/5xx retry", () => {
    expect(sb.classifyAnswer(200, { ok: true, person_id: "p", replayed: true })).toEqual({ kind: "ok", personId: "p", replayed: true });
    expect(sb.classifyAnswer(200, { ok: true })).toMatchObject({ kind: "retry" });
    expect(sb.classifyAnswer(400, { error: "rating: unrecognized key" })).toEqual({ kind: "refused", status: 400, error: "rating: unrecognized key" });
    expect(sb.classifyAnswer(409, {})).toMatchObject({ kind: "refused", status: 409 });
    expect(sb.classifyAnswer(415, null)).toMatchObject({ kind: "refused", status: 415 });
    expect(sb.classifyAnswer(401, { error: "a valid key" })).toMatchObject({ kind: "config", status: 401 });
    expect(sb.classifyAnswer(429, {})).toMatchObject({ kind: "retry", status: 429 });
    expect(sb.classifyAnswer(503, {})).toMatchObject({ kind: "retry", status: 503 });
  });
});

describe("the delivery state machine", () => {
  const NOW = new Date("2026-11-06T18:00:00Z");

  it("backs off 1 min, 5 min, 30 min, 2 h, then 12 h", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(sb.backoffMs)).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 43_200_000, 43_200_000, 43_200_000]);
  });

  it("marks a row failed after 8 attempts", () => {
    const retry = { kind: "retry", status: 503, error: "down" } as const;
    let state = { attempts: 0 };
    const seen: string[] = [];
    for (let i = 0; i < 8; i++) {
      const patch = sb.afterAttempt(state, retry, NOW);
      seen.push(patch.status);
      state = patch;
    }
    expect(seen).toEqual(["pending", "pending", "pending", "pending", "pending", "pending", "pending", "failed"]);
    expect(state.attempts).toBe(sb.MAX_ATTEMPTS);
  });

  it("200 → sent, with Starbase's id on the row and on the person; the key is the row id", async () => {
    const r = row();
    const { store, linked } = memoryStore([r]);
    const { fn, calls } = fakeFetch([reply(200, { ok: true, person_id: "sb-42" })]);
    const report = await deliverWith(store, 5_000, { send: sender(fn), now: () => NOW });
    expect(report).toEqual({ sent: 1, failed: 0, retrying: 0, problem: null, unsupported: 0 });
    expect(r).toMatchObject({ status: "sent", attempts: 1, starbasePersonId: "sb-42", lastError: null, sentAt: NOW, nextAttemptAt: null });
    expect(linked[r.personId!]).toBe("sb-42");
    expect((calls[0].init.headers as Record<string, string>)["idempotency-key"]).toBe(r.id);
  });

  it("400 → failed for good, with Starbase's message, and the next row still goes", async () => {
    const bad = row({ createdAt: new Date(1) });
    const good = row({ createdAt: new Date(2) });
    const { store } = memoryStore([good, bad]);
    const { fn, calls } = fakeFetch([reply(400, { error: "tags.0: Too big" }), reply(200, { ok: true, person_id: "sb-2" })]);
    const report = await deliverWith(store, 5_000, { send: sender(fn), now: () => NOW });
    expect(report).toMatchObject({ sent: 1, failed: 1 });
    expect(bad).toMatchObject({ status: "failed", attempts: 1, lastError: "400: tags.0: Too big", nextAttemptAt: null });
    expect(good.status).toBe("sent");
    // Oldest first.
    expect((calls[0].init.headers as Record<string, string>)["idempotency-key"]).toBe(bad.id);
  });

  it("401 → stays pending and due, no attempt counted, and the run stops", async () => {
    const a = row({ createdAt: new Date(1) });
    const b = row({ createdAt: new Date(2) });
    const { store } = memoryStore([a, b]);
    const { fn, calls } = fakeFetch([reply(401, { error: "a valid key goes in the Authorization header: Bearer sbk_…" })]);
    const report = await deliverWith(store, 5_000, { send: sender(fn), now: () => NOW });
    expect(calls).toHaveLength(1);
    expect(a).toMatchObject({ status: "pending", attempts: 0, nextAttemptAt: NOW });
    expect(a.lastError).toMatch(/^401: a valid key/);
    expect(b).toMatchObject({ status: "pending", attempts: 0, lastError: null });
    expect(report.problem).toMatch(/^401/);
  });

  it("429 and 500 → pending with backoff, attempt counted, run stopped", async () => {
    for (const status of [429, 500]) {
      const a = row({ attempts: 2, createdAt: new Date(1) });
      const b = row({ createdAt: new Date(2) });
      const { store } = memoryStore([a, b]);
      const { fn, calls } = fakeFetch([reply(status, { error: "busy" })]);
      const report = await deliverWith(store, 5_000, { send: sender(fn), now: () => NOW });
      expect(calls).toHaveLength(1);
      expect(a).toMatchObject({ status: "pending", attempts: 3, lastError: `${status}: busy` });
      expect(a.nextAttemptAt!.getTime() - NOW.getTime()).toBe(30 * 60_000);
      expect(b.attempts).toBe(0);
      expect(report).toMatchObject({ retrying: 1, sent: 0 });
    }
  });

  it("a timeout counts as a failed attempt and backs off", async () => {
    const a = row();
    const { store } = memoryStore([a]);
    const calls: { init?: RequestInit }[] = [];
    const slow = vi.fn((_url: string, init?: RequestInit) => {
      const c = { init };
      calls.push(c);
      return never(c)();
    }) as unknown as typeof fetch;
    const report = await deliverWith(store, 5_000, { send: sender(slow, 30), now: () => NOW });
    expect(report.retrying).toBe(1);
    expect(a).toMatchObject({ status: "pending", attempts: 1 });
    expect(a.lastError).toMatch(/No answer within/);
    expect(a.nextAttemptAt!.getTime() - NOW.getTime()).toBe(60_000);
  });

  it("the 8th failed attempt marks the row failed", async () => {
    const a = row({ attempts: 7 });
    const { store } = memoryStore([a]);
    const { fn } = fakeFetch([reply(503, {})]);
    await deliverWith(store, 5_000, { send: sender(fn), now: () => NOW });
    expect(a).toMatchObject({ status: "failed", attempts: 8, nextAttemptAt: null });
    expect(a.lastError).toMatch(/gave up after 8 attempts/);
  });

  it("leaves rows that aren't due, unless told to send now", async () => {
    const later = row({ nextAttemptAt: new Date(Date.now() + 60_000) });
    const { store } = memoryStore([later]);
    const { fn, calls } = fakeFetch([reply(200, { ok: true, person_id: "sb-9" })]);
    await deliverWith(store, 5_000, { send: sender(fn) });
    expect(calls).toHaveLength(0);
    await deliverWith(store, 5_000, { send: sender(fn), ignoreBackoff: true });
    expect(later.status).toBe("sent");
  });

  it("never throws, even when the store does", async () => {
    const broken: OutboxStore = {
      claimNext: async () => {
        throw new Error("database is down");
      },
      save: async () => {},
    };
    await expect(deliverWith(broken, 1_000)).resolves.toMatchObject({ sent: 0, problem: "database is down" });
    const r = row();
    const { store } = memoryStore([r]);
    const throwingSend = async () => {
      throw new Error("kaboom");
    };
    await expect(deliverWith(store, 1_000, { send: throwingSend })).resolves.toMatchObject({ retrying: 1 });
    expect(r.lastError).toMatch(/kaboom/);
  });

  it("retries send the same body for the same row", async () => {
    const r = row({ payload: { source: "petition-x", email: "a@b.ca", tags: ["Petition: X"] } });
    const { store } = memoryStore([r]);
    const { fn, calls } = fakeFetch([reply(503, {}), reply(200, { ok: true, person_id: "sb-3", replayed: false })]);
    await deliverWith(store, 5_000, { send: sender(fn) });
    // Read back from jsonb with its keys in another order.
    r.payload = { tags: ["Petition: X"], email: "a@b.ca", source: "petition-x" };
    await deliverWith(store, 5_000, { send: sender(fn), ignoreBackoff: true });
    expect(calls).toHaveLength(2);
    expect(calls[0].init.body).toBe(calls[1].init.body);
    expect((calls[0].init.headers as Record<string, string>)["idempotency-key"]).toBe((calls[1].init.headers as Record<string, string>)["idempotency-key"]);
    expect(r.status).toBe("sent");
  });
});

// ── Engagement tags, portal edits and consent ─────────────────────────────

describe("engagement tags: a tag on the person, never money", () => {
  it("an RSVP: the event in the tag, source rsvp", () => {
    expect(sb.rsvpPerson({ name: "Rae Rsvp", email: "Rae@Example.com", eventTitle: "Newton town hall" })).toEqual({
      name: "Rae Rsvp",
      email: "rae@example.com",
      tags: ["RSVP: Newton town hall"],
      source: "rsvp",
    });
    // A long title is cut to Starbase's 40 characters.
    expect(sb.rsvpPerson({ email: "a@b.ca", eventTitle: "A very long event title that goes on and on" })!.tags![0].length).toBeLessThanOrEqual(40);
  });

  it("a paid order: Bought merch, source shop, and nothing about the order", () => {
    const withExtras = { firstName: "Bea", lastName: "Buyer", email: "bea@example.com", totalCents: 4500, items: [{ slug: "tee" }], stripePaymentIntentId: "pi_1", shipping: { line1: "1 Main" } } as Parameters<typeof sb.orderPerson>[0];
    const p = sb.orderPerson(withExtras)!;
    expect(p).toEqual({ first_name: "Bea", last_name: "Buyer", email: "bea@example.com", tags: ["Bought merch"], source: "shop" });
    expect(JSON.stringify(p)).not.toMatch(/4500|cents|tee|pi_|Main/);
  });

  it("a confirmed follow: Follows: promise <n>, source tracker", () => {
    expect(sb.followPerson({ email: "f@example.com", number: 12 })).toEqual({ email: "f@example.com", tags: ["Follows: promise 12"], source: "tracker" });
  });

  it("a portal edit: the person's own details, source portal", () => {
    expect(sb.portalPerson({ firstName: "Pat", lastName: "Lee", email: "pat@example.com", phone: "604-555-0100", address: "13450 104 Ave", postalCode: "v3t 1v8" })).toEqual({
      first_name: "Pat",
      last_name: "Lee",
      email: "pat@example.com",
      phone: "604-555-0100",
      address: "13450 104 Ave",
      postal: "V3T 1V8",
      source: "portal",
    });
    expect(sb.portalPerson({ email: "pat@example.com", phone: null, address: "" })).toEqual({ email: "pat@example.com", source: "portal" });
  });
});

describe("consent withdrawals for /in/v1/consent", () => {
  const AT = new Date("2026-11-07T18:30:00Z");

  it("builds { email?, phone?, channel, action: withdraw, reason, at }", () => {
    expect(sb.consentPayload({ email: " Pat@Example.com ", channel: "email", reason: "unsubscribe", at: AT })).toEqual({
      email: "pat@example.com",
      channel: "email",
      action: "withdraw",
      reason: "unsubscribe",
      at: "2026-11-07T18:30:00.000Z",
    });
    expect(sb.consentPayload({ phone: "+16045550101", channel: "sms", reason: "stop", at: AT })).toEqual({ phone: "+16045550101", channel: "sms", action: "withdraw", reason: "stop", at: "2026-11-07T18:30:00.000Z" });
  });

  it("needs an email or a phone, and a known channel, reason and action", () => {
    expect(sb.consentPayload({ channel: "email", reason: "preference" })).toBeNull();
    expect(sb.consentPayload({ email: "not-an-email", channel: "email", reason: "preference" })).toBeNull();
    expect(sb.cleanConsentPayload({ email: "a@b.ca", channel: "fax", action: "withdraw", reason: "stop", at: AT.toISOString() })).toBeNull();
    expect(sb.cleanConsentPayload({ email: "a@b.ca", channel: "sms", action: "withdraw", reason: "because", at: AT.toISOString() })).toBeNull();
    // Only withdrawals are ever sent.
    expect(sb.cleanConsentPayload({ email: "a@b.ca", channel: "email", action: "grant", reason: "preference", at: AT.toISOString() })).toBeNull();
    // Anything else is dropped.
    expect(sb.cleanConsentPayload({ email: "a@b.ca", channel: "email", action: "withdraw", reason: "deletion", at: AT.toISOString(), note: "x", amount: 5 })).toEqual({
      email: "a@b.ca",
      channel: "email",
      action: "withdraw",
      reason: "deletion",
      at: AT.toISOString(),
    });
  });

  it("posts to /in/v1/consent with the Bearer key and the row id as Idempotency-Key", async () => {
    const { fn, calls } = fakeFetch([reply(200, { ok: true })]);
    const payload = sb.consentPayload({ email: "a@b.ca", channel: "email", reason: "unsubscribe", at: AT })!;
    const answer = await sb.sendToStarbase(sb.CONSENT_ENDPOINT, payload, "row-7", { url: URL_, key: KEY, fetch: fn });
    expect(answer).toEqual({ kind: "ok", personId: null, replayed: false });
    expect(calls[0].url).toBe(`${URL_}/in/v1/consent`);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(headers["idempotency-key"]).toBe("row-7");
    expect(calls[0].init.body).toBe('{"action":"withdraw","at":"2026-11-07T18:30:00.000Z","channel":"email","email":"a@b.ca","reason":"unsubscribe"}');
    // Nowhere else.
    expect((await sb.sendToStarbase("/in/v1/gifts", payload, "k", { url: URL_, key: KEY, fetch: fn })).kind).toBe("refused");
  });

  it("a 404 from /in/v1/consent is 'not supported yet'; from /in/v1/people it is still a wrong address", () => {
    const consent404 = sb.classifyAnswer(404, { error: "not found" }, sb.CONSENT_ENDPOINT);
    expect(consent404.kind).toBe("unsupported");
    expect((consent404 as { error: string }).error.startsWith(sb.NOT_SUPPORTED_YET)).toBe(true);
    expect(sb.classifyAnswer(404, {}, sb.PEOPLE_ENDPOINT).kind).toBe("config");
    expect(sb.classifyAnswer(401, {}, sb.CONSENT_ENDPOINT).kind).toBe("config");
    expect(sb.classifyAnswer(200, { ok: true }, sb.PEOPLE_ENDPOINT).kind).toBe("retry");
    expect(sb.classifyAnswer(200, { ok: false }, sb.CONSENT_ENDPOINT).kind).toBe("retry");
  });

  it("'not supported yet' keeps the row pending without using a try, waits 6 hours, and never stops the run", () => {
    const NOW = new Date("2026-11-07T00:00:00Z");
    const answer = sb.classifyAnswer(404, {}, sb.CONSENT_ENDPOINT);
    const patch = sb.afterAttempt({ attempts: 3 }, answer, NOW);
    expect(patch).toMatchObject({ status: "pending", attempts: 3, nextAttemptAt: new Date(NOW.getTime() + 6 * 3_600_000) });
    expect(patch.lastError!.startsWith(sb.NOT_SUPPORTED_YET)).toBe(true);
    expect(sb.stopsRun(answer)).toBe(false);
    // However many times: it is never failed for it.
    let state = { attempts: 0 };
    for (let i = 0; i < 20; i++) state = sb.afterAttempt(state, answer, NOW);
    expect(state).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("delivery: consent rows wait when Starbase has no endpoint, and the sign-ups behind them still go", async () => {
    const consentPayload = sb.consentPayload({ email: "u@b.ca", channel: "email", reason: "unsubscribe" })! as Record<string, unknown>;
    const c1 = row({ kind: "consent", endpoint: sb.CONSENT_ENDPOINT, payload: consentPayload, createdAt: new Date(1) });
    const c2 = row({ kind: "consent", endpoint: sb.CONSENT_ENDPOINT, payload: consentPayload, createdAt: new Date(2) });
    const person = row({ createdAt: new Date(3) });
    const { store } = memoryStore([c1, c2, person]);
    const { fn, calls } = fakeFetch([reply(404, { error: "not found" }), reply(200, { ok: true, person_id: "sb-5" })]);
    const report = await deliverWith(store, 5_000, { send: sender(fn) });
    // One call learns the endpoint isn't there; the second consent row isn't tried in this run.
    expect(calls.map((c) => new globalThis.URL(c.url).pathname)).toEqual(["/in/v1/consent", "/in/v1/people"]);
    expect(report).toMatchObject({ sent: 1, unsupported: 1, problem: null, failed: 0 });
    expect(c1).toMatchObject({ status: "pending", attempts: 0 });
    expect(c2).toMatchObject({ status: "pending", attempts: 0, lastError: null });
    expect(person.status).toBe("sent");

    // Once Starbase has it, "Send now" sends them all.
    const later = fakeFetch([reply(200, { ok: true }), reply(200, { ok: true, replayed: false })]);
    const again = await deliverWith(store, 5_000, { send: sender(later.fn), ignoreBackoff: true });
    expect(again).toMatchObject({ sent: 2, unsupported: 0 });
    expect(c1).toMatchObject({ status: "sent", starbasePersonId: null });
    expect(c2.status).toBe("sent");
  });

  it("a deletion's address and number are removed from the row once Starbase has it", () => {
    const deletion = { endpoint: sb.CONSENT_ENDPOINT, payload: { email: "gone@example.com", phone: "+16045550100", channel: "sms", action: "withdraw", reason: "deletion", at: "x" } };
    expect(scrubbedOnceSent(deletion)).toEqual({ payload: { email: "(removed after sending)", phone: "(removed after sending)", channel: "sms", action: "withdraw", reason: "deletion", at: "x" } });
    expect(scrubbedOnceSent({ ...deletion, payload: { ...deletion.payload, reason: "stop" } })).toBeNull();
    expect(scrubbedOnceSent({ endpoint: sb.PEOPLE_ENDPOINT, payload: { email: "a@b.ca", reason: "deletion" } })).toBeNull();
  });
});
