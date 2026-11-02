import { and, eq, isNull } from "drizzle-orm";
import { apiKeys, members, policies, users, workspaces } from "@starsign/db";
import { newId } from "@starsign/ledger";
import { DEFAULT_POLICY, type Actor } from "@starsign/schema";
import type { MemberRole } from "@starsign/policy";
import type { CoreContext, Principal } from "../context.ts";
import { randomToken, sha256 } from "../crypto.ts";
import { CoreError } from "../errors.ts";

export class WorkspaceService {
  constructor(private readonly ctx: CoreContext) {}

  async create(input: { slug: string; name: string; profile?: Record<string, unknown>; timezone?: string }, actor: Actor) {
    const slug = input.slug.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const existing = await this.ctx.db.select().from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
    if (existing[0]) throw new CoreError("conflict", `workspace slug "${slug}" exists`);
    const id = newId("ws");
    const [ws] = await this.ctx.db
      .insert(workspaces)
      .values({ id, slug, name: input.name, profile: input.profile ?? {}, settings: { timezone: input.timezone ?? "UTC" } })
      .returning();
    const policy = { ...DEFAULT_POLICY, timezone: input.timezone ?? DEFAULT_POLICY.timezone };
    await this.ctx.db.insert(policies).values({ id: newId("pol"), workspaceId: id, version: 1, document: policy, active: true, createdBy: actor });
    await this.ctx.events.append({ workspaceId: id, type: "workspace.created", subjectType: "workspace", subjectId: id, actor, data: { slug, name: input.name } });
    return ws!;
  }

  async get(workspaceId: string) {
    const [ws] = await this.ctx.db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (!ws) throw new CoreError("not_found", `workspace ${workspaceId}`);
    return ws;
  }

  async bySlug(slug: string) {
    const [ws] = await this.ctx.db.select().from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
    return ws ?? null;
  }

  async list() {
    return this.ctx.db.select().from(workspaces).orderBy(workspaces.createdAt);
  }

  async updateProfile(p: Principal, profile: Record<string, unknown>) {
    this.requireRole(p, ["owner", "approver", "editor"]);
    const [ws] = await this.ctx.db.update(workspaces).set({ profile }).where(eq(workspaces.id, p.workspaceId)).returning();
    return ws!;
  }

  async ensureUser(email: string, name?: string) {
    const [u] = await this.ctx.db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
    if (u) return u;
    const [created] = await this.ctx.db.insert(users).values({ id: newId("usr"), email: email.toLowerCase(), name: name ?? null }).returning();
    return created!;
  }

  async addMember(workspaceId: string, userId: string, role: MemberRole) {
    const [m] = await this.ctx.db
      .insert(members)
      .values({ id: newId("mem"), workspaceId, userId, role })
      .onConflictDoUpdate({ target: [members.workspaceId, members.userId], set: { role } })
      .returning();
    return m!;
  }

  async memberRole(workspaceId: string, userId: string): Promise<MemberRole | null> {
    const [m] = await this.ctx.db
      .select({ role: members.role })
      .from(members)
      .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, userId)))
      .limit(1);
    return m?.role ?? null;
  }

  /** Mint an API key. The secret is returned once and stored only as a hash. */
  async createApiKey(input: { workspaceId: string; name: string; actorType: "human" | "mcp" | "operator"; actorId: string; role?: MemberRole }) {
    const secret = randomToken("star");
    const [row] = await this.ctx.db
      .insert(apiKeys)
      .values({
        id: newId("key"),
        workspaceId: input.workspaceId,
        keyHash: sha256(secret),
        name: input.name,
        actorType: input.actorType,
        actorId: input.actorId,
        role: input.role ?? null,
      })
      .returning();
    return { secret, key: row! };
  }

  async authenticate(secret: string): Promise<Principal | null> {
    const [row] = await this.ctx.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, sha256(secret)), isNull(apiKeys.revokedAt)))
      .limit(1);
    if (!row) return null;
    await this.ctx.db.update(apiKeys).set({ lastUsedAt: this.ctx.now() }).where(eq(apiKeys.id, row.id));
    return { workspaceId: row.workspaceId, actor: { type: row.actorType, id: row.actorId }, role: row.role ?? undefined };
  }

  requireRole(p: Principal, roles: MemberRole[]): void {
    if (p.actor.type !== "human") return; // non-human actors are governed by autonomy, not roles
    if (!p.role || !roles.includes(p.role)) throw new CoreError("forbidden", `requires one of: ${roles.join(", ")}`);
  }
}
