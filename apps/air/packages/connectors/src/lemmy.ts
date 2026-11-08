import type { ActivityInput, ActivityKind, Media, MetricInput, MetricName, Network } from "@base-air/schema";
import { z } from "zod";
import { asNetworkError, classifyHttpStatus, downloadMedia, isAfter, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import { normalizeServerHost } from "./misskey.ts";
import type { AccountIdentity, AccountRef, AuthRefresh, ConnectedAccount, Connector, ConnectorCapabilities, MediaFetcher, ModerationInput, PublishInput, PublishResult, ValidationIssue } from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * Lemmy (link aggregator / forum on ActivityPub) over its HTTP API, v3 by default (Lemmy 0.19.x).
 *
 * Lemmy has no OAuth for third-party apps and no scoped tokens: an app logs in with the account's username/email and
 * password (POST /user/login) and receives a JWT, sent as `Authorization: Bearer`. The credentials are kept in the
 * (encrypted) auth blob so a 401 can log in again (`refreshAuth`, and transparently inside each call). A one-time
 * 2FA code can only be used at connect: accounts with 2FA must reconnect when their JWT stops working.
 *
 * External ids carry the type and host because post and comment ids are separate per-instance sequences:
 * "post:<id>@<host>" and "comment:<id>@<host>". A bare number is read as a post id.
 *
 * TODO(verify): Lemmy 1.0 moves to /api/v4 with renamed routes (login under /account/auth, notifications combined,
 * cursor pagination, image upload under /api/v4/image). The base path is configurable (option `apiBase`, env
 * LEMMY_API_BASE, or per-account config.apiBase), but only the v3 route names are implemented.
 */

export const LEMMY_DEFAULT_API_BASE = "/api/v3";

export const LemmyAuth = z.object({
  host: z.string().min(1),
  usernameOrEmail: z.string().min(1),
  password: z.string().min(1),
  jwt: z.string().min(1),
  personId: z.number().int(),
});
export type LemmyAuth = z.infer<typeof LemmyAuth>;

export interface LemmyConnectorOptions {
  fetch?: FetchLike;
  now?: () => Date;
  /** API base path, default "/api/v3". */
  apiBase?: string;
  /** Pages (50 items) of mentions/replies/community posts walked per fetchActivity. */
  maxPages?: number;
  allowPrivateHosts?: boolean;
}

export interface LemmyPerson {
  id: number;
  name: string;
  display_name?: string | null;
  actor_id: string;
  local?: boolean;
}
export interface LemmyCommunity {
  id: number;
  name: string;
  title?: string;
  actor_id: string;
  local?: boolean;
}
export interface LemmyPost {
  id: number;
  name: string;
  url?: string | null;
  body?: string | null;
  creator_id: number;
  community_id: number;
  published: string;
  ap_id?: string;
}
export interface LemmyComment {
  id: number;
  creator_id: number;
  post_id: number;
  content: string;
  published: string;
  /** "0.<root id>.<child id>...": the comment's ancestry ending with its own id. */
  path: string;
  ap_id?: string;
}
export interface LemmyPostView {
  post: LemmyPost;
  creator: LemmyPerson;
  community: LemmyCommunity;
  counts?: { score?: number; upvotes?: number; downvotes?: number; comments?: number };
}
export interface LemmyCommentView {
  comment: LemmyComment;
  creator: LemmyPerson;
  post: LemmyPost;
  community: LemmyCommunity;
  counts?: { score?: number; upvotes?: number; downvotes?: number; child_count?: number };
  person_mention?: { id: number; published: string };
  comment_reply?: { id: number; published: string };
}

/** A community the account posts to or watches, resolved at connect. */
export interface LemmyCommunityRef {
  /** "name@instance" */
  name: string;
  id: number;
  title: string | null;
}

const AUTH_ERRORS = new Set(["not_logged_in", "incorrect_login", "missing_totp_token", "incorrect_totp_token", "email_not_verified", "registration_application_is_pending", "registration_denied", "site_ban", "deleted", "password_incorrect"]);

/** Lemmy errors are `{ error: "snake_case_code", message? }`, mostly with HTTP 400. */
export function mapLemmyError(status: number, body: unknown, what: string, writing = false): ConnectorError {
  const b = typeof body === "object" && body ? (body as { error?: unknown; message?: unknown }) : {};
  const code = typeof b.error === "string" ? b.error : "";
  const detail = [code, typeof b.message === "string" ? b.message : ""].filter(Boolean).join(": ") || (typeof body === "string" ? body.slice(0, 200) : "");
  const msg = `lemmy ${what}: HTTP ${status}${detail ? ` ${detail}` : ""}`;
  const cause = { status, code, body };
  if (status === 429 || code === "rate_limit_error") return new ConnectorError(`${msg} (rate limited by the instance)`, "rate_limit", true, cause);
  if (code === "missing_totp_token" || code === "incorrect_totp_token") return new ConnectorError(`${msg} (this account uses two-factor authentication: reconnect with a current code)`, "auth", false, cause);
  if (status === 401 || AUTH_ERRORS.has(code)) return new ConnectorError(`${msg} (log in again)`, "auth", false, cause);
  if (status === 403) return new ConnectorError(msg, writing ? "rejected" : "auth", false, cause);
  const { kind, retryable } = classifyHttpStatus(status);
  return new ConnectorError(msg, kind, retryable, cause);
}

/** Lemmy 0.18 timestamps have no zone (UTC); 0.19 adds "Z". */
export function lemmyTime(s: string): string {
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString() : iso;
}

export function parseLemmyId(externalId: string): { type: "post" | "comment"; id: number; host: string | null } {
  const m = externalId.trim().match(/^(?:(post|comment):)?(\d+)(?:@([^@\s]+))?$/);
  if (!m?.[2]) throw new ConnectorError(`lemmy: "${externalId}" is not a post or comment id`, "rejected", false);
  return { type: m[1] === "comment" ? "comment" : "post", id: Number(m[2]), host: m[3] ?? null };
}

const postId = (id: number, host: string) => `post:${id}@${host}`;
const commentId = (id: number, host: string) => `comment:${id}@${host}`;

/** "name", "!name@instance", "https://instance/c/name" → "name@instance" (local communities get the account's host). */
export function normalizeCommunity(input: string, localHost: string): string {
  let s = input.trim().replace(/^!/, "");
  const url = s.match(/^https?:\/\/([^/]+)\/c\/([^/?#]+)/i);
  if (url?.[1] && url[2]) s = `${url[2]}@${url[1]}`;
  const [name, inst] = s.split("@");
  if (!name || !/^[A-Za-z0-9_]{1,50}$/.test(name)) throw new ConnectorError(`lemmy: "${input}" is not a community name (name@instance)`, "rejected", false);
  return `${name.toLowerCase()}@${(inst ?? localHost).toLowerCase()}`;
}

function actorHandle(actorId: string, name: string): string {
  try {
    return `@${name}@${new URL(actorId).host}`;
  } catch {
    return `@${name}`;
  }
}

export class LemmyConnector implements Connector {
  readonly name = "lemmy";
  readonly networks: readonly Network[] = ["lemmy"];
  readonly connectMethod = "app_password" as const;
  readonly connectConfigured = true;
  readonly credentialInputs = [
    { key: "host", label: "Your Lemmy instance", placeholder: "lemmy.world" },
    { key: "username", label: "Username or email", placeholder: "acme" },
    { key: "password", label: "Password", secret: true },
    { key: "totp", label: "2FA code (if enabled)", placeholder: "123456", secret: true, optional: true },
    { key: "communities", label: "Communities to post to and watch (comma-separated)", placeholder: "acme@lemmy.world, technology@lemmy.world", optional: true },
  ] as const;
  media?: MediaFetcher;

  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly apiBase: string;
  private readonly maxPages: number;
  private readonly allowPrivateHosts: boolean;
  private readonly idempotency = new IdempotencyCache<PublishResult>();
  /** Post created for an idempotency key whose first comment has not been made yet. */
  private readonly progress = new Map<string, { postId: number; url: string }>();
  /** Fresh JWTs from transparent re-logins, by account id (core persists them through refreshAuth). */
  private readonly jwts = new Map<string, string>();

  constructor(opts: LemmyConnectorOptions = {}) {
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.apiBase = normalizeBase(opts.apiBase ?? LEMMY_DEFAULT_API_BASE);
    this.maxPages = opts.maxPages ?? 3;
    this.allowPrivateHosts = opts.allowPrivateHosts ?? false;
  }

  capabilities(): ConnectorCapabilities {
    // People have no follower count on Lemmy, so there are no account metrics.
    return { publish: true, fetchActivity: true, fetchMetrics: true, meteredReads: false, reply: true, moderate: true, accountMetrics: false, webhooks: false, video: false, kinds: ["post", "link"] };
  }

  // ---- connect ------------------------------------------------------------------------------

  async connectWithInputs(p: { network: Network; inputs: Record<string, string> }): Promise<ConnectedAccount[]> {
    const host = normalizeServerHost(p.inputs.host ?? "", "lemmy", this.allowPrivateHosts);
    const usernameOrEmail = (p.inputs.username ?? "").trim().replace(/^@/, "");
    const password = p.inputs.password ?? "";
    if (!usernameOrEmail || !password) throw new ConnectorError("lemmy: username (or email) and password are required", "auth", false);
    const base = this.apiBase;
    const jwt = await this.login(host, base, usernameOrEmail, password, (p.inputs.totp ?? "").trim() || undefined);
    const person = await this.myPerson(host, base, jwt);
    const communities: LemmyCommunityRef[] = [];
    for (const raw of (p.inputs.communities ?? "").split(/[\s,]+/).filter(Boolean)) {
      communities.push(await this.resolveCommunity(host, base, jwt, normalizeCommunity(raw, host)));
    }
    const auth: LemmyAuth = { host, usernameOrEmail, password, jwt, personId: person.id };
    return [{ network: "lemmy", identity: identityOf(host, person), auth, config: { host, apiBase: base, communities, personName: person.name } }];
  }

  async describeAccount(raw: Record<string, unknown>): Promise<AccountIdentity> {
    const host = typeof raw.host === "string" ? raw.host : null;
    const jwt = typeof raw.jwt === "string" ? raw.jwt : null;
    if (!host || !jwt) throw new ConnectorError("lemmy: host and jwt are required", "auth", false);
    return identityOf(host, await this.myPerson(host, this.apiBase, jwt));
  }

  /** Log in again with the stored credentials. */
  async refreshAuth(account: AccountRef): Promise<AuthRefresh | null> {
    const auth = parseAuth(account);
    const jwt = await this.login(auth.host, this.baseOf(account), auth.usernameOrEmail, auth.password);
    this.jwts.set(account.id, jwt);
    return { auth: { ...auth, jwt } };
  }

  private async login(host: string, base: string, usernameOrEmail: string, password: string, totp?: string): Promise<string> {
    const res = (await this.request(host, null, "POST", `${base}/user/login`, { json: { username_or_email: usernameOrEmail, password, ...(totp ? { totp_2fa_token: totp } : {}) }, what: "login" })) as { jwt?: unknown; verify_email_sent?: unknown; registration_created?: unknown } | undefined;
    if (typeof res?.jwt !== "string" || !res.jwt) {
      const why = res?.verify_email_sent ? "verify the account's email first" : res?.registration_created ? "the registration application is still pending" : "no token was returned";
      throw new ConnectorError(`lemmy ${host}: login did not return a token (${why})`, "auth", false, res);
    }
    return res.jwt;
  }

  private async myPerson(host: string, base: string, jwt: string): Promise<LemmyPerson> {
    const site = (await this.request(host, jwt, "GET", `${base}/site`, { what: "site" })) as { my_user?: { local_user_view?: { person?: LemmyPerson } } } | undefined;
    const person = site?.my_user?.local_user_view?.person;
    if (!person?.id || !person.name) throw new ConnectorError(`lemmy ${host}: /site returned no logged-in user (token not accepted)`, "auth", false, site);
    return person;
  }

  /** GET /community?name=name@instance; for a remote community the instance has not seen yet, /resolve_object. */
  private async resolveCommunity(host: string, base: string, jwt: string, name: string): Promise<LemmyCommunityRef> {
    const ref = (c: LemmyCommunity): LemmyCommunityRef => ({ name, id: c.id, title: c.title ?? null });
    const localName = name.endsWith(`@${host}`) ? name.slice(0, -host.length - 1) : name;
    try {
      const res = (await this.request(host, jwt, "GET", `${base}/community`, { query: { name: localName }, what: "community" })) as { community_view?: { community?: LemmyCommunity } };
      if (res?.community_view?.community) return ref(res.community_view.community);
    } catch (err) {
      const cause = err instanceof ConnectorError ? (err.cause as { code?: string; status?: number } | undefined) : undefined;
      if (cause?.code !== "couldnt_find_community" && cause?.status !== 404) throw err;
    }
    // TODO(verify): resolve_object federates the community in on first use; it can be slow on busy instances.
    const res = (await this.request(host, jwt, "GET", `${base}/resolve_object`, { query: { q: `!${name}` }, what: "resolve_object" })) as { community?: { community?: LemmyCommunity } };
    const c = res?.community?.community;
    if (!c) throw new ConnectorError(`lemmy: community ${name} was not found from ${host}`, "rejected", false, res);
    return ref(c);
  }

  // ---- publish ------------------------------------------------------------------------------

  validate(account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const title = input.options?.title?.trim() ?? "";
    if (!title) issues.push({ code: "empty", message: "lemmy posts need a title (options.title)" });
    else if ([...title].length > 200) issues.push({ code: "too_long", message: "lemmy post titles are at most 200 characters" });
    if (input.thread.length > 0) issues.push({ code: "thread_unsupported", message: "lemmy has no threads; use the first comment instead" });
    if (input.media.length > 1) issues.push({ code: "too_many_media", message: "lemmy posts carry one image or link" });
    if (communitiesOf(account).length === 0 && !input.options?.subreddit) issues.push({ code: "empty", message: "choose a community: add one to the account's communities when connecting" });
    return issues;
  }

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, () => this.publishPost(account, input));
  }

  private async publishPost(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    const auth = parseAuth(account);
    const opts = input.options ?? {};
    const title = opts.title?.trim();
    if (!title) throw new ConnectorError("lemmy publish: a title is required (options.title)", "rejected", false);
    let made = this.progress.get(input.idempotencyKey);
    if (!made) {
      const community = await this.targetCommunity(account, auth, opts.subreddit);
      const body: Record<string, unknown> = { name: title.slice(0, 200), community_id: community.id };
      let text = input.text.trim();
      const media = input.media[0];
      let link = opts.link;
      if (media) {
        const mediaUrl = await this.mediaUrl(account, auth, media);
        if (link) text = [text, `![${media.alt ?? ""}](${mediaUrl})`].filter(Boolean).join("\n\n");
        else {
          link = mediaUrl;
          if (media.alt) body.alt_text = media.alt;
        }
      }
      if (link) body.url = link;
      if (text) body.body = text;
      if (opts.nsfw) body.nsfw = true;
      const res = (await this.call(account, auth, "POST", "/post", { json: body, writing: true, what: "create post" })) as { post_view?: LemmyPostView };
      const id = res?.post_view?.post?.id;
      if (typeof id !== "number") throw new ConnectorError("lemmy publish: response carried no post", "unknown", false, res);
      made = { postId: id, url: `https://${auth.host}/post/${id}` };
      this.progress.set(input.idempotencyKey, made);
    }
    const externalId = postId(made.postId, auth.host);
    let firstCommentId: string | undefined;
    if (opts.firstComment?.trim()) {
      try {
        const res = (await this.call(account, auth, "POST", "/comment", { json: { post_id: made.postId, content: opts.firstComment }, writing: true, what: "first comment" })) as { comment_view?: LemmyCommentView };
        const cid = res?.comment_view?.comment?.id;
        if (typeof cid === "number") firstCommentId = commentId(cid, auth.host);
      } catch (err) {
        const ce = err instanceof ConnectorError ? err : new ConnectorError(err instanceof Error ? err.message : String(err), "unknown", true, err);
        ce.partial = { externalId, url: made.url, threadExternalIds: [externalId] };
        throw ce;
      }
    }
    this.progress.delete(input.idempotencyKey);
    return { externalId, url: made.url, raw: { postId: made.postId, ...(firstCommentId ? { firstCommentId } : {}) } };
  }

  private async targetCommunity(account: AccountRef, auth: LemmyAuth, override: string | undefined): Promise<LemmyCommunityRef> {
    const list = communitiesOf(account);
    if (override) {
      const name = normalizeCommunity(override, auth.host);
      return list.find((c) => c.name === name) ?? (await this.resolveCommunity(auth.host, this.baseOf(account), this.jwtOf(account, auth), name));
    }
    const first = list[0];
    if (!first) throw new ConnectorError("lemmy publish: no community to post to (add communities to the account)", "rejected", false);
    return first;
  }

  /**
   * Upload the image to the instance's pict-rs (POST /pictrs/image, field images[]) and use its URL. When the instance
   * refuses uploads (disabled, too large, unsupported type) fall back to linking Base Air's public media URL.
   * TODO(verify): Lemmy 1.0 uploads via POST /api/v4/image.
   */
  private async mediaUrl(account: AccountRef, auth: LemmyAuth, media: Media): Promise<string> {
    if (media.kind === "video" || media.kind === "document") return media.url;
    const { bytes, mime } = this.media ? await this.media.fetch(media) : await downloadMedia(resolveFetch(this.fetchImpl), media);
    const form = new FormData();
    form.append("images[]", new Blob([bytes], { type: mime }), `upload.${mime.split("/")[1]?.split("+")[0] ?? "bin"}`);
    try {
      const res = (await this.call(account, auth, "POST", "/pictrs/image", { form, absolute: true, writing: true, what: "image upload" })) as { msg?: string; files?: { file?: string }[] } | undefined;
      const file = res?.files?.[0]?.file;
      if (res?.msg === "ok" && file) return `https://${auth.host}/pictrs/image/${file}`;
      return media.url;
    } catch (err) {
      if (err instanceof ConnectorError && err.kind === "rejected") return media.url;
      throw err;
    }
  }

  // ---- engage -------------------------------------------------------------------------------

  async reply(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const auth = parseAuth(account);
      const parent = parseLemmyId(input.parentExternalId);
      const json: Record<string, unknown> = { content: input.text };
      if (parent.type === "post") json.post_id = parent.id;
      else {
        const view = (await this.call(account, auth, "GET", "/comment", { query: { id: String(parent.id) }, what: "comment" })) as { comment_view?: LemmyCommentView };
        const post = view?.comment_view?.comment?.post_id;
        if (typeof post !== "number") throw new ConnectorError(`lemmy reply: comment ${parent.id} not found`, "rejected", false, view);
        json.post_id = post;
        json.parent_id = parent.id;
      }
      const res = (await this.call(account, auth, "POST", "/comment", { json, writing: true, what: "reply" })) as { comment_view?: LemmyCommentView };
      const id = res?.comment_view?.comment?.id;
      if (typeof id !== "number") throw new ConnectorError("lemmy reply: response carried no comment", "unknown", false, res);
      return { externalId: commentId(id, auth.host), url: `https://${auth.host}/comment/${id}`, raw: res };
    });
  }

  /** like = upvote (score 1), unlike = clear vote (score 0), delete = own post/comment. No per-reply hide for users. */
  async moderate(account: AccountRef, input: ModerationInput): Promise<void> {
    const auth = parseAuth(account);
    const target = parseLemmyId(input.externalId);
    const idField = target.type === "post" ? { post_id: target.id } : { comment_id: target.id };
    if (input.action === "like" || input.action === "unlike") {
      await this.call(account, auth, "POST", `/${target.type}/like`, { json: { ...idField, score: input.action === "like" ? 1 : 0 }, writing: true, what: input.action });
    } else if (input.action === "delete") {
      await this.call(account, auth, "POST", `/${target.type}/delete`, { json: { ...idField, deleted: true }, writing: true, what: "delete" });
    } else {
      throw new ConnectorError(`lemmy moderate: ${input.action} is not supported (removing others' content needs moderator tools)`, "rejected", false);
    }
  }

  // ---- listen -------------------------------------------------------------------------------

  /**
   * Mentions (/user/mention), replies to our posts and comments (/user/replies, read or unread), and new posts in the
   * watched communities (/post/list sort=New) as "message" items whose conversation is the community.
   */
  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    const auth = parseAuth(account);
    const host = auth.host;
    const out: ActivityInput[] = [];
    const seen = new Set<string>();
    const push = (a: ActivityInput) => {
      if (seen.has(a.externalId)) return;
      seen.add(a.externalId);
      out.push(a);
    };
    for (const v of await this.pages<LemmyCommentView>(account, auth, "/user/mention", "mentions", {}, (v) => v.person_mention?.published ?? v.comment.published, since)) {
      push(commentActivity(host, v, "mention"));
    }
    for (const v of await this.pages<LemmyCommentView>(account, auth, "/user/replies", "replies", {}, (v) => v.comment_reply?.published ?? v.comment.published, since)) {
      const depth = v.comment.path.split(".").length - 1;
      push(commentActivity(host, v, depth <= 1 ? "comment" : "reply"));
    }
    for (const c of communitiesOf(account)) {
      for (const v of await this.pages<LemmyPostView>(account, auth, "/post/list", "posts", { community_id: String(c.id), type_: "All" }, (v) => v.post.published, since)) {
        push(postActivity(host, v, v.creator.id === auth.personId ? "own_post" : "message", c));
      }
    }
    return out.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  }

  /** Newest-first pages (sort=New) until an item predates `since`. */
  private async pages<T>(account: AccountRef, auth: LemmyAuth, path: string, field: string, query: Record<string, string>, time: (v: T) => string, since: Date | null): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= this.maxPages; page++) {
      const res = (await this.call(account, auth, "GET", path, { query: { ...query, sort: "New", limit: "50", page: String(page), ...(path.startsWith("/user/") ? { unread_only: "false" } : {}) }, what: path })) as Record<string, unknown> | undefined;
      const items = (Array.isArray(res?.[field]) ? res[field] : []) as T[];
      let older = false;
      for (const it of items) {
        if (!isAfter(lemmyTime(time(it)), since)) {
          older = true;
          continue;
        }
        out.push(it);
      }
      if (older || items.length < 50) break;
    }
    return out;
  }

  // ---- measure ------------------------------------------------------------------------------

  /** Upvotes, comments and votes per post (or comment). Lemmy exposes no views. */
  async fetchMetrics(account: AccountRef, externalIds: string[]): Promise<MetricInput[]> {
    if (externalIds.length === 0) return [];
    const auth = parseAuth(account);
    const observedAt = this.now().toISOString();
    const out: MetricInput[] = [];
    for (const ext of externalIds) {
      const t = parseLemmyId(ext);
      let counts: { upvotes?: number; downvotes?: number; comments?: number; child_count?: number } | undefined;
      try {
        const res = (await this.call(account, auth, "GET", `/${t.type}`, { query: { id: String(t.id) }, what: t.type })) as { post_view?: LemmyPostView; comment_view?: LemmyCommentView };
        counts = t.type === "post" ? res?.post_view?.counts : res?.comment_view?.counts;
      } catch (err) {
        const cause = err instanceof ConnectorError ? (err.cause as { status?: number; code?: string } | undefined) : undefined;
        if (cause?.status === 404 || (cause?.code ?? "").startsWith("couldnt_find")) continue;
        throw err;
      }
      if (!counts) continue;
      const up = counts.upvotes ?? 0;
      const down = counts.downvotes ?? 0;
      const replies = (t.type === "post" ? counts.comments : counts.child_count) ?? 0;
      const row = (metric: MetricName, value: number): MetricInput => ({ entityType: "post_variant", entityId: ext, metric, value, observedAt, source: "lemmy" });
      out.push(row("likes", up), row("replies", replies), row("engagements", up + down + replies));
    }
    return out;
  }

  // ---- transport ----------------------------------------------------------------------------

  private baseOf(account: AccountRef): string {
    return typeof account.config.apiBase === "string" && account.config.apiBase ? normalizeBase(account.config.apiBase) : this.apiBase;
  }

  private jwtOf(account: AccountRef, auth: LemmyAuth): string {
    return this.jwts.get(account.id) ?? auth.jwt;
  }

  /** Authenticated call; on 401 / not_logged_in, logs in again with the stored credentials once and retries. */
  private async call(account: AccountRef, auth: LemmyAuth, method: string, path: string, opts: RequestOpts): Promise<unknown> {
    const full = opts.absolute ? path : `${this.baseOf(account)}${path}`;
    try {
      return await this.request(auth.host, this.jwtOf(account, auth), method, full, opts);
    } catch (err) {
      const cause = err instanceof ConnectorError ? (err.cause as { status?: number; code?: string } | undefined) : undefined;
      if (!(cause?.status === 401 || cause?.code === "not_logged_in")) throw err;
      const jwt = await this.login(auth.host, this.baseOf(account), auth.usernameOrEmail, auth.password);
      this.jwts.set(account.id, jwt);
      return this.request(auth.host, jwt, method, full, opts);
    }
  }

  private async request(host: string, jwt: string | null, method: string, path: string, opts: RequestOpts): Promise<unknown> {
    const url = new URL(`https://${host}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { accept: "application/json" };
    if (jwt) headers.authorization = `Bearer ${jwt}`;
    let body: string | FormData | undefined;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.form) body = opts.form;
    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(url.toString(), { method, headers, body });
    } catch (err) {
      throw asNetworkError(err, `lemmy ${opts.what} (${host})`);
    }
    const data = await readJson(res);
    if (!res.ok) throw mapLemmyError(res.status, data, opts.what, opts.writing ?? false);
    return data;
  }
}

interface RequestOpts {
  what: string;
  query?: Record<string, string>;
  json?: unknown;
  form?: FormData;
  writing?: boolean;
  /** Path is from the host root (pict-rs), not under the API base. */
  absolute?: boolean;
}

function normalizeBase(base: string): string {
  return `/${base.trim().replace(/^\/+|\/+$/g, "")}`;
}

function parseAuth(account: AccountRef): LemmyAuth {
  const host = account.config.host;
  const parsed = LemmyAuth.safeParse({ ...(typeof host === "string" ? { host } : {}), ...(account.auth ?? {}) });
  if (!parsed.success) throw new ConnectorError(`lemmy account ${account.handle}: auth blob needs host, usernameOrEmail, password, jwt and personId`, "auth", false, parsed.error);
  return parsed.data;
}

function communitiesOf(account: AccountRef): LemmyCommunityRef[] {
  const raw = account.config.communities;
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is LemmyCommunityRef => typeof c === "object" && c !== null && typeof (c as LemmyCommunityRef).id === "number" && typeof (c as LemmyCommunityRef).name === "string");
}

function identityOf(host: string, p: LemmyPerson): AccountIdentity {
  return { externalId: `${p.id}@${host}`, handle: `@${p.name}@${host}`, displayName: p.display_name || null };
}

function communityName(c: LemmyCommunity): string {
  try {
    return `${c.name}@${new URL(c.actor_id).host}`;
  } catch {
    return c.name;
  }
}

function commentActivity(host: string, v: LemmyCommentView, kind: ActivityKind): ActivityInput {
  const ancestry = v.comment.path.split(".").slice(1);
  const parentComment = ancestry.length >= 2 ? Number(ancestry[ancestry.length - 2]) : null;
  return {
    network: "lemmy",
    kind,
    externalId: commentId(v.comment.id, host),
    authorHandle: actorHandle(v.creator.actor_id, v.creator.name),
    authorName: v.creator.display_name || null,
    text: v.comment.content,
    url: `https://${host}/comment/${v.comment.id}`,
    parentExternalId: parentComment !== null && Number.isFinite(parentComment) ? commentId(parentComment, host) : postId(v.comment.post_id, host),
    occurredAt: lemmyTime(v.comment.published),
    raw: v,
    conversation: { id: communityName(v.community), name: v.community.title ?? v.community.name, type: "group" },
  };
}

function postActivity(host: string, v: LemmyPostView, kind: ActivityKind, c: LemmyCommunityRef): ActivityInput {
  return {
    network: "lemmy",
    kind,
    externalId: postId(v.post.id, host),
    authorHandle: actorHandle(v.creator.actor_id, v.creator.name),
    authorName: v.creator.display_name || null,
    text: [v.post.name, v.post.url ?? null, v.post.body ?? null].filter(Boolean).join("\n\n"),
    url: `https://${host}/post/${v.post.id}`,
    parentExternalId: null,
    occurredAt: lemmyTime(v.post.published),
    raw: v,
    conversation: { id: c.name, name: c.title ?? v.community.title ?? null, type: "group" },
  };
}

export function createLemmyConnectors(env: NodeJS.ProcessEnv): Connector[] {
  return [new LemmyConnector(env.LEMMY_API_BASE ? { apiBase: env.LEMMY_API_BASE } : {})];
}
