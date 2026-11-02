import { and, eq } from "drizzle-orm";
import { socialAccounts } from "@starsign/db";
import type { AccountRef } from "@starsign/connectors";
import { newId } from "@starsign/ledger";
import { Network } from "@starsign/schema";
import type { CoreContext, Principal } from "../context.ts";
import { CoreError } from "../errors.ts";

export class AccountService {
  constructor(private readonly ctx: CoreContext) {}

  async connect(
    p: Principal,
    input: { network: Network; externalId: string; handle: string; displayName?: string; connector: string; auth?: Record<string, unknown>; config?: Record<string, unknown> },
  ) {
    Network.parse(input.network);
    const id = newId("acc");
    const [row] = await this.ctx.db
      .insert(socialAccounts)
      .values({
        id,
        workspaceId: p.workspaceId,
        network: input.network,
        externalId: input.externalId,
        handle: input.handle,
        displayName: input.displayName ?? null,
        connector: input.connector,
        authCiphertext: input.auth ? this.ctx.secrets.encrypt(input.auth) : null,
        config: input.config ?? {},
      })
      .onConflictDoUpdate({
        target: [socialAccounts.workspaceId, socialAccounts.network, socialAccounts.externalId],
        set: {
          handle: input.handle,
          displayName: input.displayName ?? null,
          connector: input.connector,
          authCiphertext: input.auth ? this.ctx.secrets.encrypt(input.auth) : undefined,
          config: input.config ?? {},
          status: "active",
        },
      })
      .returning();
    await this.ctx.events.append({
      workspaceId: p.workspaceId,
      type: "account.connected",
      subjectType: "social_account",
      subjectId: row!.id,
      actor: p.actor,
      data: { network: input.network, handle: input.handle, connector: input.connector },
    });
    return this.redact(row!);
  }

  async list(workspaceId: string) {
    const rows = await this.ctx.db.select().from(socialAccounts).where(eq(socialAccounts.workspaceId, workspaceId));
    return rows.map((r) => this.redact(r));
  }

  async get(workspaceId: string, accountId: string) {
    const [row] = await this.ctx.db
      .select()
      .from(socialAccounts)
      .where(and(eq(socialAccounts.id, accountId), eq(socialAccounts.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw new CoreError("not_found", `account ${accountId}`);
    return row;
  }

  async disconnect(p: Principal, accountId: string) {
    await this.get(p.workspaceId, accountId);
    await this.ctx.db.update(socialAccounts).set({ status: "disabled", authCiphertext: null }).where(eq(socialAccounts.id, accountId));
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "account.disconnected", subjectType: "social_account", subjectId: accountId, actor: p.actor });
  }

  /** Decrypted reference for connectors. Never leaves the process. */
  toRef(row: typeof socialAccounts.$inferSelect): AccountRef {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      network: row.network as Network,
      externalId: row.externalId,
      handle: row.handle,
      auth: row.authCiphertext ? this.ctx.secrets.decrypt(row.authCiphertext) : null,
      config: row.config,
    };
  }

  async updateAuth(accountId: string, auth: Record<string, unknown>) {
    await this.ctx.db.update(socialAccounts).set({ authCiphertext: this.ctx.secrets.encrypt(auth), status: "active" }).where(eq(socialAccounts.id, accountId));
  }

  async markReauth(accountId: string) {
    await this.ctx.db.update(socialAccounts).set({ status: "reauth_required" }).where(eq(socialAccounts.id, accountId));
  }

  redact(row: typeof socialAccounts.$inferSelect) {
    const { authCiphertext, ...rest } = row;
    return { ...rest, hasCredentials: !!authCiphertext };
  }
}
