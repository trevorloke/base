import { describe, expect, it } from "vitest";
import { ConnectorError, type AccountRef, type PublishInput } from "../src/index.ts";
import {
  bech32Decode,
  bech32Encode,
  bytesToHex,
  finalizeEvent,
  getEventHash,
  getPublicKey,
  hexToBytes,
  neventEncode,
  nip19Decode,
  noteEncode,
  npubEncode,
  nsecEncode,
  parseSecretKey,
  schnorrSign,
  schnorrVerify,
  serializeEvent,
  verifyEvent,
  type NostrEvent,
} from "../src/nostr-crypto.ts";
import { NostrConnector, classifyRelayFailures, createNostrConnectors, nostrEventToActivity, normalizeRelayUrl, parseEventId, replyTags, threadRefs, type NostrFilter, type WebSocketLike } from "../src/nostr.ts";

// ---- BIP-340 official test vectors (bip-0340/test-vectors.csv) --------------------------------

const SIGN_VECTORS = [
  {
    sk: "0000000000000000000000000000000000000000000000000000000000000003",
    pk: "F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9",
    aux: "0000000000000000000000000000000000000000000000000000000000000000",
    msg: "0000000000000000000000000000000000000000000000000000000000000000",
    sig: "E907831F80848D1069A5371B402410364BDF1C5F8307B0084C55F1CE2DCA821525F66A4A85EA8B71E482A74F382D2CE5EBEEE8FDB2172F477DF4900D310536C0",
  },
  {
    sk: "B7E151628AED2A6ABF7158809CF4F3C762E7160F38B4DA56A784D9045190CFEF",
    pk: "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659",
    aux: "0000000000000000000000000000000000000000000000000000000000000001",
    msg: "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89",
    sig: "6896BD60EEAE296DB48A229FF71DFE071BDE413E6D43F917DC8DCF8C78DE33418906D11AC976ABCCB20B091292BFF4EA897EFCB639EA871CFA95F6DE339E4B0A",
  },
  {
    sk: "C90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B14E5C9",
    pk: "DD308AFEC5777E13121FA72B9CC1B7CC0139715309B086C960E18FD969774EB8",
    aux: "C87AA53824B4D7AE2EB035A2B5BBBCCC080E76CDC6D1692C4B0B62D798E6D906",
    msg: "7E2D58D8B3BCDF1ABADEC7829054F90DDA9805AAB56C77333024B9D0A508B75C",
    sig: "5831AAEED7B44BB74E5EAB94BA9D4294C49BCF2A60728D8B4C200F50DD313C1BAB745879A5AD954A72C45A91C3A51D3C7ADEA98D82F8481E0E1E03674A6F3FB7",
  },
  {
    sk: "0B432B2677937381AEF05BB02A66ECD012773062CF3FA2549E44F58ED2401710",
    pk: "25D1DFF95105F5253C4022F628A996AD3A0D95FBF21D468A1B33F8C160D8F517",
    aux: "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
    msg: "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
    sig: "7EB0509757E246F19449885651611CB965ECC1A187DD51B64FDA1EDC9637D5EC97582B9CB13DB3933705B32BA982AF5AF25FD78881EBB32771FC5922EFC66EA3",
  },
];

const VERIFY_VECTORS: { pk: string; msg: string; sig: string; ok: boolean; why: string }[] = [
  { pk: "D69C3509BB99E412E68B0FE8544E72837DFA30746D8BE2AA65975F29D22DC7B9", msg: "4DF3C3F68FCC83B27E9D42C90431A72499F17875C81A599B566C9889B9696703", sig: "00000000000000000000003B78CE563F89A0ED9414F5AA28AD0D96D6795F9C6376AFB1548AF603B3EB45C9F8207DEE1060CB71C04E80F593060B07D28308D7F4", ok: true, why: "vector 4" },
  { pk: "EEFDEA4CDB677750A420FEE807EACF21EB9898AE79B9768766E4FAA04A2D4A34", msg: "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89", sig: "6CFF5C3BA86C69EA4B7376F31A9BCB4F74C1976089B2D9963DA2E5543E17776969E89B4C5564D00349106B8497785DD7D1D713A8AE82B32FA79D5F7FC407D39B", ok: false, why: "public key not on the curve" },
  { pk: "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659", msg: "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89", sig: "FFF97BD5755EEEA420453A14355235D382F6472F8568A18B2F057A14602975563CC27944640AC607CD107AE10923D9EF7A73C643E166BE5EBEAFA34B1AC553E2", ok: false, why: "has_even_y(R) is false" },
  { pk: "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659", msg: "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89", sig: "1FA62E331EDBC21C394792D2AB1100A7B432B013DF3F6FF4F99FCB33E0E1515F28890B3EDB6E7189B630448B515CE4F8622A954CFE545735AAEA5134FCCDB2BD", ok: false, why: "negated message" },
  { pk: "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659", msg: "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89", sig: "6CFF5C3BA86C69EA4B7376F31A9BCB4F74C1976089B2D9963DA2E5543E177769961764B3AA9B2FFCB6EF947B6887A226E8D7C93E00C5ED0C1834FF0D0C2E6DA6", ok: false, why: "negated s value" },
  { pk: "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659", msg: "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89", sig: "0000000000000000000000000000000000000000000000000000000000000000123DDA8328AF9C23A94C1FEECFD123BA4FB73476F0D594DCB65C6425BD186051", ok: false, why: "sG - eP is infinite" },
];

