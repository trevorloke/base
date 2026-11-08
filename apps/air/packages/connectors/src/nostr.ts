import { randomBytes } from "node:crypto";
import type { ActivityInput, ActivityKind, MetricInput, MetricName, Network } from "@base-air/schema";
import { z } from "zod";
import { IdempotencyCache } from "./idempotency.ts";
import { bytesToHex, finalizeEvent, getPublicKey, hexToBytes, neventEncode, nip19Decode, npubEncode, parseSecretKey, verifyEvent, type NostrEvent } from "./nostr-crypto.ts";
import type { AccountIdentity, AccountRef, ConnectedAccount, Connector, ConnectorCapabilities, MediaFetcher, ModerationInput, PublishInput, PublishResult, ValidationIssue } from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * Nostr over relays (NIP-01) with keys the person owns.
 *
 * There is no server account, no OAuth and no app review: an account is a secp256k1 key pair. The person pastes their
 * secret key (nsec or hex) and optionally the relays they write to. Notes are kind-1 events signed with BIP-340
 * Schnorr (nostr-crypto.ts), sent as ["EVENT", ev] to every relay; a publish succeeds when at least one relay answers
 * ["OK", id, true, ...]. Reading opens a REQ subscription, collects events until EOSE (or a timeout) and closes it.
 * Every event read from a relay is checked (id hash + signature) and dropped when invalid.
 *
 * Media is pull-style: Nostr has no upload in the core protocol (NIP-96 / Blossom servers are separate), so public
 * base air media URLs go into the content with NIP-92 `imeta` tags.
 */

// TODO(verify): a sensible default write/read set as of November 2026. These are long-running, free, open relays.
export const DEFAULT_NOSTR_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"] as const;

const HEX64 = /^[0-9a-f]{64}$/;

export const NostrAuth = z.object({
  /** 32-byte secret key, hex. */
  secretKey: z.string().regex(HEX64),
  /** x-only public key, hex. */
  pubkey: z.string().regex(HEX64),
});
export type NostrAuth = z.infer<typeof NostrAuth>;

/** The subset of the WHATWG WebSocket the relay client uses (Node 22's global WebSocket fits). */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
}
export type WebSocketFactory = (url: string) => WebSocketLike;

export interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  [tag: `#${string}`]: string[] | undefined;
}

export interface RelayResult {
  relay: string;
  ok: boolean;
  message: string;
}

export interface NostrConnectorOptions {
  webSocketFactory?: WebSocketFactory;
  now?: () => Date;
  /** Relays used when the person gives none. */
  defaultRelays?: readonly string[];
  connectTimeoutMs?: number;
  /** How long to wait for ["OK", ...] after sending an event. */
  okTimeoutMs?: number;
  /** How long a REQ may run before we stop waiting for EOSE. */
  queryTimeoutMs?: number;
  /** Allow ws:// and private hosts as relays (tests and local relays only). */
  allowPrivateRelays?: boolean;
  /** Fixed aux randomness for deterministic signatures in tests. */
  auxRand?: () => Uint8Array;
}

// ---- relay client ---------------------------------------------------------------------------

function messageText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return null;
}

/** One relay connection: opens lazily, matches OK replies by event id and subscriptions by id. */
export class RelayConnection {
  private ws: WebSocketLike | null = null;
  private opening: Promise<void> | null = null;
  private readonly okWaiters = new Map<string, (r: { ok: boolean; message: string }) => void>();
  private readonly subs = new Map<string, { onEvent(ev: unknown): void; onEnd(reason: string | null): void }>();

  constructor(
    readonly url: string,
    private readonly factory: WebSocketFactory,
    private readonly timeouts: { connect: number; ok: number; query: number },
  ) {}

