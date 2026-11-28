// The website's older names still work: its settings under their older
// names (as the live website's host still has them), a replay of an
// unsubscribe whose first answer was stored under the older label, the old
// admin address, and older words kept in rows, shown as base.win. The older
// names are read from the website's own table (src/lib/old-names.ts), never
// typed here, so this file is the only test that needs them.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/pg-proxy";
import { getTableColumns, getTableName } from "drizzle-orm";

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: () => {} }));

// The fake database the consent route is given (see fakeDb below).
let routeDb: unknown = null;
vi.mock("@/lib/db", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/db")>()), getDb: () => routeDb }));

const names = await import("@/lib/old-names");
const { OLD_ENV, DB, OLD_INBOUND_ENTITY, OLD_LEDGER_SOURCE, OLD_AUDIT_ACTIONS, OLD_ADMIN_PATH } = names;
const { env } = await import("@/lib/env");
const schema = await import("@/lib/db/schema");
const inbound = await import("@/lib/server/desk-inbound");
const desk = await import("@/lib/server/desk");
const words = await import("@/lib/desk-words");
const { POST } = await import("@/app/api/in/consent/route");
const nextConfig = (await import("../next.config")).default;

const ROOT = path.resolve(import.meta.dirname, "..");
const SETTINGS = ["BASE_WIN_URL", "BASE_WIN_KEY", "BASE_WIN_INBOUND_KEY"] as const;
const saved: Record<string, string | undefined> = {};
const clearSettings = () => {
  for (const k of [...SETTINGS, ...SETTINGS.map((s) => OLD_ENV[s])]) delete process.env[k];
};
beforeEach(() => {
  for (const k of [...SETTINGS, ...SETTINGS.map((s) => OLD_ENV[s])]) saved[k] = process.env[k];
  clearSettings();
});
afterEach(() => {
  clearSettings();
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
});

describe("the table", () => {
  it("names each setting's older name, never one of the new ones", () => {
    expect(Object.keys(OLD_ENV).sort()).toEqual([...SETTINGS].sort());
    for (const s of SETTINGS) expect(OLD_ENV[s]).not.toBe(s);
    expect(new Set(Object.values(OLD_ENV)).size).toBe(3);
  });

  it("keeps the database's names exactly as they are (no migration)", () => {
    expect(getTableName(schema.deskOutbox)).toBe(DB.outbox);
    expect(schema.deskOutboxStatus.enumName).toBe(DB.outboxStatus);
    expect(getTableColumns(schema.deskOutbox).deskPersonId.name).toBe(DB.personId);
    expect(getTableColumns(schema.people).deskPersonId.name).toBe(DB.personId);
    const snapshot = readFileSync(path.join(ROOT, "drizzle/meta/0007_snapshot.json"), "utf8");
    for (const name of [DB.outbox, DB.outboxStatus, DB.personId, ...Object.values(DB.outboxIdx)]) expect(snapshot).toContain(`"${name}"`);
  });
});

describe("the settings: the new name first, then the older one", () => {
  const URL_NEW = "https://new.example.base.win";
  const URL_OLD = "https://old.example.org";

  it("reads only the older names", () => {
    process.env[OLD_ENV.BASE_WIN_URL] = `${URL_OLD}/`;
    process.env[OLD_ENV.BASE_WIN_KEY] = " sbk_old0123456789abcdefghij ";
    process.env[OLD_ENV.BASE_WIN_INBOUND_KEY] = "inbound-old";
    expect([env.deskUrl, env.deskKey, env.deskInboundKey, env.deskEnabled]).toEqual([URL_OLD, "sbk_old0123456789abcdefghij", "inbound-old", true]);
  });

  it("reads only the new names", () => {
    process.env.BASE_WIN_URL = URL_NEW;
    process.env.BASE_WIN_KEY = "sbk_new0123456789abcdefghij";
    process.env.BASE_WIN_INBOUND_KEY = "inbound-new";
    expect([env.deskUrl, env.deskKey, env.deskInboundKey, env.deskEnabled]).toEqual([URL_NEW, "sbk_new0123456789abcdefghij", "inbound-new", true]);
  });

  it("takes the new name when both are set", () => {
    for (const s of SETTINGS) process.env[OLD_ENV[s]] = "older";
    process.env.BASE_WIN_URL = URL_NEW;
    process.env.BASE_WIN_KEY = "sbk_new0123456789abcdefghij";
    process.env.BASE_WIN_INBOUND_KEY = "inbound-new";
    expect([env.deskUrl, env.deskKey, env.deskInboundKey]).toEqual([URL_NEW, "sbk_new0123456789abcdefghij", "inbound-new"]);
  });

  it("counts a blank new name as not set", () => {
    process.env[OLD_ENV.BASE_WIN_URL] = URL_OLD;
    process.env[OLD_ENV.BASE_WIN_KEY] = "sbk_old0123456789abcdefghij";
    process.env[OLD_ENV.BASE_WIN_INBOUND_KEY] = "inbound-old";
    for (const s of SETTINGS) process.env[s] = "   ";
    expect([env.deskUrl, env.deskKey, env.deskInboundKey]).toEqual([URL_OLD, "sbk_old0123456789abcdefghij", "inbound-old"]);
  });

  it("lists, by new name only, the settings still read from their older names", () => {
    process.env[OLD_ENV.BASE_WIN_URL] = URL_OLD;
    process.env.BASE_WIN_KEY = "sbk_new0123456789abcdefghij";
    process.env[OLD_ENV.BASE_WIN_KEY] = "sbk_old0123456789abcdefghij";
    process.env.BASE_WIN_INBOUND_KEY = " ";
    process.env[OLD_ENV.BASE_WIN_INBOUND_KEY] = "inbound-old";
    expect(env.deskOlderNames).toEqual(["BASE_WIN_URL", "BASE_WIN_INBOUND_KEY"]);
    clearSettings();
    expect(env.deskOlderNames).toEqual([]);
  });

  it("is off with neither", () => {
    expect([env.deskUrl, env.deskKey, env.deskInboundKey, env.deskEnabled]).toEqual([undefined, undefined, undefined, false]);
  });
});

// ── A fake database: drizzle's own query builder, answered from two lists ──
// An insert's columns, each with its value ("default" for one not given).
const inserted = (q: string, params: unknown[]) => {
  const m = /\(([^)]*)\)\s+values\s*\(([^)]*)\)/.exec(q);
  const cols = m?.[1].split(",").map((c) => c.trim().replaceAll('"', "")) ?? [];
  const vals = m?.[2].split(",").map((v) => v.trim()) ?? [];
  return Object.fromEntries(cols.map((c, i) => [c, /^\$\d+$/.test(vals[i]) ? params[Number(vals[i].slice(1)) - 1] : vals[i]]));
};
type AuditRow = { action: string; entity: string; entity_id: string; details: unknown };
function fakeDb(audit: AuditRow[]) {
  const ledger: { source: unknown; wording: unknown }[] = [];
  const written: AuditRow[] = [];
  const locks: unknown[] = [];
  const db = drizzle(
    async (query, params, method) => {
      const q = query.toLowerCase();
      if (q.includes("pg_advisory_xact_lock")) {
        locks.push(...params);
        return { rows: [] };
      }
      if (q.startsWith("select") && q.includes('from "audit_log"')) {
        // Whatever the where clause, a row matches only when its entity and its key are both among the values asked for.
        const found = audit.filter((r) => params.includes(r.entity) && params.includes(r.entity_id));
        return { rows: method === "all" ? found.map((r) => [r.details]) : found };
      }
      if (q.startsWith("select") && q.includes('from "people"')) return { rows: [] };
      if (q.startsWith("insert into \"consent_events\"")) {
        const row = inserted(q, params);
        ledger.push({ source: row.source, wording: row.wording });
        return { rows: [] };
      }
      if (q.startsWith("insert into \"audit_log\"")) {
        const row = inserted(q, params);
        written.push({ action: String(row.action), entity: String(row.entity), entity_id: String(row.entity_id), details: row.details });
        return { rows: [] };
      }
      return { rows: [] };
    },
    { schema },
  );
  // The proxy driver has no transactions; one connection is all this needs.
  const withTx = Object.assign(Object.create(db), { transaction: (fn: (tx: unknown) => unknown) => fn(db) });
  return { db: withTx as import("@/lib/db").Db, ledger, written, locks };
}

