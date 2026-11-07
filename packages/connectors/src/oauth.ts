import type { FetchLike } from "./http.ts";
import { ConnectorError } from "./types.ts";

/**
 * Configuration for a standard OAuth 2.0 authorization-code provider. Connectors compose OAuth2Client instead of
 * re-implementing token exchange, refresh and error mapping.
 */
export interface OAuth2ProviderConfig {
  name: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Scope separator in the authorize URL (most use " ", Meta and TikTok use ","). */
  scopeSeparator?: string;
  /** PKCE support (S256). */
  pkce: boolean;
  /** How the client authenticates at the token endpoint. */
  clientAuth: "basic" | "body";
  /** Name of the client id parameter (TikTok uses client_key). */
  clientIdParam?: string;
  extraAuthorizeParams?: Record<string, string>;
  clientId?: string;
  clientSecret?: string;
}

export interface OAuth2Token {
  accessToken: string;
  refreshToken?: string;
  /** ISO time the access token expires. */
  expiresAt?: string;
  /** ISO time the refresh token expires, when the provider says. */
  refreshExpiresAt?: string;
  scope?: string;
  /** Everything the provider returned, for provider-specific fields (open_id, user ids). */
  raw: Record<string, unknown>;
}

export class OAuth2Client {
  constructor(
    readonly config: OAuth2ProviderConfig,
    private readonly fetchImpl?: FetchLike,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get configured(): boolean {
    return !!this.config.clientId && (this.config.pkce || !!this.config.clientSecret);
  }

  private get fetch(): FetchLike {
    return this.fetchImpl ?? ((i, init) => globalThis.fetch(i, init));
  }

  authorizeUrl(p: { state: string; redirectUri: string; codeChallenge?: string; scopes?: string[]; extra?: Record<string, string> }): string {
    if (!this.config.clientId) throw new ConnectorError(`${this.config.name} oauth: client id is not configured`, "auth", false);
    const q = new URLSearchParams({
      response_type: "code",
      [this.config.clientIdParam ?? "client_id"]: this.config.clientId,
      redirect_uri: p.redirectUri,
      scope: (p.scopes ?? this.config.scopes).join(this.config.scopeSeparator ?? " "),
      state: p.state,
      ...(this.config.extraAuthorizeParams ?? {}),
      ...(p.extra ?? {}),
    });
    if (this.config.pkce && p.codeChallenge) {
      q.set("code_challenge", p.codeChallenge);
      q.set("code_challenge_method", "S256");
    }
    return `${this.config.authorizeUrl}?${q}`;
  }

  async exchange(p: { code: string; redirectUri: string; codeVerifier?: string }): Promise<OAuth2Token> {
    const form = new URLSearchParams({ grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri });
    if (this.config.pkce && p.codeVerifier) form.set("code_verifier", p.codeVerifier);
    return this.tokenRequest(form, "code exchange");
  }

  async refresh(refreshToken: string): Promise<OAuth2Token> {
    const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
    const t = await this.tokenRequest(form, "refresh");
    // Providers that do not rotate refresh tokens omit them; keep the old one.
    return { ...t, refreshToken: t.refreshToken ?? refreshToken };
  }

  private async tokenRequest(form: URLSearchParams, what: string): Promise<OAuth2Token> {
    const { clientId, clientSecret } = this.config;
    if (!clientId) throw new ConnectorError(`${this.config.name} oauth: client id is not configured`, "auth", false);
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    if (this.config.clientAuth === "basic" && clientSecret) {
      headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
    } else {
      form.set(this.config.clientIdParam ?? "client_id", clientId);
      if (clientSecret) form.set("client_secret", clientSecret);
    }
    let res: Response;
    try {
      res = await this.fetch(this.config.tokenUrl, { method: "POST", headers, body: form.toString() });
    } catch (e) {
      throw new ConnectorError(`${this.config.name} oauth ${what}: network error: ${(e as Error).message}`, "network", true, e);
    }
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = Object.fromEntries(new URLSearchParams(text)); // a few providers answer form-encoded
    }
    // Some providers (TikTok) wrap the token in `data`; some report errors with 200.
    const payload = (body.data && typeof body.data === "object" ? body.data : body) as Record<string, unknown>;
    const err = payload.error ?? body.error;
    if (!res.ok || err || typeof payload.access_token !== "string") {
      const detail = String(payload.error_description ?? body.error_description ?? err ?? `HTTP ${res.status}`);
      const kind = res.status === 429 ? "rate_limit" : res.status >= 500 ? "network" : "auth";
      throw new ConnectorError(`${this.config.name} oauth ${what} failed: ${detail}`, kind, kind !== "auth", { status: res.status, body });
    }
    const n = this.now().getTime();
    const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);
    const expiresIn = num(payload.expires_in);
    const refreshIn = num(payload.refresh_expires_in ?? payload.refresh_token_expires_in);
    return {
      accessToken: payload.access_token as string,
      ...(typeof payload.refresh_token === "string" ? { refreshToken: payload.refresh_token } : {}),
      ...(expiresIn ? { expiresAt: new Date(n + expiresIn * 1000).toISOString() } : {}),
      ...(refreshIn ? { refreshExpiresAt: new Date(n + refreshIn * 1000).toISOString() } : {}),
      ...(typeof payload.scope === "string" ? { scope: payload.scope } : {}),
      raw: payload,
    };
  }
}

/** Standard env names: <PREFIX>_CLIENT_ID / <PREFIX>_CLIENT_SECRET (e.g. META_CLIENT_ID). */
export function clientFromEnv(env: NodeJS.ProcessEnv, prefix: string): { clientId?: string; clientSecret?: string } {
  return { clientId: env[`${prefix}_CLIENT_ID`] || undefined, clientSecret: env[`${prefix}_CLIENT_SECRET`] || undefined };
}