  private open(): Promise<void> {
    if (this.opening) return this.opening;
    this.opening = new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => {
        settle(new Error("connect timeout"));
        this.close();
      }, this.timeouts.connect);
      let ws: WebSocketLike;
      try {
        ws = this.factory(this.url);
      } catch (err) {
        settle(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.ws = ws;
      ws.onopen = () => settle();
      ws.onerror = () => {
        settle(new Error("connection error"));
        this.failAll("connection error");
      };
      ws.onclose = () => {
        settle(new Error("connection closed"));
        this.failAll("connection closed");
      };
      ws.onmessage = (m) => this.onMessage(m.data);
    });
    return this.opening;
  }

  private onMessage(data: unknown): void {
    const text = messageText(data);
    if (!text) return;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!Array.isArray(msg) || typeof msg[0] !== "string") return;
    const [type, a, b, c] = msg as [string, unknown, unknown, unknown];
    if (type === "OK" && typeof a === "string") this.okWaiters.get(a)?.({ ok: b === true, message: typeof c === "string" ? c : "" });
    else if (type === "EVENT" && typeof a === "string") this.subs.get(a)?.onEvent(b);
    else if (type === "EOSE" && typeof a === "string") this.subs.get(a)?.onEnd(null);
    else if (type === "CLOSED" && typeof a === "string") this.subs.get(a)?.onEnd(typeof b === "string" && b ? b : "closed");
    // NOTICE and AUTH (NIP-42) are ignored. TODO(verify): relays that require AUTH for writes will answer
    // "auth-required:" and count as a refusal.
  }

  private failAll(reason: string): void {
    for (const w of [...this.okWaiters.values()]) w({ ok: false, message: `connection failed: ${reason}` });
    for (const s of [...this.subs.values()]) s.onEnd(reason);
  }

  private send(msg: unknown[]): void {
    if (!this.ws) throw new Error("not connected");
    this.ws.send(JSON.stringify(msg));
  }

  async publish(ev: NostrEvent): Promise<RelayResult> {
    try {
      await this.open();
    } catch (err) {
      return { relay: this.url, ok: false, message: `connection failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    return new Promise<RelayResult>((resolve) => {
      const done = (r: { ok: boolean; message: string }) => {
        clearTimeout(timer);
        this.okWaiters.delete(ev.id);
        resolve({ relay: this.url, ...r });
      };
      const timer = setTimeout(() => done({ ok: false, message: "timeout: no OK from relay" }), this.timeouts.ok);
      this.okWaiters.set(ev.id, done);
      try {
        this.send(["EVENT", ev]);
      } catch (err) {
        done({ ok: false, message: `connection failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    });
  }

  /** REQ until EOSE / CLOSED / timeout. `answered` is false when the relay was unreachable or refused the query. */
  async query(filters: NostrFilter[]): Promise<{ events: unknown[]; answered: boolean; message?: string }> {
    try {
      await this.open();
    } catch (err) {
      return { events: [], answered: false, message: `connection failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    const subId = bytesToHex(new Uint8Array(randomBytes(8)));
    return new Promise((resolve) => {
      const events: unknown[] = [];
      const finish = (answered: boolean, message?: string) => {
        clearTimeout(timer);
        if (!this.subs.delete(subId)) return;
        try {
          this.send(["CLOSE", subId]);
        } catch {
          // connection already gone
        }
        resolve({ events, answered, ...(message ? { message } : {}) });
      };
      // A slow relay that sent events but no EOSE still answered; one that sent nothing did not.
      const timer = setTimeout(() => finish(events.length > 0, events.length > 0 ? undefined : "timeout: no EOSE from relay"), this.timeouts.query);
      this.subs.set(subId, { onEvent: (e) => events.push(e), onEnd: (reason) => finish(reason === null || events.length > 0, reason ?? undefined) });
      try {
        this.send(["REQ", subId, ...filters]);
      } catch (err) {
        finish(false, `connection failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    this.failAll("closed by client");
    try {
      ws?.close();
    } catch {
      // ignore
    }
  }
}

/** A set of relays used for one operation; always `close()` it. */
export class RelayPool {
  private readonly conns = new Map<string, RelayConnection>();
  constructor(
    readonly relays: readonly string[],
    private readonly factory: WebSocketFactory,
    private readonly timeouts: { connect: number; ok: number; query: number },
  ) {}

  private conn(url: string): RelayConnection {
    let c = this.conns.get(url);
    if (!c) {
      c = new RelayConnection(url, this.factory, this.timeouts);
      this.conns.set(url, c);
    }
    return c;
  }

  publish(ev: NostrEvent): Promise<RelayResult[]> {
    return Promise.all(this.relays.map((r) => this.conn(r).publish(ev)));
  }

  /** Union of every relay's answer, deduplicated by id, with invalid ids/signatures dropped. */
  async query(filters: NostrFilter[]): Promise<{ events: NostrEvent[]; answered: number; failures: { relay: string; message: string }[]; dropped: number }> {
    const results = await Promise.all(this.relays.map(async (r) => ({ relay: r, ...(await this.conn(r).query(filters)) })));
    const byId = new Map<string, NostrEvent>();
    let dropped = 0;
    for (const res of results) {
      for (const raw of res.events) {
        const id = (raw as { id?: unknown } | null)?.id;
        if (typeof id === "string" && byId.has(id)) continue;
        if (!verifyEvent(raw)) {
          dropped++;
          continue;
        }
        byId.set(raw.id, raw);
      }
    }
    return {
      events: [...byId.values()],
      answered: results.filter((r) => r.answered).length,
      failures: results.filter((r) => !r.answered).map((r) => ({ relay: r.relay, message: r.message ?? "no answer" })),
      dropped,
    };
  }

  close(): void {
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
  }
}

/** All relays refused or failed: rate limits are retryable, refusals are not, transport trouble is. */
export function classifyRelayFailures(results: RelayResult[], what: string): ConnectorError {
  const detail = results.map((r) => `${r.relay}: ${r.message || "refused"}`).join("; ");
  const msg = `nostr ${what}: no relay accepted the event (${detail})`;
  const prefix = (m: string) => m.split(":")[0]?.trim() ?? "";
  if (results.length === 0) return new ConnectorError(`nostr ${what}: no relays configured`, "rejected", false);
  if (results.some((r) => prefix(r.message) === "rate-limited")) return new ConnectorError(msg, "rate_limit", true, { relays: results });
  if (results.some((r) => ["connection failed", "timeout", "error"].includes(prefix(r.message)))) return new ConnectorError(msg, "network", true, { relays: results });
  if (results.every((r) => prefix(r.message) === "auth-required")) return new ConnectorError(msg, "auth", false, { relays: results });
  return new ConnectorError(msg, "rejected", false, { relays: results });
}

// ---- helpers --------------------------------------------------------------------------------

/** Normalize one relay URL; refuses non-wss and private hosts unless allowed (relays are dialed server-side). */
export function normalizeRelayUrl(input: string, allowPrivate = false): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new ConnectorError(`nostr: "${input}" is not a relay URL (wss://...)`, "rejected", false);
  }
  if (u.protocol !== "wss:" && !(allowPrivate && u.protocol === "ws:")) throw new ConnectorError(`nostr: relay "${input}" must use wss://`, "rejected", false);
  const host = u.hostname.toLowerCase();
  const privateHost = !host.includes(".") || /^(localhost|.*\.local|.*\.internal|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[");
  if (privateHost && !allowPrivate) throw new ConnectorError(`nostr: relay "${host}" is not a public host`, "rejected", false);
  const s = u.toString();
  return u.pathname === "/" && !u.search ? s.replace(/\/$/, "") : s;
}

export function parseRelayList(input: string | undefined, fallback: readonly string[], allowPrivate = false): string[] {
  const parts = (input ?? "").split(/[\s,]+/).filter(Boolean);
  const list = parts.length > 0 ? parts : [...fallback];
  return [...new Set(list.map((r) => normalizeRelayUrl(r, allowPrivate)))];
}

/** Hex event id from hex, note1 or nevent1. */
export function parseEventId(input: string): string {
  const s = input.trim();
  if (HEX64.test(s.toLowerCase())) return s.toLowerCase();
  try {
    const d = nip19Decode(s);
    if (d.type === "note") return d.data;
    if (d.type === "nevent") return d.data.id;
  } catch {
    // fall through
  }
  throw new ConnectorError(`nostr: "${input}" is not an event id`, "rejected", false);
}

export function njumpUrl(id: string, author?: string): string {
  return `https://njump.me/${neventEncode({ id, ...(author ? { author } : {}) })}`;
}

/** NIP-10: the root and the direct parent of a kind-1 event (marked tags first, then deprecated positional tags). */
export function threadRefs(ev: Pick<NostrEvent, "tags">): { root: string[] | null; reply: string[] | null } {
  const es = ev.tags.filter((t) => t[0] === "e" && typeof t[1] === "string" && HEX64.test(t[1]));
  const marked = es.filter((t) => t[3] === "root" || t[3] === "reply");
  if (marked.length > 0) {
    const root = marked.find((t) => t[3] === "root") ?? null;
    const reply = marked.find((t) => t[3] === "reply") ?? root;
    return { root, reply };
  }
  const positional = es.filter((t) => t[3] !== "mention");
  if (positional.length === 0) return { root: null, reply: null };
  return { root: positional[0] ?? null, reply: positional[positional.length - 1] ?? null };
}

/** e/p tags for a kind-1 reply to `parent` per NIP-10 (root marker, reply marker, parent's p tags + author). */
export function replyTags(parent: Pick<NostrEvent, "id" | "pubkey" | "tags">, self: string, relayHint = ""): string[][] {
  const { root } = threadRefs(parent);
  const tags: string[][] = [];
  if (!root || root[1] === parent.id) {
    tags.push(["e", parent.id, relayHint, "root", parent.pubkey]);
  } else {
    const rootId = root[1] ?? "";
    const rootPubkey = root[4] && HEX64.test(root[4]) ? root[4] : undefined;
    tags.push(["e", rootId, root[2] ?? "", "root", ...(rootPubkey ? [rootPubkey] : [])]);
    tags.push(["e", parent.id, relayHint, "reply", parent.pubkey]);
  }
  const ps = new Set<string>();
  if (parent.pubkey !== self) ps.add(parent.pubkey);
  for (const t of parent.tags) if (t[0] === "p" && t[1] && HEX64.test(t[1]) && t[1] !== self) ps.add(t[1]);
  for (const p of ps) tags.push(["p", p]);
  return tags;
}

/** NIP-92 imeta tag for a media item. */
function imetaTag(m: PublishInput["media"][number]): string[] {
  const t = ["imeta", `url ${m.url}`];
  if (m.mime) t.push(`m ${m.mime}`);
  if (m.width && m.height) t.push(`dim ${m.width}x${m.height}`);
  if (m.alt) t.push(`alt ${m.alt.replace(/\s+/g, " ").slice(0, 1000)}`);
  // NIP-92 requires a url plus at least one more field.
  if (t.length === 2) t.push(`m ${m.kind === "video" ? "video/mp4" : m.kind === "gif" ? "image/gif" : "image/jpeg"}`);
  return t;
}

interface ProgressState {
  /** Signed events in segment order; a retry resends the same signed event, so relays answer "duplicate:". */
  events: NostrEvent[];
  accepted: number;
  relays: RelayResult[][];
}

// ---- connector -------------------------------------------------------------------------------

export class NostrConnector implements Connector {
  readonly name = "nostr";
  readonly networks: readonly Network[] = ["nostr"];
  readonly connectMethod = "api_key" as const;
  readonly connectConfigured = true;
  readonly credentialInputs = [
    { key: "secretKey", label: "Secret key (nsec)", placeholder: "nsec1... or 64 hex characters", secret: true },
    { key: "relays", label: "Relays (comma-separated)", placeholder: "wss://relay.damus.io, wss://nos.lol", optional: true },
  ] as const;
  media?: MediaFetcher;

  private readonly factory: WebSocketFactory;
  private readonly now: () => Date;
  private readonly defaultRelays: readonly string[];
  private readonly timeouts: { connect: number; ok: number; query: number };
  private readonly allowPrivateRelays: boolean;
  private readonly auxRand: (() => Uint8Array) | undefined;
  private readonly idempotency = new IdempotencyCache<PublishResult>();
  private readonly progress = new Map<string, ProgressState>();

  constructor(opts: NostrConnectorOptions = {}) {
    this.factory =
      opts.webSocketFactory ??
      ((url) => {
        const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
        if (!Ctor) throw new Error("this runtime has no global WebSocket (Node 22+ is required)");
        return new Ctor(url);
      });
    this.now = opts.now ?? (() => new Date());
    this.defaultRelays = opts.defaultRelays && opts.defaultRelays.length > 0 ? opts.defaultRelays : DEFAULT_NOSTR_RELAYS;
    this.timeouts = { connect: opts.connectTimeoutMs ?? 5000, ok: opts.okTimeoutMs ?? 8000, query: opts.queryTimeoutMs ?? 8000 };
    this.allowPrivateRelays = opts.allowPrivateRelays ?? false;
    this.auxRand = opts.auxRand;
  }

  capabilities(): ConnectorCapabilities {
    // Post metrics are counts seen on the configured relays (a lower bound). No follower count: see fetchAccountMetrics.
    return { publish: true, fetchActivity: true, fetchMetrics: true, meteredReads: false, reply: true, moderate: true, accountMetrics: false, webhooks: false, video: true, kinds: ["post", "video"] };
  }

  // ---- connect ------------------------------------------------------------------------------

  async connectWithInputs(p: { network: Network; inputs: Record<string, string> }): Promise<ConnectedAccount[]> {
    let secretKey: string;
    try {
      secretKey = parseSecretKey(p.inputs.secretKey ?? "");
    } catch (err) {
      throw new ConnectorError(`nostr: that is not a valid secret key (${err instanceof Error ? err.message : String(err)})`, "auth", false);
    }
    const relays = parseRelayList(p.inputs.relays, this.defaultRelays, this.allowPrivateRelays);
    const pubkey = bytesToHex(getPublicKey(hexToBytes(secretKey)));
    const profile = await this.fetchProfile(relays, pubkey).catch(() => null);
    const npub = npubEncode(pubkey);
    return [{ network: "nostr", identity: { externalId: pubkey, handle: npub, displayName: profile?.name ?? null }, auth: { secretKey, pubkey }, config: { relays, npub } }];
  }

  async describeAccount(auth: Record<string, unknown>): Promise<AccountIdentity> {
    const raw = typeof auth.secretKey === "string" ? auth.secretKey : "";
    let secretKey: string;
    try {
      secretKey = parseSecretKey(raw);
    } catch {
      throw new ConnectorError("nostr: secretKey is required", "auth", false);
    }
    const pubkey = bytesToHex(getPublicKey(hexToBytes(secretKey)));
    const relays = Array.isArray(auth.relays) ? auth.relays.filter((r): r is string => typeof r === "string") : [...this.defaultRelays];
    const profile = await this.fetchProfile(relays, pubkey).catch(() => null);
    return { externalId: pubkey, handle: npubEncode(pubkey), displayName: profile?.name ?? null };
  }

  /** Keys do not expire. */
  async refreshAuth(): Promise<null> {
    return null;
  }

  /** Newest kind-0 metadata (NIP-01) for display names. Best effort. */
  private async fetchProfile(relays: readonly string[], pubkey: string): Promise<{ name: string | null } | null> {
    const pool = this.pool(relays);
    try {
      const { events } = await pool.query([{ kinds: [0], authors: [pubkey], limit: 1 }]);
      return profileName(events, pubkey);
    } finally {
      pool.close();
    }
  }

  // ---- publish ------------------------------------------------------------------------------

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (input.options?.poll) issues.push({ code: "unsupported_media", message: "nostr polls (NIP-88) are not supported by most clients; post the question as text" });
    if (!input.text.trim() && input.media.length === 0) issues.push({ code: "empty", message: "nostr notes need text or media", segment: 0 });
    input.thread.forEach((t, i) => {
      if (!t.trim()) issues.push({ code: "empty", message: "empty thread segment", segment: i + 1 });
    });
    return issues;
  }

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, () => this.publishSegments(account, input));
  }

  private async publishSegments(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    const auth = parseAuth(account);
    const relays = this.relaysOf(account);
    const key = input.idempotencyKey;
    const state = this.progress.get(key) ?? { events: [], accepted: 0, relays: [] };
    this.progress.set(key, state);
    const segments = [input.text, ...input.thread];
    const opts = input.options ?? {};
    const pool = this.pool(relays);
    try {
      let externalParent: NostrEvent | null = null;
      if (input.replyToExternalId && state.events.length === 0) externalParent = await this.findEvent(pool, parseEventId(input.replyToExternalId));
      for (let i = state.accepted; i < segments.length; i++) {
        let ev = state.events[i];
        if (!ev) {
          const tags: string[][] = [];
          let content = segments[i] ?? "";
          if (i === 0) {
            if (input.replyToExternalId) tags.push(...(externalParent ? replyTags(externalParent, auth.pubkey, relays[0]) : [["e", parseEventId(input.replyToExternalId), relays[0] ?? "", "root"]]));
            const media = input.media.filter((m) => m.url);
            if (media.length > 0) {
              content = [content.trim(), ...media.map((m) => m.url)].filter(Boolean).join("\n\n");
              tags.push(...media.map(imetaTag));
            }
          } else {
            const prev = state.events[i - 1];
            if (prev) tags.push(...replyTags(prev, auth.pubkey, relays[0]));
          }
          if (opts.contentWarning) tags.push(["content-warning", opts.contentWarning]);
          for (const t of opts.tags ?? []) {
            const tag = t.replace(/^#/, "").trim().toLowerCase();
            if (tag) tags.push(["t", tag]);
          }
          ev = this.sign(auth, { kind: 1, content, tags });
          state.events[i] = ev;
        }
        const results = await pool.publish(ev);
        state.relays[i] = results;
        if (!results.some((r) => r.ok)) throw classifyRelayFailures(results, `publish segment ${i}`);
        state.accepted = i + 1;
      }
    } catch (err) {
      const accepted = state.events.slice(0, state.accepted);
      const root = accepted[0];
      if (root) {
        const ce = err instanceof ConnectorError ? err : new ConnectorError(err instanceof Error ? err.message : String(err), "unknown", true, err);
        ce.partial = { externalId: root.id, url: njumpUrl(root.id, root.pubkey), threadExternalIds: accepted.map((e) => e.id) };
        throw ce;
      }
      throw err;
    } finally {
      pool.close();
    }
    const root = state.events[0];
    if (!root) throw new ConnectorError("nostr publish: nothing to post", "rejected", false);
    this.progress.delete(key);
    const ids = state.events.map((e) => e.id);
    return { externalId: root.id, url: njumpUrl(root.id, root.pubkey), ...(input.thread.length > 0 ? { threadExternalIds: ids } : {}), raw: { events: state.events, relays: state.relays } };
  }

  // ---- engage -------------------------------------------------------------------------------

  async reply(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const auth = parseAuth(account);
      const relays = this.relaysOf(account);
      const parentId = parseEventId(input.parentExternalId);
      const pool = this.pool(relays);
      try {
        const parent = await this.findEvent(pool, parentId);
        const tags = parent ? replyTags(parent, auth.pubkey, relays[0]) : [["e", parentId, relays[0] ?? "", "root"]];
        const ev = this.sign(auth, { kind: 1, content: input.text, tags });
        const results = await pool.publish(ev);
        if (!results.some((r) => r.ok)) throw classifyRelayFailures(results, "reply");
        return { externalId: ev.id, url: njumpUrl(ev.id, ev.pubkey), raw: { event: ev, relays: results } };
      } finally {
        pool.close();
      }
    });
  }

  /**
   * like = kind-7 "+" reaction (NIP-25); unlike = kind-5 deletion of our reactions to it; delete = kind-5 deletion
   * (NIP-09) of one of our own events. Relays only honor deletions signed by the event's author, and some keep the
   * event anyway: deletion is a request, not a guarantee.
   */
  async moderate(account: AccountRef, input: ModerationInput): Promise<void> {
    if (input.action === "hide" || input.action === "unhide") throw new ConnectorError(`nostr moderate: ${input.action} is not supported (Nostr has no per-reply hide; mute lists are client-side)`, "rejected", false);
    const auth = parseAuth(account);
    const relays = this.relaysOf(account);
    const id = parseEventId(input.externalId);
    const pool = this.pool(relays);
    try {
      let ev: NostrEvent | null = null;
      if (input.action === "like") {
        const target = await this.findEvent(pool, id);
        const tags: string[][] = [["e", id, relays[0] ?? "", ...(target ? [target.pubkey] : [])]];
        if (target) tags.push(["p", target.pubkey], ["k", String(target.kind)]);
        ev = this.sign(auth, { kind: 7, content: "+", tags });
      } else if (input.action === "unlike") {
        const { events } = await pool.query([{ kinds: [7], authors: [auth.pubkey], "#e": [id] }]);
        const mine = events.filter((e) => e.pubkey === auth.pubkey);
        if (mine.length === 0) return;
        ev = this.sign(auth, { kind: 5, content: "", tags: [...mine.map((e) => ["e", e.id]), ["k", "7"]] });
      } else {
        const target = await this.findEvent(pool, id);
        if (target && target.pubkey !== auth.pubkey) throw new ConnectorError("nostr moderate: only the account's own events can be deleted", "rejected", false);
        ev = this.sign(auth, { kind: 5, content: "", tags: [["e", id], ["k", String(target?.kind ?? 1)]] });
      }
      const results = await pool.publish(ev);
      if (!results.some((r) => r.ok)) throw classifyRelayFailures(results, input.action);
    } finally {
      pool.close();
    }
  }

  // ---- listen -------------------------------------------------------------------------------

  /**
   * Kind-1 notes, reposts (6) and reactions (7) that tag the account (#p) or reference one of its recent notes (#e),
   * since `since`. Signatures are verified and events are deduplicated across relays.
   */
  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    const auth = parseAuth(account);
    const pool = this.pool(this.relaysOf(account));
    try {
      const sinceSec = since ? Math.floor(since.getTime() / 1000) : undefined;
      const own = await pool.query([{ kinds: [1], authors: [auth.pubkey], limit: 50 }]);
      const ownIds = new Set(own.events.filter((e) => e.pubkey === auth.pubkey).map((e) => e.id));
      const window = sinceSec !== undefined ? { since: sinceSec } : {};
      const filters: NostrFilter[] = [{ kinds: [1, 6, 7], "#p": [auth.pubkey], ...window, limit: 200 }];
      if (ownIds.size > 0) filters.push({ kinds: [1, 6, 7], "#e": [...ownIds], ...window, limit: 200 });
      const res = await pool.query(filters);
      if (res.answered === 0 && own.answered === 0) throw new ConnectorError(`nostr fetchActivity: no relay answered (${res.failures.map((f) => `${f.relay}: ${f.message}`).join("; ")})`, "network", true, res.failures);
      const events = res.events.filter((e) => e.pubkey !== auth.pubkey && (sinceSec === undefined || e.created_at > sinceSec));
      const names = await this.profileNames(pool, [...new Set(events.map((e) => e.pubkey))]);
      const out: ActivityInput[] = [];
      for (const ev of events) {
        const item = nostrEventToActivity(ev, auth.pubkey, ownIds, names.get(ev.pubkey) ?? null);
        if (item) out.push(item);
      }
      return out.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
    } finally {
      pool.close();
    }
  }

  private async profileNames(pool: RelayPool, pubkeys: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (pubkeys.length === 0) return out;
    const { events } = await pool.query([{ kinds: [0], authors: pubkeys.slice(0, 100) }]);
    for (const pk of pubkeys) {
      const p = profileName(events, pk);
      if (p?.name) out.set(pk, p.name);
    }
    return out;
  }

  // ---- measure ------------------------------------------------------------------------------

  /** Replies, reactions and reposts seen on the configured relays: a lower bound, Nostr has no global counter. */
  async fetchMetrics(account: AccountRef, externalIds: string[]): Promise<MetricInput[]> {
    if (externalIds.length === 0) return [];
    const ids = externalIds.map(parseEventId);
    const pool = this.pool(this.relaysOf(account));
    try {
      const res = await pool.query([{ kinds: [1, 6, 7], "#e": ids, limit: 1000 }]);
      if (res.answered === 0) throw new ConnectorError(`nostr fetchMetrics: no relay answered (${res.failures.map((f) => `${f.relay}: ${f.message}`).join("; ")})`, "network", true, res.failures);
      const observedAt = this.now().toISOString();
      const out: MetricInput[] = [];
      ids.forEach((id, idx) => {
        const entityId = externalIds[idx] ?? id;
        let likes = 0;
        let reposts = 0;
        let replies = 0;
        for (const ev of res.events) {
          const refs = ev.tags.filter((t) => t[0] === "e" && t[1] === id);
          if (refs.length === 0) continue;
          if (ev.kind === 7) {
            const target = [...ev.tags].reverse().find((t) => t[0] === "e")?.[1];
            if (target === id && ev.content !== "-") likes++;
          } else if (ev.kind === 6) reposts++;
          else if (ev.kind === 1 && refs.some((t) => t[3] !== "mention")) replies++;
        }
        const row = (metric: MetricName, value: number): MetricInput => ({ entityType: "post_variant", entityId, metric, value, observedAt, source: "nostr" });
        out.push(row("likes", likes), row("reposts", reposts), row("replies", replies), row("engagements", likes + reposts + replies));
      });
      return out;
    } finally {
      pool.close();
    }
  }

  // No fetchAccountMetrics: followers are other people's kind-3 contact lists spread over every relay; counting them
  // needs a network-wide index, and any count from a few relays would be an arbitrary undercount.

  // ---- internals ----------------------------------------------------------------------------

  private pool(relays: readonly string[]): RelayPool {
    return new RelayPool(relays, this.factory, this.timeouts);
  }

  private relaysOf(account: AccountRef): string[] {
    const cfg = account.config.relays;
    const list = Array.isArray(cfg) ? cfg.filter((r): r is string => typeof r === "string") : [];
    return parseRelayList(list.join(","), this.defaultRelays, this.allowPrivateRelays);
  }

  private sign(auth: NostrAuth, t: { kind: number; content: string; tags: string[][] }): NostrEvent {
    return finalizeEvent({ ...t, created_at: Math.floor(this.now().getTime() / 1000) }, hexToBytes(auth.secretKey), this.auxRand?.());
  }

  private async findEvent(pool: RelayPool, id: string): Promise<NostrEvent | null> {
    const { events } = await pool.query([{ ids: [id] }]);
    return events.find((e) => e.id === id) ?? null;
  }
}