describe("BIP-340 schnorr", () => {
  it.each(SIGN_VECTORS)("signs and verifies vector with pk $pk", (v) => {
    expect(bytesToHex(getPublicKey(hexToBytes(v.sk))).toUpperCase()).toBe(v.pk);
    const sig = schnorrSign(hexToBytes(v.msg), hexToBytes(v.sk), hexToBytes(v.aux));
    expect(bytesToHex(sig).toUpperCase()).toBe(v.sig);
    expect(schnorrVerify(sig, hexToBytes(v.msg), hexToBytes(v.pk))).toBe(true);
  });

  it.each(VERIFY_VECTORS)("verification: $why", (v) => {
    expect(schnorrVerify(hexToBytes(v.sig), hexToBytes(v.msg), hexToBytes(v.pk))).toBe(v.ok);
  });

  it("rejects malformed input and out-of-range keys", () => {
    expect(schnorrVerify(new Uint8Array(63), new Uint8Array(32), new Uint8Array(32))).toBe(false);
    expect(() => getPublicKey(new Uint8Array(32))).toThrow(/out of range/);
    expect(() => getPublicKey(hexToBytes("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141"))).toThrow(/out of range/);
  });
});

describe("bech32 / NIP-19", () => {
  // Examples from NIP-19.
  const NPUB = "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6";
  const PUBHEX = "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";
  const NSEC = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";
  const SECHEX = "67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa";

  it("encodes and decodes npub/nsec/note against the NIP-19 examples", () => {
    expect(npubEncode(PUBHEX)).toBe(NPUB);
    expect(nsecEncode(SECHEX)).toBe(NSEC);
    expect(nip19Decode(NPUB)).toEqual({ type: "npub", data: PUBHEX });
    expect(nip19Decode(NSEC)).toEqual({ type: "nsec", data: SECHEX });
    expect(nip19Decode(noteEncode(PUBHEX))).toEqual({ type: "note", data: PUBHEX });
  });

  it("round-trips arbitrary bytes and nevent TLVs, and rejects bad checksums", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 7]);
    const enc = bech32Encode("test", bytes);
    expect(bech32Decode(enc)).toEqual({ hrp: "test", bytes });
    expect(bech32Decode(enc.toUpperCase()).bytes).toEqual(bytes);
    const bad = enc.slice(0, -1) + (enc.endsWith("q") ? "p" : "q");
    expect(() => bech32Decode(bad)).toThrow(/checksum/);
    const nevent = neventEncode({ id: PUBHEX, relays: ["wss://relay.damus.io"], author: SECHEX, kind: 1 });
    expect(nevent.startsWith("nevent1")).toBe(true);
    expect(nip19Decode(nevent)).toEqual({ type: "nevent", data: { id: PUBHEX, relays: ["wss://relay.damus.io"], author: SECHEX, kind: 1 } });
  });

  it("parses secret keys and event ids in every accepted form", () => {
    expect(parseSecretKey(NSEC)).toBe(SECHEX);
    expect(parseSecretKey(SECHEX.toUpperCase())).toBe(SECHEX);
    expect(() => parseSecretKey("hello")).toThrow();
    expect(() => parseSecretKey(NPUB)).toThrow();
    expect(parseEventId(noteEncode(PUBHEX))).toBe(PUBHEX);
    expect(parseEventId(neventEncode({ id: PUBHEX }))).toBe(PUBHEX);
    expect(() => parseEventId("nope")).toThrow(ConnectorError);
  });
});

