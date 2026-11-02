import { and, eq } from "drizzle-orm";
import { socialAccounts } from "@starsign/db";
import { ConnectorError, type AccountRef, type Connector } from "@starsign/connectors";
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

  /**
   * Connect an account from credentials a person typed (e.g. a Bluesky app password): the connector verifies
   * them and says whose they are, so nobody can attach credentials to someone else's handle.
   */
  async connectWithCredentials(p: Principal, input: { connector: string; network: Network; auth: Record<string, unknown> }) {
    const connector = this.ctx.connectors.get(input.connector);
    if (!connector || !connector.networks.includes(input.network)) throw new CoreError("invalid", `connector "${input.connector}" cannot connect ${input.network} here`);
    if (!connector.describeAccount) throw new CoreError("invalid", `${input.connector} accounts are connected another way`);
    let identity;
    try {
      identity = await connector.describeAccount(input.auth);
    } catch (e) {
      const reason = e instanceof ConnectorError && e.kind === "auth" ? "The handle or app password was not accepted." : "The network did not answer; try again in a minute.";
      throw new CoreError("invalid", "could not connect the account", { reason });
    }
    return this.connect(p, { network: input.network, externalId: identity.externalId, handle: identity.handle, displayName: identity.displayName ?? undefined, connector: connector.name, auth: input.auth });
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

  /**
   * Run a connector call with credentials that are refreshed when they are about to expire or when the
   * network says they are invalid. Refreshed credentials are persisted immediately (X rotates refresh tokens).
   */
  async withFreshAuth<T>(row: typeof socialAccounts.$inferSelect, connector: Connector, fn: (ref: AccountRef) => Promise<T>): Promise<T> {
    let ref = this.toRef(row);
    const expiresAt = typeof ref.auth?.expiresAt === "string" ? Date.parse(ref.auth.expiresAt) : NaN;
    if (connector.refreshAuth && Number.isFinite(expiresAt) && expiresAt - this.ctx.now().getTime() < 5 * 60_000) {
      const refreshed = await connector.refreshAuth(ref).catch(() => null);
      if (refreshed) {
        await this.updateAuth(row.id, refreshed.auth);
        ref = { ...ref, auth: refreshed.auth };
      }
    }
    try {
      return await fn(ref);
    } catch (e) {
      if (e instanceof ConnectorError && e.kind === "auth") {
        const refreshed = connector.refreshAuth ? await connector.refreshAuth(ref).catch(() => null) : null;
        if (refreshed) {
          await this.updateAuth(row.id, refreshed.auth);
          return await fn({ ...ref, auth: refreshed.auth });
        }
        await this.markReauth(row.id);
      }
      throw e;
    }
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
