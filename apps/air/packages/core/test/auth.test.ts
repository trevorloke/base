import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { createTestDb } from "@starsign/db/test";
import { ledgerEvents, type DbHandle } from "@starsign/db";
import { ConnectorRegistry, MockConnector } from "@starsign/connectors";
import { AttemptLimiter, INVITE_TTL_MS, InMemoryScheduler, SCRYPT_PARAMS, SecretBox, Starsign, hashPassword, needsRehash, verifyPassword, type Principal } from "../src/index.ts";

describe("password hashing", () => {
  it("encodes scrypt parameters, salt and a 64-byte key", async () => {
    const h = await hashPassword("correct horse battery");
    const [alg, N, r, p, salt, key] = h.split("$");
    expect(alg).toBe("scrypt");
    expect(Number(N)).toBe(2 ** 15);
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
    expect(Buffer.from(salt!, "base64url")).toHaveLength(SCRYPT_PARAMS.saltLength);
    expect(Buffer.from(key!, "base64url")).toHaveLength(64);
    expect(h).not.toContain("correct horse");
  });

  it("verifies the right password and rejects others", async () => {
    const h = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("correct horse batterY", h)).toBe(false);
    expect(await verifyPassword("", h)).toBe(false);
  });

  it("salts per hash", async () => {
    const [a, b] = await Promise.all([hashPassword("same password!"), hashPassword("same password!")]);
    expect(a).not.toBe(b);
    expect(await verifyPassword("same password!", a)).toBe(true);
    expect(await verifyPassword("same password!", b)).toBe(true);
  });

  it("normalizes unicode so the same visible password verifies", async () => {
    const h = await hashPassword("café-password");
    expect(await verifyPassword("café-password", h)).toBe(true);
  });

  it("reads parameters from the stored string and flags old ones for rehash", async () => {
    const h = await hashPassword("parameters travel");
    expect(needsRehash(h)).toBe(false);
    // A hash made with a lower cost still verifies (the params come from the string), and asks to be upgraded.
    const { scryptSync } = await import("node:crypto");
    const salt = Buffer.from("0123456789abcdef");
    const weak = `scrypt$1024$8$1$${salt.toString("base64url")}$${scryptSync("parameters travel", salt, 64, { N: 1024, r: 8, p: 1 }).toString("base64url")}`;
    expect(await verifyPassword("parameters travel", weak)).toBe(true);
    expect(needsRehash(weak)).toBe(true);
  });

  it("never matches malformed or out-of-bounds hashes", async () => {
    for (const bad of ["", "plain", "bcrypt$x", "scrypt$3$8$1$AAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA", "scrypt$1073741824$8$1$AAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA", "scrypt$32768$8$1$$"]) {
      expect(await verifyPassword("anything", bad)).toBe(false);
    }
  });
});

describe("attempt limiter", () => {
  it("blocks after max hits within the window and frees up as they age out", () => {
    let t = 0;
    const l = new AttemptLimiter(5, 15 * 60_000, () => t);
    for (let i = 0; i < 4; i++) {
      l.hit("a@x.test");
      t += 1000;
    }
    expect(l.retryAfterMs("a@x.test")).toBe(0);
    l.hit("a@x.test");
    expect(l.retryAfterMs("a@x.test")).toBeGreaterThan(14 * 60_000);
    expect(l.retryAfterMs("b@x.test")).toBe(0);
    t += 15 * 60_000;
    expect(l.retryAfterMs("a@x.test")).toBe(0);
    l.hit("a@x.test");
    l.reset("a@x.test");
    expect(l.retryAfterMs("a@x.test")).toBe(0);
  });
});