// ---- events -----------------------------------------------------------------------------------

const SK = "67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa";
const PK = bytesToHex(getPublicKey(hexToBytes(SK)));
const OTHER_SK = "b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef";
const OTHER_PK = bytesToHex(getPublicKey(hexToBytes(OTHER_SK)));
const AUX = () => new Uint8Array(32);

describe("NIP-01 events", () => {
  it("serializes with NIP-01 escaping and hashes to the id", () => {
    const ev = { pubkey: PK, created_at: 1700000000, kind: 1, tags: [["t", "x"]], content: 'a\n"b"\\ \u0001' };
    expect(serializeEvent(ev)).toBe(`[0,"${PK}",1700000000,1,[["t","x"]],"a\\n\\"b\\"\\\\ \u0001"]`);
    // Content without odd control characters serializes exactly like JSON.stringify.
    const plain = { ...ev, content: "hello\tworld" };
    expect(serializeEvent(plain)).toBe(JSON.stringify([0, PK, 1700000000, 1, [["t", "x"]], "hello\tworld"]));
    expect(getEventHash(ev)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("finalizes, verifies, and rejects tampered events", () => {
    const ev = finalizeEvent({ kind: 1, created_at: 1700000000, tags: [], content: "gm" }, hexToBytes(SK), AUX());
    expect(ev.pubkey).toBe(PK);
    expect(ev.id).toBe(getEventHash(ev));
    expect(verifyEvent(ev)).toBe(true);
    expect(verifyEvent({ ...ev, content: "gn" })).toBe(false);
    expect(verifyEvent({ ...ev, sig: ev.sig.replace(/^./, (c) => (c === "0" ? "1" : "0")) })).toBe(false);
    expect(verifyEvent({ ...ev, tags: [[1]] })).toBe(false);
    expect(verifyEvent(null)).toBe(false);
  });
});

// ---- fake relays ------------------------------------------------------------------------------

type OkReply = [boolean, string] | null;
interface FakeRelay {
  events: NostrEvent[];
  received: unknown[][];
  /** OK answer for an EVENT; null = never answer (timeout). Default accept. */
  ok?: (ev: NostrEvent) => OkReply;
  /** Fail to connect. */
  down?: boolean;
  /** Never send EOSE. */
  noEose?: boolean;
  /** Extra raw events sent for every REQ (e.g. forged ones). */
  extra?: unknown[];
}

function relay(events: NostrEvent[] = [], extra: Partial<FakeRelay> = {}): FakeRelay {
  return { events, received: [], ...extra };
}

function matches(ev: NostrEvent, f: NostrFilter): boolean {
  if (f.ids && !f.ids.includes(ev.id)) return false;
  if (f.authors && !f.authors.includes(ev.pubkey)) return false;
  if (f.kinds && !f.kinds.includes(ev.kind)) return false;
  if (f.since !== undefined && ev.created_at < f.since) return false;
  for (const [k, v] of Object.entries(f)) {
    if (!k.startsWith("#") || !Array.isArray(v)) continue;
    const name = k.slice(1);
    if (!ev.tags.some((t) => t[0] === name && v.includes(t[1] ?? ""))) return false;
  }
  return true;
}

class FakeSocket implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  closed = false;
  constructor(private readonly r: FakeRelay) {
    setTimeout(() => {
      if (r.down) {
        this.onerror?.({});
        this.onclose?.({});
      } else this.onopen?.({});
    }, 0);
  }
  private push(msg: unknown[]) {
    setTimeout(() => !this.closed && this.onmessage?.({ data: JSON.stringify(msg) }), 0);
  }
  send(data: string) {
    const msg = JSON.parse(data) as unknown[];
    this.r.received.push(msg);
    if (msg[0] === "EVENT") {
      const ev = msg[1] as NostrEvent;
      const reply = this.r.ok ? this.r.ok(ev) : ([true, ""] as OkReply);
      if (reply) this.push(["OK", ev.id, ...reply]);
      if (reply?.[0]) this.r.events.push(ev);
    } else if (msg[0] === "REQ") {
      const [, sub, ...filters] = msg as [string, string, ...NostrFilter[]];
      for (const ev of this.r.events) if (filters.some((f) => matches(ev, f))) this.push(["EVENT", sub, ev]);
      for (const raw of this.r.extra ?? []) this.push(["EVENT", sub, raw]);
      if (!this.r.noEose) this.push(["EOSE", sub]);
    }
  }
  close() {
    this.closed = true;
  }
}

const R1 = "wss://relay.one";
const R2 = "wss://relay.two";
function setup(relays: Record<string, FakeRelay>, nowSec = 1762300000) {
  const sockets: FakeSocket[] = [];
  const c = new NostrConnector({
    webSocketFactory: (url) => {
      const r = relays[url];
      if (!r) throw new Error(`no fake relay for ${url}`);
      const s = new FakeSocket(r);
      sockets.push(s);
      return s;
    },
    now: () => new Date(nowSec * 1000),
    connectTimeoutMs: 50,
    okTimeoutMs: 50,
    queryTimeoutMs: 50,
    auxRand: AUX,
  });
  const account: AccountRef = { id: "acc", workspaceId: "w", network: "nostr", externalId: PK, handle: npubEncode(PK), auth: { secretKey: SK, pubkey: PK }, config: { relays: Object.keys(relays) } };
  return { c, account, sockets };
}

const input = (over: Partial<PublishInput> = {}): PublishInput => ({ variantId: "v", text: "hello nostr", media: [], thread: [], idempotencyKey: `k-${Math.random()}`, ...over });
const note = (sk: string, content: string, tags: string[][] = [], created_at = 1762200000, kind = 1) => finalizeEvent({ kind, created_at, tags, content }, hexToBytes(sk), AUX());

describe("nostr connect", () => {
  it("accepts nsec or hex, derives the npub, reads the kind-0 name and stores relays", async () => {
    const profile = note(SK, JSON.stringify({ name: "acme", display_name: "Acme Inc" }), [], 1762000000, 0);
    const { c } = setup({ [R1]: relay([profile]), [R2]: relay() });
    const accounts = await c.connectWithInputs({ network: "nostr", inputs: { secretKey: nsecEncode(SK), relays: `${R1}, ${R2}` } });
    expect(accounts).toEqual([{ network: "nostr", identity: { externalId: PK, handle: npubEncode(PK), displayName: "Acme Inc" }, auth: { secretKey: SK, pubkey: PK }, config: { relays: [R1, R2], npub: npubEncode(PK) } }]);
    expect(c.connectConfigured).toBe(true);
    expect(c.credentialInputs.find((i) => i.key === "secretKey")).toMatchObject({ secret: true });
    expect(c.credentialInputs.find((i) => i.key === "relays")).toMatchObject({ optional: true });
  });

  it("uses default relays when none are given and rejects bad keys and relays", async () => {
    const c = new NostrConnector({ webSocketFactory: () => new FakeSocket(relay([], { down: true })), connectTimeoutMs: 20, queryTimeoutMs: 20 });
    const [acc] = await c.connectWithInputs({ network: "nostr", inputs: { secretKey: SK } });
    expect(acc?.config?.relays).toEqual(["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"]);
    expect(acc?.identity.displayName).toBeNull();
    await expect(c.connectWithInputs({ network: "nostr", inputs: { secretKey: "nope" } })).rejects.toMatchObject({ kind: "auth" });
    await expect(c.connectWithInputs({ network: "nostr", inputs: { secretKey: SK, relays: "https://relay.example" } })).rejects.toThrow(/wss/);
    expect(() => normalizeRelayUrl("wss://127.0.0.1")).toThrow(/public/);
    expect(() => normalizeRelayUrl("wss://localhost:7000")).toThrow(/public/);
    expect(normalizeRelayUrl("wss://Relay.Example.com/")).toBe("wss://relay.example.com");
    expect(createNostrConnectors({ NOSTR_DEFAULT_RELAYS: "wss://a.example" })[0]?.name).toBe("nostr");
  });
});

describe("nostr publish", () => {
  it("signs a kind-1 note with media URLs, imeta, content warning and hashtags; succeeds when one relay accepts", async () => {
    const r1 = relay();
    const r2 = relay([], { ok: () => [false, "blocked: pay to post"] });
    const { c, account } = setup({ [R1]: r1, [R2]: r2 });
    const res = await c.publish(account, input({ media: [{ kind: "image", url: "https://cdn.example/a.jpg", mime: "image/jpeg", width: 800, height: 600, alt: "a cat" }], options: { contentWarning: "spoilers", tags: ["#Launch"] } }));
    const sent = r1.received.find((m) => m[0] === "EVENT")?.[1] as NostrEvent;
    expect(verifyEvent(sent)).toBe(true);
    expect(sent.kind).toBe(1);
    expect(sent.pubkey).toBe(PK);
    expect(sent.created_at).toBe(1762300000);
    expect(sent.content).toBe("hello nostr\n\nhttps://cdn.example/a.jpg");
    expect(sent.tags).toEqual([["imeta", "url https://cdn.example/a.jpg", "m image/jpeg", "dim 800x600", "alt a cat"], ["content-warning", "spoilers"], ["t", "launch"]]);
    expect(res.externalId).toBe(sent.id);
    expect(res.url).toBe(`https://njump.me/${neventEncode({ id: sent.id, author: PK })}`);
    const raw = res.raw as { relays: { relay: string; ok: boolean; message: string }[][] };
    expect(raw.relays[0]).toEqual([{ relay: R1, ok: true, message: "" }, { relay: R2, ok: false, message: "blocked: pay to post" }]);
  });

  it("posts a thread as NIP-10 replies (root marker, then root + reply markers)", async () => {
    const r1 = relay();
    const { c, account } = setup({ [R1]: r1 });
    const res = await c.publish(account, input({ text: "1/3", thread: ["2/3", "3/3"] }));
    const evs = r1.received.filter((m) => m[0] === "EVENT").map((m) => m[1] as NostrEvent);
    expect(evs).toHaveLength(3);
    const [a, b, d] = evs as [NostrEvent, NostrEvent, NostrEvent];
    expect(res.threadExternalIds).toEqual([a.id, b.id, d.id]);
    expect(b.tags).toEqual([["e", a.id, R1, "root", PK]]);
    expect(d.tags).toEqual([["e", a.id, R1, "root", PK], ["e", b.id, R1, "reply", PK]]);
  });

  it("replies to an external note with its root and every participant tagged", async () => {
    const root = note(OTHER_SK, "root");
    const parent = note(OTHER_SK, "parent", [["e", root.id, "wss://x", "root", OTHER_PK], ["p", "a".repeat(64)], ["p", PK]]);
    const r1 = relay([root, parent]);
    const { c, account } = setup({ [R1]: r1 });
    await c.publish(account, input({ replyToExternalId: noteEncode(parent.id) }));
    const sent = r1.received.find((m) => m[0] === "EVENT")?.[1] as NostrEvent;
    expect(sent.tags).toEqual([["e", root.id, "wss://x", "root", OTHER_PK], ["e", parent.id, R1, "reply", OTHER_PK], ["p", OTHER_PK], ["p", "a".repeat(64)]]);
  });

  it("classifies all-relay failures: refusal, rate limit, timeout", async () => {
    const refused = setup({ [R1]: relay([], { ok: () => [false, "invalid: bad"] }) });
    await expect(refused.c.publish(refused.account, input())).rejects.toMatchObject({ kind: "rejected", retryable: false });
    const limited = setup({ [R1]: relay([], { ok: () => [false, "rate-limited: slow down"] }), [R2]: relay([], { ok: () => [false, "blocked: no"] }) });
    await expect(limited.c.publish(limited.account, input())).rejects.toMatchObject({ kind: "rate_limit", retryable: true });
    const silent = setup({ [R1]: relay([], { ok: () => null }), [R2]: relay([], { down: true }) });
    const err = await silent.c.publish(silent.account, input()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err).toMatchObject({ kind: "network", retryable: true });
    expect((err as Error).message).toMatch(/timeout: no OK/);
    expect((err as Error).message).toMatch(/connection failed/);
    expect(classifyRelayFailures([{ relay: R1, ok: false, message: "auth-required: sign in" }], "x").kind).toBe("auth");
  });

  it("resumes a part-posted thread by resending the same signed events and reports partial", async () => {
    let calls = 0;
    const r1 = relay([], { ok: () => (++calls === 2 ? [false, "error: db down"] : [true, calls > 2 ? "duplicate: have it" : ""]) });
    const { c, account } = setup({ [R1]: r1 });
    const inp = input({ text: "a", thread: ["b"], idempotencyKey: "thread-1" });
    const err = (await c.publish(account, inp).catch((e: unknown) => e)) as ConnectorError;
    expect(err.kind).toBe("network");
    const first = r1.received.filter((m) => m[0] === "EVENT").map((m) => m[1] as NostrEvent);
    expect(err.partial).toMatchObject({ externalId: first[0]?.id, threadExternalIds: [first[0]?.id] });
    const res = await c.publish(account, inp);
    const all = r1.received.filter((m) => m[0] === "EVENT").map((m) => m[1] as NostrEvent);
    expect(all).toHaveLength(3);
    expect(all[2]?.id).toBe(all[1]?.id); // same signed second segment, not a new event
    expect(res.threadExternalIds).toEqual([all[0]?.id, all[1]?.id]);
    // A settled key returns the cached result without touching relays.
    await c.publish(account, inp);
    expect(r1.received.filter((m) => m[0] === "EVENT")).toHaveLength(3);
  });

  it("validates polls and empty notes", () => {
    const { c, account } = setup({ [R1]: relay() });
    expect(c.validate(account, input({ options: { poll: { options: ["a", "b"], durationMinutes: 60 } } }))[0]?.message).toMatch(/poll/);
    expect(c.validate(account, input({ text: " " }))[0]?.code).toBe("empty");
    expect(c.validate(account, input())).toEqual([]);
  });
});

describe("nostr listen", () => {
  it("maps mentions, replies, thread comments, reactions and reposts; verifies, dedupes and filters by since", async () => {
    const own = note(SK, "my post", [], 1762100000);
    const mention = note(OTHER_SK, "hey nostr:npub", [["p", PK]], 1762200001);
    const reply = note(OTHER_SK, "nice", [["e", own.id, "", "root", PK], ["p", PK]], 1762200002);
    const third = "c90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b14e5c9";
    const comment = note(third, "in your thread", [["e", own.id, "", "root", PK], ["e", reply.id, "", "reply", OTHER_PK], ["p", OTHER_PK]], 1762200003);
    const like = note(OTHER_SK, "+", [["e", own.id], ["p", PK], ["k", "1"]], 1762200004, 7);
    const repost = note(OTHER_SK, "", [["e", own.id], ["p", PK]], 1762200005, 6);
    const old = note(OTHER_SK, "old", [["p", PK]], 1762000000);
    const profile = note(OTHER_SK, JSON.stringify({ name: "bob" }), [], 1762000000, 0);
    const forged = { ...note(OTHER_SK, "forged", [["p", PK]], 1762200009), content: "tampered" };
    const r1 = relay([own, mention, reply, like, old, profile], { extra: [forged] });
    const r2 = relay([own, reply, comment, repost, mention]);
    const { c, account } = setup({ [R1]: r1, [R2]: r2 });
    const items = await c.fetchActivity(account, new Date(1762100500 * 1000));
    expect(items.map((i) => [i.kind, i.externalId])).toEqual([
      ["mention", mention.id],
      ["reply", reply.id],
      ["comment", comment.id],
      ["like", like.id],
      ["repost", repost.id],
    ]);
    const m = items[0];
    expect(m).toMatchObject({ network: "nostr", authorHandle: npubEncode(OTHER_PK), authorName: "bob", text: "hey nostr:npub", parentExternalId: null, occurredAt: new Date(1762200001 * 1000).toISOString(), url: `https://njump.me/${neventEncode({ id: mention.id, author: OTHER_PK })}` });
    expect(items[1]?.parentExternalId).toBe(own.id);
    expect(items[2]?.parentExternalId).toBe(reply.id);
    expect(items[3]?.text).toBeNull();
    const req = r1.received.filter((x) => x[0] === "REQ")[1] as unknown[];
    expect(req[2]).toMatchObject({ kinds: [1, 6, 7], "#p": [PK], since: 1762100500 });
    expect(req[3]).toMatchObject({ "#e": [own.id] });
    expect(r1.received.some((x) => x[0] === "CLOSE")).toBe(true);
  });

  it("stops waiting at the query timeout when a relay never sends EOSE, and errors when no relay answers", async () => {
    const mention = note(OTHER_SK, "hi", [["p", PK]], 1762200001);
    const slow = setup({ [R1]: relay([mention], { noEose: true }) });
    const items = await slow.c.fetchActivity(slow.account, null);
    expect(items.map((i) => i.externalId)).toEqual([mention.id]);
    const down = setup({ [R1]: relay([], { down: true }) });
    await expect(down.c.fetchActivity(down.account, null)).rejects.toMatchObject({ kind: "network", retryable: true });
  });

  it("thread helpers follow NIP-10 including deprecated positional tags", () => {
    expect(threadRefs({ tags: [["e", "a".repeat(64)], ["e", "b".repeat(64)]] })).toEqual({ root: ["e", "a".repeat(64)], reply: ["e", "b".repeat(64)] });
    expect(threadRefs({ tags: [["e", "a".repeat(64), "", "mention"]] })).toEqual({ root: null, reply: null });
    expect(replyTags({ id: "c".repeat(64), pubkey: PK, tags: [] }, PK)).toEqual([["e", "c".repeat(64), "", "root", PK]]);
    expect(nostrEventToActivity(note(OTHER_SK, "-", [["e", "d".repeat(64)], ["p", PK]], 1, 7), PK, new Set())).toBeNull();
  });
});

describe("nostr reply, moderate, metrics", () => {
  it("replies with NIP-10 tags", async () => {
    const parent = note(OTHER_SK, "question?", [["p", PK]]);
    const r1 = relay([parent]);
    const { c, account } = setup({ [R1]: r1 });
    const res = await c.reply(account, { parentExternalId: parent.id, text: "answer", idempotencyKey: "r1" });
    const sent = r1.received.find((m) => m[0] === "EVENT")?.[1] as NostrEvent;
    expect(sent.tags).toEqual([["e", parent.id, R1, "root", OTHER_PK], ["p", OTHER_PK]]);
    expect(res.externalId).toBe(sent.id);
  });

  it("likes with a kind-7 reaction, unlikes by deleting it, deletes only own events", async () => {
    const theirs = note(OTHER_SK, "theirs");
    const mine = note(SK, "mine");
    const r1 = relay([theirs, mine]);
    const { c, account } = setup({ [R1]: r1 });
    await c.moderate(account, { externalId: theirs.id, action: "like" });
    const reaction = r1.received.filter((m) => m[0] === "EVENT").map((m) => m[1] as NostrEvent)[0];
    expect(reaction).toMatchObject({ kind: 7, content: "+", tags: [["e", theirs.id, R1, OTHER_PK], ["p", OTHER_PK], ["k", "1"]] });
    await c.moderate(account, { externalId: theirs.id, action: "unlike" });
    const del = r1.received.filter((m) => m[0] === "EVENT").map((m) => m[1] as NostrEvent)[1];
    expect(del).toMatchObject({ kind: 5, tags: [["e", reaction?.id], ["k", "7"]] });
    await c.moderate(account, { externalId: mine.id, action: "delete" });
    const del2 = r1.received.filter((m) => m[0] === "EVENT").map((m) => m[1] as NostrEvent)[2];
    expect(del2).toMatchObject({ kind: 5, tags: [["e", mine.id], ["k", "1"]] });
    await expect(c.moderate(account, { externalId: theirs.id, action: "delete" })).rejects.toThrow(/own events/);
    await expect(c.moderate(account, { externalId: theirs.id, action: "hide" })).rejects.toMatchObject({ kind: "rejected" });
  });

  it("counts replies, reactions and reposts seen on relays", async () => {
    const mine = note(SK, "mine");
    const evs = [
      note(OTHER_SK, "r", [["e", mine.id, "", "root"]]),
      note(OTHER_SK, "+", [["e", mine.id]], 1762200001, 7),
      note(OTHER_SK, "-", [["e", mine.id]], 1762200002, 7),
      note(OTHER_SK, "", [["e", mine.id]], 1762200003, 6),
      note(OTHER_SK, "m", [["e", mine.id, "", "mention"]], 1762200004),
    ];
    const { c, account } = setup({ [R1]: relay(evs), [R2]: relay(evs.slice(0, 2)) });
    const rows = await c.fetchMetrics(account, [mine.id]);
    expect(Object.fromEntries(rows.map((r) => [r.metric, r.value]))).toEqual({ likes: 1, reposts: 1, replies: 1, engagements: 3 });
    expect(rows[0]).toMatchObject({ entityType: "post_variant", entityId: mine.id, source: "nostr" });
    expect(c.capabilities().accountMetrics).toBe(false);
    expect(await c.refreshAuth()).toBeNull();
  });
});