function profileName(events: NostrEvent[], pubkey: string): { name: string | null } | null {
  const latest = events.filter((e) => e.kind === 0 && e.pubkey === pubkey).sort((a, b) => b.created_at - a.created_at)[0];
  if (!latest) return null;
  try {
    const meta = JSON.parse(latest.content) as { name?: unknown; display_name?: unknown; displayName?: unknown };
    const name = [meta.display_name, meta.displayName, meta.name].find((x): x is string => typeof x === "string" && x.trim().length > 0);
    return { name: name?.trim() ?? null };
  } catch {
    return { name: null };
  }
}

/** One verified relay event → activity, or null when it is not about the account. */
export function nostrEventToActivity(ev: NostrEvent, self: string, ownIds: Set<string>, authorName: string | null = null): ActivityInput | null {
  const base = { network: "nostr" as const, externalId: ev.id, authorHandle: npubEncode(ev.pubkey), authorName, occurredAt: new Date(ev.created_at * 1000).toISOString(), raw: ev };
  const tagsSelf = ev.tags.some((t) => t[0] === "p" && t[1] === self);
  if (ev.kind === 1) {
    const { reply } = threadRefs(ev);
    const target = reply?.[1] ?? null;
    let kind: ActivityKind;
    if (target && (ownIds.has(target) || reply?.[4] === self)) kind = "reply";
    else if (tagsSelf) kind = "mention";
    else if (target) kind = "comment";
    else return null;
    return { ...base, kind, text: ev.content, url: njumpUrl(ev.id, ev.pubkey), parentExternalId: target };
  }
  const target = [...ev.tags].reverse().find((t) => t[0] === "e" && t[1] && HEX64.test(t[1]))?.[1] ?? null;
  if (ev.kind === 7) {
    if (ev.content === "-") return null;
    if (!target || (!ownIds.has(target) && !tagsSelf)) return null;
    return { ...base, kind: "like", text: ev.content === "+" || ev.content === "" ? null : ev.content, url: njumpUrl(target), parentExternalId: target };
  }
  if (ev.kind === 6) {
    if (!target || (!ownIds.has(target) && !tagsSelf)) return null;
    return { ...base, kind: "repost", text: null, url: njumpUrl(target), parentExternalId: target };
  }
  return null;
}

function parseAuth(account: AccountRef): NostrAuth {
  const raw = account.auth ?? {};
  try {
    const secretKey = parseSecretKey(typeof raw.secretKey === "string" ? raw.secretKey : "");
    const pubkey = bytesToHex(getPublicKey(hexToBytes(secretKey)));
    if (typeof raw.pubkey === "string" && raw.pubkey !== pubkey) throw new Error("stored pubkey does not match the secret key");
    return { secretKey, pubkey };
  } catch (err) {
    throw new ConnectorError(`nostr account ${account.handle}: auth blob needs a valid secretKey (${err instanceof Error ? err.message : String(err)})`, "auth", false, err);
  }
}

export function createNostrConnectors(env: NodeJS.ProcessEnv): Connector[] {
  const relays = (env.NOSTR_DEFAULT_RELAYS ?? "").split(/[\s,]+/).filter(Boolean);
  return [new NostrConnector(relays.length > 0 ? { defaultRelays: relays } : {})];
}