describe("pending invites", () => {
  let h: DbHandle;
  let m: Starsign;
  let clock = Date.parse("2026-11-03T12:00:00Z");
  const now = () => new Date(clock);
  let owner: Principal;
  let editor: Principal;
  let wsId = "";
  let otherOwner: Principal;
  const token = (url: string) => new URL(url).searchParams.get("invite")!;

  beforeAll(async () => {
    h = await createTestDb();
    m = new Starsign({
      handle: h,
      connectors: new ConnectorRegistry().register(new MockConnector()),
      scheduler: new InMemoryScheduler(),
      secrets: new SecretBox(randomBytes(32)),
      now,
      auth: { mailer: null, publicUrl: "https://starsign.test", logLinks: false },
    });
    const ownerUser = await m.workspaces.ensureUser("olga@acme.test", "Olga");
    const ws = await m.workspaces.create({ slug: "acme", name: "Acme" }, { type: "human", id: ownerUser.id });
    wsId = ws.id;
    await m.workspaces.addMember(ws.id, ownerUser.id, "owner");
    owner = { workspaceId: ws.id, actor: { type: "human", id: ownerUser.id }, role: "owner" };
    editor = { workspaceId: ws.id, actor: { type: "human", id: "usr_ed" }, role: "editor" };
    const other = await m.workspaces.create({ slug: "other", name: "Other" }, { type: "human", id: "usr_other" });
    otherOwner = { workspaceId: other.id, actor: { type: "human", id: "usr_other" }, role: "owner" };
  });
  afterAll(() => h.close());

  it("lists only pending invites, with who sent them, and never the token hash", async () => {
    const a = await m.auth.createInvite(owner, { email: "ann@acme.test", role: "editor" });
    await m.auth.createInvite(owner, { email: "ben@acme.test", role: "viewer" });
    clock += 60_000;
    // Accepted: not pending.
    await m.auth.acceptInvite({ token: token(a.inviteUrl), name: "Ann", password: "ann's long password" }, null);
    // Expired: not pending.
    await m.auth.createInvite(owner, { email: "cat@acme.test", role: "viewer" });
    clock += INVITE_TTL_MS + 60_000;
    await m.auth.createInvite(owner, { email: "dan@acme.test", role: "approver" });
    await m.auth.createInvite(otherOwner, { email: "eve@other.test", role: "viewer" });

    const list = await m.auth.listInvites(owner);
    expect(list.map((i) => i.email)).toEqual(["dan@acme.test"]);
    expect(list[0]).toEqual({
      id: expect.any(String),
      email: "dan@acme.test",
      role: "approver",
      invitedBy: { id: owner.actor.id, name: "Olga", email: "olga@acme.test" },
      expiresAt: new Date(clock + INVITE_TTL_MS).toISOString(),
      createdAt: new Date(clock).toISOString(),
    });
    expect(JSON.stringify(list)).not.toContain("tokenHash");
  });

  it("is for owners only, people not agents", async () => {
    await expect(m.auth.listInvites(editor)).rejects.toMatchObject({ code: "forbidden" });
    await expect(m.auth.listInvites({ ...owner, actor: { type: "mcp", id: "claude" } })).rejects.toMatchObject({ code: "forbidden" });
    const [inv] = await m.auth.listInvites(owner);
    await expect(m.auth.revokeInvite(editor, inv!.id)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("revokes a pending invite so its link stops working, once, in its own workspace only", async () => {
    const created = await m.auth.createInvite(owner, { email: "fay@acme.test", role: "editor" });
    const t = token(created.inviteUrl);
    const fay = (await m.auth.listInvites(owner)).find((i) => i.email === "fay@acme.test")!;
    await expect(m.auth.revokeInvite(otherOwner, fay.id)).rejects.toMatchObject({ code: "not_found" });
    const before = (await m.ctx.db.select().from(ledgerEvents).where(eq(ledgerEvents.workspaceId, wsId))).length;
    await m.auth.revokeInvite(owner, fay.id);
    expect((await m.auth.listInvites(owner)).map((i) => i.email)).toEqual(["dan@acme.test"]);
    await expect(m.auth.viewInvite(t)).rejects.toMatchObject({ code: "not_found" });
    await expect(m.auth.acceptInvite({ token: t, name: "Fay", password: "fay's long password" }, null)).rejects.toMatchObject({ code: "not_found" });
    await expect(m.auth.revokeInvite(owner, fay.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(m.auth.revokeInvite(owner, "inv_nope")).rejects.toMatchObject({ code: "not_found" });
    // The ledger records who revoked it.
    const after = await m.ctx.db.select().from(ledgerEvents).where(eq(ledgerEvents.workspaceId, wsId));
    expect(after.length).toBe(before + 1);
    expect(after.find((e) => e.type === "invite.revoked")).toMatchObject({ subjectId: fay.id, data: { email: fay.email } });
  });
});
