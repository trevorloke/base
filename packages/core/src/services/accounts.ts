import { createHash, randomBytes } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { oauthStates, socialAccounts } from "@starsign/db";
import { ConnectorError, type AccountRef, type ConnectedAccount, type Connector } from "@starsign/connectors";
import { newId } from "@starsign/ledger";
import { Network } from "@starsign/schema";
import type { CoreContext, Principal } from "../context.ts";
import { CoreError } from "../errors.ts";

const TRANSPORT = /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|getaddrinfo|socket hang up|network error|timed? ?out|aborted/i;

/**
 * What a person reads when connecting fails. Connector messages start with their own name and the call
 * ("telegram getMe: ...", "mastodon POST /api/v1/apps (host): fetch failed"); the person already knows which
 * network, so that prefix goes. A transport failure never reads as "credentials not accepted", and the connector's
 * own hint ("that does not look like a bot token (123456789:AA...)") is kept rather than replaced by a generic line.
 */
export function connectFailureReason(e: unknown, connectorName: string): string {
  const raw = (e instanceof Error ? e.message : String(e ?? "")).trim();
  let detail = raw;
  const name = connectorName.split("_")[0]!.toLowerCase();
  for (let i = 0; i < 3; i++) {
    const m = /^([^:]{1,100}):\s+([\s\S]+)$/.exec(detail);
    if (!m || !m[1]!.toLowerCase().startsWith(name)) break;
    detail = m[2]!.trim();
  }
  const kind = e instanceof ConnectorError ? e.kind : null;
  const clean = detail ? detail.charAt(0).toUpperCase() + detail.slice(1) : "";
  const sentence = clean && !/[.!?)]$/.test(clean) ? `${clean}.` : clean;
  if (kind === "network" || TRANSPORT.test(detail)) return "Starsign couldn't reach the network from this server. Check the address you typed, then try again in a minute.";
  if (kind === "rate_limit") return "The network is limiting requests right now. Try again in a few minutes.";
  if (kind === "auth") return sentence && !/^(unauthori[sz]ed|forbidden|401|403)\b/i.test(detail) ? `The credentials were not accepted: ${sentence}` : "The credentials were not accepted. Check them and try again.";
  return sentence || "The network refused the connection. Check what you typed and try again.";
}

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
      const reason = e instanceof ConnectorError && e.kind === "auth" ? "The handle or app password was not accepted." : connectFailureReason(e, connector.name);
      throw new CoreError("invalid", "could not connect the account", { reason });
    }
    return this.connect(p, { network: input.network, externalId: identity.externalId, handle: identity.handle, displayName: identity.displayName ?? undefined, connector: connector.name, auth: input.auth });
  }

  /** Connect from typed inputs (bot token, webhook URL, app password) for connectors that are not OAuth. */
  async connectFromInputs(p: Principal, input: { connector: string; network: Network; inputs: Record<string, string> }) {
    const connector = this.ctx.connectors.get(input.connector);
    if (!connector?.connectWithInputs || !connector.networks.includes(input.network)) throw new CoreError("invalid", `${input.connector} does not connect ${input.network} with typed credentials`);
    for (const f of connector.credentialInputs ?? []) if (!f.optional && !input.inputs[f.key]?.trim()) throw new CoreError("invalid", `${f.label} is required`, { field: f.key });
    let found: ConnectedAccount[];
    try {
      found = await connector.connectWithInputs({ network: input.network, inputs: input.inputs });
    } catch (e) {
      const reason = connectFailureReason(e, connector.name);
      throw new CoreError("invalid", "could not connect", { reason });
    }
    const out = [];
    for (const a of found) out.push(await this.connect(p, { network: a.network, externalId: a.identity.externalId, handle: a.identity.handle, displayName: a.identity.displayName ?? undefined, connector: connector.name, auth: a.auth, config: a.config }));
    return out;
  }

  /**
   * Begin an OAuth connection. Works for every OAuth connector: plain authorize URLs, PKCE, and connectors that
   * need per-start preparation from person-supplied inputs (e.g. registering an app on a Mastodon instance).
   */
  async startOAuth(
    p: Principal,
    input: { connector: string; network?: Network; redirectUri: string; inputs?: Record<string, string> },
  ): Promise<{ authorizeUrl: string; expiresAt: string }> {
    const connector = this.ctx.connectors.get(input.connector);
    const network = input.network ?? connector?.networks[0];
    const canExchange = !!connector && (!!connector.oauthConnect || !!connector.oauthExchange);
    const canAuthorize = !!connector && (!!connector.oauthAuthorizeUrl || !!connector.oauthPrepare);
    if (!connector || !network || !canExchange || !canAuthorize || !connector.networks.includes(network)) {
      throw new CoreError("invalid", `${input.connector} does not connect ${network ?? "accounts"} with OAuth`);
    }
    if (connector.connectConfigured === false) throw new CoreError("unavailable", `${input.connector} is not configured on this deployment`);
    for (const field of connector.oauthInputs ?? []) {
      if (!input.inputs?.[field.key]?.trim()) throw new CoreError("invalid", `${field.label} is required`, { field: field.key });
    }
    await this.ctx.db.delete(oauthStates).where(lt(oauthStates.expiresAt, this.ctx.now()));
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const expiresAt = new Date(this.ctx.now().getTime() + 10 * 60_000);
    let authorizeUrl: string;
    let config: Record<string, unknown> | null = null;
    if (connector.oauthPrepare) {
      try {
        const prepared = await connector.oauthPrepare({ inputs: input.inputs ?? {}, redirectUri: input.redirectUri, state, codeChallenge: challenge });
        authorizeUrl = prepared.authorizeUrl;
        config = prepared.config;
      } catch (e) {
        throw new CoreError("invalid", "could not start the connection", { reason: connectFailureReason(e, connector.name) });
      }
    } else {
      authorizeUrl = connector.oauthAuthorizeUrl!({ state, codeChallenge: challenge, redirectUri: input.redirectUri });
    }
    await this.ctx.db.insert(oauthStates).values({
      state,
      workspaceId: p.workspaceId,
      connector: input.connector,
      network,
      verifierCiphertext: this.ctx.secrets.encrypt({ verifier }),
      configCiphertext: config ? this.ctx.secrets.encrypt(config) : null,
      redirectUri: input.redirectUri,
      actor: p.actor,
      expiresAt,
    });
    return { authorizeUrl, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Finish an OAuth connection. The state is single use and expires; it carries the workspace and the person who
   * started it. One login may connect several accounts (a Facebook login yields its Pages and Instagram accounts).
   */
  async completeOAuth(input: { state: string; code: string; params?: Record<string, string> }) {
    const [row] = await this.ctx.db.delete(oauthStates).where(eq(oauthStates.state, input.state)).returning();
    if (!row || row.expiresAt.getTime() < this.ctx.now().getTime()) throw new CoreError("invalid", "this connection link has expired; start again", { reason: "expired" });
    const connector = this.ctx.connectors.get(row.connector);
    if (!connector || (!connector.oauthConnect && !(connector.oauthExchange && connector.describeAccount))) throw new CoreError("invalid", `${row.connector} cannot complete OAuth`);
    const { verifier } = this.ctx.secrets.decrypt<{ verifier: string }>(row.verifierCiphertext);
    const config = row.configCiphertext ? this.ctx.secrets.decrypt<Record<string, unknown>>(row.configCiphertext) : undefined;
    let found: ConnectedAccount[];
    try {
      if (connector.oauthConnect) {
        found = await connector.oauthConnect({ code: input.code, codeVerifier: verifier, redirectUri: row.redirectUri, ...(config ? { config } : {}), ...(input.params ? { callbackParams: input.params } : {}) });
      } else {
        const auth = await connector.oauthExchange!({ code: input.code, codeVerifier: verifier, redirectUri: row.redirectUri });
        found = [{ network: row.network as Network, identity: await connector.describeAccount!(auth), auth }];
      }
    } catch {
      throw new CoreError("invalid", "the network did not accept the authorization", { reason: "exchange_failed" });
    }
    if (found.length === 0) throw new CoreError("invalid", "the login has no accounts Starsign can manage", { reason: "no_accounts" });
    const principal: Principal = { workspaceId: row.workspaceId, actor: row.actor };
    const connected = [];
    for (const a of found) {
      connected.push(
        await this.connect(principal, {
          network: a.network,
          externalId: a.identity.externalId,
          handle: a.identity.handle,
          displayName: a.identity.displayName ?? undefined,
          connector: connector.name,
          auth: a.auth,
          config: a.config,
        }),
      );
    }
    return connected;
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
