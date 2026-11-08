// Linking a Base Ground login to a staff account (SUITE.md, "The hand-off",
// step 6), against a real database when TEST_DATABASE_URL names one ending in
// _test or _e2e. The whole callback runs: a fake Base Ground answers the
// token call, and the app's own lookups, links and audit entries are real.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "@/lib/db/schema";

const sent = vi.hoisted(() => [] as { to: string; subject: string; text: string; kind: string }[]);
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/settings", async () => {
  const { defaultSettings } = await import("@/lib/settings");
  return { getSettings: async () => defaultSettings() };
});
vi.mock("@/lib/server/email", () => ({
  sendEmail: async (_db: unknown, message: { to: string; subject: string; text: string; kind: string }) => {
    sent.push(message);
    return { status: "sent" };
  },
}));

const url = process.env.TEST_DATABASE_URL;
const usable = Boolean(url && /(_e2e|_test)$/.test(new URL(url).pathname));

describe.skipIf(!usable)("linking a Base Ground login (database)", async () => {
  vi.stubEnv("ADMIN_SESSION_SECRET", "test-session-secret-0123456789abcdef");
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  const sso = await import("@/lib/server/base-sso");
  const link = await import("@/lib/server/base-link");
  const { hashPassword, loginWithBase, LOCK_ATTEMPTS } = await import("@/lib/server/admin-auth");
  const { audit } = await import("@/lib/server/audit");

  const client = usable ? postgres(url!, { max: 2, onnotice: () => {} }) : null;
  const db = client ? (drizzle(client, { schema }) as unknown as import("@/lib/db").Db) : null;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const PASSWORD = "correct horse battery staple";
  const email = (who: string) => `link-${who}-${stamp}@example.ca`;
  const accounts = { pat: email("pat"), sam: email("sam"), owner: email("owner"), nopw: email("nopw"), gone: email("gone"), lock: email("lock"), race: email("race") };
  const ids: Record<string, string> = {};
  const sub = (name: string) => `ground-${name}-${stamp}`;
  const config = { groundUrl: "https://imaginesurrey.base.win", secret: "shared-secret-for-web-0123456789", siteUrl: "https://imaginesurrey.ca", cookieSecret: "cookie-signing-secret-0123456789" };
  const meta = (ip: string) => ({ ip: `${ip}-${stamp}`, userAgent: "vitest" });

  /** One "Sign in with Base" round trip: Base Ground vouches for (email, sub). */
  async function handOff(groundEmail: string, groundSub: string, next = "/admin") {
    const start = sso.startHandOff(config, next);
    const fetchFn = (async () => Response.json({ sub: groundSub, email: groundEmail, name: "Someone", role: "manager", areas: [], organization: "Imagine Surrey", client: "imaginesurrey" })) as unknown as typeof fetch;
    return sso.finishHandOff(config, { code: "one-time-code", state: start.state }, start.cookie, {
      fetch: fetchFn,
      loginLinked: (l, n) => loginWithBase(l, meta("callback"), n, db!),
      findAccount: (e) => link.findAccountForLinking(db!, e),
      startLinking: (identity, user, n) => link.startLinking(db!, identity, user, n),
      audit: (user, action, details) => audit(user, action, details, undefined, undefined, db!),
    });
  }

  async function startedLink(groundEmail: string, groundSub: string, next = "/admin"): Promise<string> {
    const outcome = await handOff(groundEmail, groundSub, next);
    expect(outcome.kind).toBe("link");
    return (outcome as Extract<typeof outcome, { kind: "link" }>).pending.value;
  }

  const linksOf = (userId: string) => db!.select().from(schema.baseLinks).where(eq(schema.baseLinks.userId, userId));
  const auditsOf = (userId: string, action: string) => db!.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityId, userId), eq(schema.auditLog.action, action)));

  beforeAll(async () => {
    const hash = await hashPassword(PASSWORD);
    const rows = await db!
      .insert(schema.adminUsers)
      .values([
        { email: accounts.pat, name: "Pat", role: "organizer", passwordHash: hash },
        { email: accounts.sam, name: "Sam", role: "editor", passwordHash: hash },
        { email: accounts.owner, name: "Owner", role: "owner", passwordHash: hash, totpSecret: "x", totpEnabledAt: new Date() },
        { email: accounts.nopw, name: "No Password", role: "editor" },
        { email: accounts.gone, name: "Gone", role: "organizer", passwordHash: hash },
        { email: accounts.lock, name: "Lock", role: "organizer", passwordHash: hash },
        { email: accounts.race, name: "Race", role: "organizer", passwordHash: hash },
      ])
      .returning({ id: schema.adminUsers.id, email: schema.adminUsers.email });
    for (const [key, value] of Object.entries(accounts)) ids[key] = rows.find((r) => r.email === value)!.id;
  });

  afterAll(async () => {
    const all = Object.values(ids);
    if (all.length) {
      await db!.delete(schema.auditLog).where(inArray(schema.auditLog.entityId, all));
      await db!.delete(schema.adminSessions).where(inArray(schema.adminSessions.userId, all));
      await db!.delete(schema.adminUsers).where(inArray(schema.adminUsers.id, all));
    }
    await db!.delete(schema.auditLog).where(sql`${schema.auditLog.details}::text like ${`%${stamp}%`}`);
    await db!.delete(schema.authTokens).where(inArray(schema.authTokens.email, Object.values(accounts)));
    await db!.delete(schema.loginAttempts).where(like(schema.loginAttempts.key, `%${stamp}%`));
    await client!.end();
    vi.unstubAllEnvs();
  });

  it("first time, by password: the link is made and audited, then the usual session", async () => {
    const cookie = await startedLink(accounts.pat.toUpperCase(), sub("pat"), "/admin/people");
    expect(await linksOf(ids.pat)).toEqual([]);
    const pending = await link.readPendingLink(db!, cookie);
    expect(pending?.account.email).toBe(accounts.pat);

    const outcome = await link.linkWithPassword(db!, cookie, PASSWORD, meta("pat"));
    expect(outcome).toMatchObject({ ok: true, next: "/admin/people", result: { ok: true, user: { id: ids.pat } } });
    expect(await linksOf(ids.pat)).toMatchObject([{ client: "imaginesurrey", sub: sub("pat"), linkedVia: "password", groundEmail: accounts.pat.toUpperCase() }]);
    expect(await auditsOf(ids.pat, "staff.base-link")).toHaveLength(1);
  });

  it("once linked, the sub signs in and the email is ignored, even when it changes or names someone else", async () => {
    for (const groundEmail of [accounts.pat, `pat-new-address-${stamp}@example.org`, accounts.sam]) {
      const outcome = await handOff(groundEmail, sub("pat"));
      expect(outcome).toMatchObject({ kind: "session", user: { id: ids.pat } });
    }
  });

  it("the waiting hand-off works once: replaying the cookie, or a forged one, gets nothing", async () => {
    const cookie = await startedLink(accounts.sam, sub("sam"));
    const [raw] = cookie.split(".");
    expect(await link.linkWithPassword(db!, `${raw}.forged`, PASSWORD, meta("sam"))).toEqual({ ok: false, reason: "expired" });
    expect(await link.linkWithPassword(db!, raw, PASSWORD, meta("sam"))).toEqual({ ok: false, reason: "expired" });
    expect((await link.linkWithPassword(db!, cookie, PASSWORD, meta("sam"))).ok).toBe(true);
    expect(await link.linkWithPassword(db!, cookie, PASSWORD, meta("sam"))).toEqual({ ok: false, reason: "expired" });
    expect(await linksOf(ids.sam)).toHaveLength(1);
  });

  it("an expired hand-off can't be finished", async () => {
    const cookie = await startedLink(accounts.race, sub("race-expired"));
    await db!.update(schema.authTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(and(eq(schema.authTokens.email, accounts.race), eq(schema.authTokens.purpose, "admin-base-link")));
    expect(await link.readPendingLink(db!, cookie)).toBeNull();
    expect(await link.linkWithPassword(db!, cookie, PASSWORD, meta("race"))).toEqual({ ok: false, reason: "expired" });
    expect(await linksOf(ids.race)).toEqual([]);
  });

  it("a wrong password links nothing, can be retried, and counts toward the sign-in lockout", async () => {
    const cookie = await startedLink(accounts.lock, sub("lock"));
    const wrong = await link.linkWithPassword(db!, cookie, "not the password", meta("lock-a"));
    expect(wrong).toEqual({ ok: false, reason: "invalid" });
    expect(await link.readPendingLink(db!, cookie)).not.toBeNull();
    expect(await auditsOf(ids.lock, "signin.base-link-refused")).toHaveLength(1);
    const failures = await db!.select().from(schema.loginAttempts).where(and(eq(schema.loginAttempts.key, `email:${accounts.lock}`), eq(schema.loginAttempts.success, false)));
    expect(failures).toHaveLength(1);
    // Each from a different address, so only the account's own count adds up.
    for (let i = 1; i < LOCK_ATTEMPTS; i++) await link.linkWithPassword(db!, cookie, "still wrong", meta(`lock-${i}`));
    expect(await link.linkWithPassword(db!, cookie, PASSWORD, meta("lock-final"))).toEqual({ ok: false, reason: "locked" });
    expect(await linksOf(ids.lock)).toEqual([]);
  });

  it("first time, by an emailed link: sent to the account's own address, and it works only in the browser that started", async () => {
    const cookie = await startedLink(accounts.nopw, sub("nopw"));
    // No password on this account: only the email works.
    expect(await link.linkWithPassword(db!, cookie, PASSWORD, meta("nopw"))).toEqual({ ok: false, reason: "no-password" });

    const linkFrom = () => {
      const message = sent.filter((m) => m.to === accounts.nopw).at(-1)!;
      expect(message.kind).toBe("admin-base-link");
      expect(message.text).not.toContain(sub("nopw"));
      const href = message.text.match(/https?:\/\/\S+/)![0];
      expect(new URL(href).pathname).toBe("/api/admin/base-link/email");
      return new URL(href).searchParams.get("token")!;
    };
    expect(await link.requestLinkEmail(db!, cookie, meta("nopw"))).toBe("sent");
    const first = linkFrom();
    // Opened somewhere else (or by the address's owner who didn't ask): refused, and spent.
    expect(await link.linkWithEmailedToken(db!, undefined, first, meta("nopw"))).toEqual({ ok: false, reason: "other-browser" });
    const other = await startedLink(accounts.race, sub("race-other"));
    expect(await link.linkWithEmailedToken(db!, other, first, meta("nopw"))).toEqual({ ok: false, reason: "link" });
    expect(await linksOf(ids.nopw)).toEqual([]);

    expect(await link.requestLinkEmail(db!, cookie, meta("nopw"))).toBe("sent");
    const second = linkFrom();
    // A link for one hand-off can't finish another browser's.
    expect(await link.linkWithEmailedToken(db!, other, second, meta("nopw"))).toEqual({ ok: false, reason: "other-browser" });
    expect(await link.requestLinkEmail(db!, cookie, meta("nopw"))).toBe("sent");
    const third = linkFrom();
    const outcome = await link.linkWithEmailedToken(db!, cookie, third, meta("nopw"));
    expect(outcome).toMatchObject({ ok: true, result: { ok: true, user: { id: ids.nopw } } });
    expect(await linksOf(ids.nopw)).toMatchObject([{ sub: sub("nopw"), linkedVia: "email-link" }]);
    // Replayed: nothing.
    expect(await link.linkWithEmailedToken(db!, cookie, third, meta("nopw"))).toEqual({ ok: false, reason: "link" });
  });

  it("an account linked to one Base Ground login refuses another", async () => {
    // Pat is linked to sub("pat"); a different Base Ground login with Pat's email gets nowhere.
    expect(await handOff(accounts.pat, sub("someone-else"))).toMatchObject({ kind: "refused", error: "base-linked-elsewhere" });
    // Two hand-offs waiting for the same account: the second to finish finds it taken.
    const a = await startedLink(accounts.race, sub("race-a"));
    const b = await startedLink(accounts.race, sub("race-b"));
    expect((await link.linkWithPassword(db!, a, PASSWORD, meta("race-a"))).ok).toBe(true);
    expect(await link.linkWithPassword(db!, b, PASSWORD, meta("race-b"))).toEqual({ ok: false, reason: "taken" });
    expect(await linksOf(ids.race)).toMatchObject([{ sub: sub("race-a") }]);
  });

  it("two-factor sign-in is still asked for, when linking and on every sign-in after", async () => {
    const cookie = await startedLink(accounts.owner, sub("owner"));
    const outcome = await link.linkWithPassword(db!, cookie, PASSWORD, meta("owner"));
    expect(outcome).toMatchObject({ ok: true, result: { ok: "second-step", user: { id: ids.owner } } });
    expect(await linksOf(ids.owner)).toHaveLength(1);
    expect(await handOff(accounts.owner, sub("owner"))).toMatchObject({ kind: "second-step", user: { id: ids.owner } });
  });

  it("a link to a deactivated account signs nobody in", async () => {
    const cookie = await startedLink(accounts.gone, sub("gone"));
    expect((await link.linkWithPassword(db!, cookie, PASSWORD, meta("gone"))).ok).toBe(true);
    await db!.update(schema.adminUsers).set({ active: false }).where(eq(schema.adminUsers.id, ids.gone));
    expect(await handOff(accounts.gone, sub("gone"))).toMatchObject({ kind: "refused", error: "base-inactive" });
  });

  it("an email with no staff account is refused and nothing is created", async () => {
    const stranger = `link-stranger-${stamp}@example.ca`;
    expect(await handOff(stranger, sub("stranger"))).toEqual({ kind: "refused", error: "base-no-account", email: stranger });
    expect(await db!.select().from(schema.adminUsers).where(eq(schema.adminUsers.email, stranger))).toEqual([]);
  });

  it("the callback keeps identities out of URLs: the refused email and the waiting hand-off travel in HttpOnly cookies", async () => {
    vi.stubEnv("DATABASE_URL", url!);
    vi.stubEnv("BASE_GROUND_URL", config.groundUrl);
    vi.stubEnv("BASE_SSO_SECRET", config.secret);
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", config.siteUrl);
    const { NextRequest } = await import("next/server");
    const { GET } = await import("@/app/auth/base/callback/route");
    const call = async (groundEmail: string, groundSub: string) => {
      const live = sso.ssoConfig()!;
      const start = sso.startHandOff(live, "/admin");
      vi.stubGlobal("fetch", async () => Response.json({ sub: groundSub, email: groundEmail, client: "imaginesurrey" }));
      try {
        const req = new NextRequest(`${config.siteUrl}/auth/base/callback?code=c&state=${start.state}`, { headers: { cookie: `${sso.STATE_COOKIE}=${start.cookie}` } });
        return await GET(req);
      } finally {
        vi.unstubAllGlobals();
      }
    };
    try {
      const stranger = `link-nobody-${stamp}@example.ca`;
      const refused = await call(stranger, sub("nobody"));
      expect(refused.headers.get("location")).toBe("/admin/login?error=base-no-account");
      const emailCookie = refused.cookies.get("is_admin_login_email");
      expect(emailCookie).toMatchObject({ value: stranger, httpOnly: true, path: "/admin/login" });
      expect(emailCookie?.maxAge).toBeLessThanOrEqual(300);

      await db!.delete(schema.baseLinks).where(eq(schema.baseLinks.userId, ids.race));
      const waiting = await call(accounts.race, sub("race-callback"));
      expect(waiting.headers.get("location")).toBe(link.LINK_PAGE);
      expect(waiting.cookies.get(link.LINK_COOKIE)).toMatchObject({ httpOnly: true, path: "/" });
      for (const res of [refused, waiting]) expect(res.headers.get("location")).not.toMatch(/@|ground-/);
    } finally {
      await (globalThis as unknown as { __db?: { $client: { end: () => Promise<void> } } }).__db?.$client.end();
      delete (globalThis as unknown as { __db?: unknown }).__db;
    }
  });

  it("an owner removes a link: the next sign-in asks for the proof again", async () => {
    expect((await link.listBaseLinks(db!)).get(ids.sam)).toMatchObject({ client: "imaginesurrey" });
    expect(await link.removeBaseLink(db!, ids.sam)).toMatchObject({ client: "imaginesurrey", sub: sub("sam") });
    expect(await link.baseLinkFor(db!, ids.sam)).toBeNull();
    expect(await link.removeBaseLink(db!, ids.sam)).toBeNull();
    expect((await handOff(accounts.sam, sub("sam"))).kind).toBe("link");
  });
});