const AT = "2026-11-07T10:30:00-08:00";
const body = (email: string, action: "withdraw" | "grant" = "withdraw") => JSON.stringify({ action, at: AT, channel: "email", email, reason: "unsubscribe" });
const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
const parse = (raw: string) => {
  const r = inbound.inboundConsentSchema.safeParse(JSON.parse(raw));
  if (!r.success) throw new Error("bad body");
  return r.data;
};

describe("an unsubscribe from base.win: a replay stored under the older label", () => {
  const raw = body("pat@example.org");
  const stored = (): AuditRow[] => [{ action: OLD_AUDIT_ACTIONS[0], entity: OLD_INBOUND_ENTITY, entity_id: "key-1", details: { hash: hash(raw), answer: { ok: true, applied: 1 } } }];

  it("gives the first answer again, with replayed, and adds nothing", async () => {
    const f = fakeDb(stored());
    expect(await inbound.applyInboundConsent(f.db, parse(raw), "key-1", raw)).toEqual({ status: 200, body: { ok: true, applied: 1, replayed: true } });
    expect([f.ledger.length, f.written.length]).toEqual([0, 0]);
  });

  it("refuses the same key with a different body (409)", async () => {
    const f = fakeDb(stored());
    const other = body("someone-else@example.org");
    expect(await inbound.applyInboundConsent(f.db, parse(other), "key-1", other)).toEqual({ status: 409, body: { error: "that Idempotency-Key was used with a different body" } });
    expect([f.ledger.length, f.written.length]).toEqual([0, 0]);
  });

  it("holds the same lock as the older code, so an old and a new deploy never apply one key at once", async () => {
    const f = fakeDb([]);
    await inbound.applyInboundConsent(f.db, parse(raw), "key-2", raw);
    expect(f.locks).toEqual([`${OLD_INBOUND_ENTITY}:key-2`]);
  });

  it("writes a new one under the new labels", async () => {
    const f = fakeDb([]);
    expect(await inbound.applyInboundConsent(f.db, parse(raw), "key-3", raw)).toEqual({ status: 200, body: { ok: true, applied: 0 } });
    expect(f.written.map((r) => [r.action, r.entity, r.entity_id])).toEqual([["consent.desk-withdraw", inbound.INBOUND_ENTITY, "key-3"]]);
    expect(inbound.INBOUND_ENTITY).toBe("desk-consent");
    expect(f.ledger.map((r) => r.source)).toEqual(["base.win"]);
    expect(String(f.ledger[0].wording)).toMatch(/^Withdrawn in base\.win \(unsubscribe\)/);
    const grant = body("pat@example.org", "grant");
    const g = fakeDb([]);
    expect((await inbound.applyInboundConsent(g.db, parse(grant), "key-4", grant)).body).toEqual({ ok: true, applied: 0, note: "Grants are not applied from base.win; only withdrawals are." });
    expect(g.written.map((r) => r.action)).toEqual(["consent.desk-grant-ignored"]);
  });
});

describe("the consent route: its key under either name", () => {
  const post = (key: string | null, raw: string, idem = "route-1") =>
    POST(
      new Request("http://localhost/api/in/consent", {
        method: "POST",
        headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json", "idempotency-key": idem, "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250)}` },
        body: raw,
      }) as never,
    );

  it("accepts a good key with only the older name set", async () => {
    process.env[OLD_ENV.BASE_WIN_INBOUND_KEY] = "inbound-old-0123456789";
    routeDb = fakeDb([]).db;
    const r = await post("inbound-old-0123456789", body("a@example.org"));
    expect([r.status, await r.json()]).toEqual([200, { ok: true, applied: 0 }]);
    expect((await post("not-it", body("a@example.org"), "route-2")).status).toBe(401);
  });

  it("accepts a good key with only the new name set", async () => {
    process.env.BASE_WIN_INBOUND_KEY = "inbound-new-0123456789";
    routeDb = fakeDb([]).db;
    const r = await post("inbound-new-0123456789", body("b@example.org"));
    expect([r.status, await r.json()]).toEqual([200, { ok: true, applied: 0 }]);
  });

  it("is off with neither (503), naming the new setting", async () => {
    routeDb = fakeDb([]).db;
    const r = await post("anything", body("c@example.org"));
    expect([r.status, (await r.json()).error]).toEqual([503, "Inbound consent is off: BASE_WIN_INBOUND_KEY isn't set on the website."]);
  });
});

describe("the sender: only the older names set", () => {
  it("calls <url>/in/v1/... with the website key", async () => {
    process.env[OLD_ENV.BASE_WIN_URL] = "https://desk.example.org/";
    process.env[OLD_ENV.BASE_WIN_KEY] = "sbk_e2eTestKey0123456789abcdefABCDEF";
    const calls: { url: string; auth: string | null }[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify(String(url).endsWith("/ping") ? { ok: true, campaign: "Example", key: "Website" } : { ok: true, person_id: "p1" }), { status: 200 });
    }) as typeof fetch;
    expect(await desk.ping({ fetch: fake })).toEqual({ ok: true, campaign: "Example", key: "Website" });
    expect((await desk.sendPerson({ email: "pat@example.org" }, "idem-1", { fetch: fake })).kind).toBe("ok");
    expect(calls).toEqual([
      { url: "https://desk.example.org/in/v1/ping", auth: "Bearer sbk_e2eTestKey0123456789abcdefABCDEF" },
      { url: "https://desk.example.org/in/v1/people", auth: "Bearer sbk_e2eTestKey0123456789abcdefABCDEF" },
    ]);
  });
});

describe("older values kept in rows, shown as base.win", () => {
  it("the ledger's source", () => {
    expect(words.ledgerSourceLabel(OLD_LEDGER_SOURCE)).toBe("base.win");
    expect(words.ledgerSourceLabel("base.win")).toBe("base.win");
    expect(words.ledgerSourceLabel("preferences")).toBe("preferences");
    expect(words.LEDGER_SOURCES).toEqual(["base.win", OLD_LEDGER_SOURCE]);
  });

  it("the audit log's actions: old and new read the same, and a filter finds both", () => {
    for (const old of OLD_AUDIT_ACTIONS) {
      const now = words.newAuditAction(old);
      expect(now).not.toBe(old);
      expect(now).toMatch(/^(consent|integrations)\.desk-/);
      expect(words.auditActionLabel(old)).toBe(words.auditActionLabel(now));
      expect(words.auditActionLabel(now)).toMatch(/base\.win/);
      expect(words.sameAuditActions(now).sort()).toEqual([now, old].sort());
      expect(words.sameAuditActions(old).sort()).toEqual([now, old].sort());
    }
    expect(words.auditActionLabel("person.update")).toBe("person.update");
    expect(words.sameAuditActions("person.update")).toEqual(["person.update"]);
    expect(words.auditEntityLabel(OLD_INBOUND_ENTITY)).toBe("desk-consent");
    expect(words.sameAuditEntities("desk-consent").sort()).toEqual(["desk-consent", OLD_INBOUND_ENTITY].sort());
  });

  it("an outbox row's last error, or a ledger row's wording", () => {
    const capital = OLD_LEDGER_SOURCE[0].toUpperCase() + OLD_LEDGER_SOURCE.slice(1);
    const old = `${capital} isn't connected (${OLD_ENV.BASE_WIN_URL} and ${OLD_ENV.BASE_WIN_KEY}), so this wasn't sent.`;
    expect(words.deskWords(old)).toBe("base.win isn't connected (BASE_WIN_URL and BASE_WIN_KEY), so this wasn't sent.");
    expect(words.deskWords(`Withdrawn in ${capital} (stop) at ${AT}`)).toBe(`Withdrawn in base.win (stop) at ${AT}`);
    expect(words.deskWords(null)).toBe(null);
    expect(words.deskWords("400: simulated 400")).toBe("400: simulated 400");
  });
});

describe("the old admin address", () => {
  it("redirects for good (308) to /admin/integrations/desk", async () => {
    const all = await nextConfig.redirects!();
    expect(OLD_ADMIN_PATH).not.toBe("/admin/integrations/desk");
    expect(all).toContainEqual({ source: OLD_ADMIN_PATH, destination: "/admin/integrations/desk", permanent: true });
    expect(all).toContainEqual({ source: `${OLD_ADMIN_PATH}/:path*`, destination: "/admin/integrations/desk/:path*", permanent: true });
  });
});

describe("nothing else in the website copy says the older word", () => {
  it("only its table, the frozen migrations and this file", () => {
    const allowed = new Set([
      "src/lib/old-names.ts",
      "drizzle/0006_starbase_desk.sql",
      "drizzle/0007_memo_build.sql",
      "drizzle/meta/_journal.json",
      "drizzle/meta/0006_snapshot.json",
      "drizzle/meta/0007_snapshot.json",
    ]);
    const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "."], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
    expect(files.length).toBeGreaterThan(100);
    const word = new RegExp(OLD_LEDGER_SOURCE, "i");
    const found: string[] = [];
    for (const f of files) {
      if (allowed.has(f) || /old-names/.test(path.basename(f))) continue;
      if (word.test(f)) found.push(`${f} (its name)`);
      let text: string;
      try {
        text = readFileSync(path.join(ROOT, f), "utf8");
      } catch {
        continue;
      }
      text.split("\n").forEach((line, i) => {
        if (word.test(line)) found.push(`${f}:${i + 1}`);
      });
    }
    expect(found).toEqual([]);
  });
});
