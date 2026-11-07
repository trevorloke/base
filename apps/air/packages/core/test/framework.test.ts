import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "@base-air/db/test";
import type { DbHandle } from "@base-air/db";
import { ConnectorRegistry, type AccountRef, type Connector, type ConnectorCapabilities, type MediaFetcher, type PublishInput } from "@base-air/connectors";
import type { Network } from "@base-air/schema";
import { InMemoryScheduler, LocalStorage, S3Storage, SecretBox, BaseAir, mp4DurationSeconds, probe, type Principal } from "../src/index.ts";

/** A connector exercising every optional capability of the contract. */
class FullConnector implements Connector {
  readonly name = "full";
  readonly networks: readonly Network[] = ["facebook", "instagram", "mastodon"];
  readonly connectMethod = "oauth" as const;
  readonly oauthInputs = [{ key: "instance", label: "Instance" }] as const;
  published: PublishInput[] = [];
  replies: { parent: string; text: string; key: string }[] = [];
  moderated: { id: string; action: string }[] = [];
  mediaSeen: number[] = [];
  media?: MediaFetcher;
  capabilities(): ConnectorCapabilities {
    return { publish: true, fetchActivity: true, fetchMetrics: false, meteredReads: false, reply: true, moderate: true, accountMetrics: true, webhooks: true, video: true };
  }
  async oauthPrepare(p: { inputs: Record<string, string>; redirectUri: string; state: string }) {
    return { authorizeUrl: `https://${p.inputs.instance}/oauth/authorize?state=${p.state}`, config: { instance: p.inputs.instance, clientSecret: "per-instance-secret" } };
  }
  lastCallbackParams: Record<string, string> | undefined;
  async oauthConnect(p: { code: string; config?: Record<string, unknown>; callbackParams?: Record<string, string> }) {
    this.lastCallbackParams = p.callbackParams;
    if (p.code === "bad") throw new Error("denied");
    return [
      { network: "facebook" as const, identity: { externalId: "page-1", handle: "acmepage", displayName: "Acme Page" }, auth: { pageToken: "pt" }, config: { instance: p.config?.instance } },
      { network: "instagram" as const, identity: { externalId: "ig-1", handle: "acme.ig", displayName: null }, auth: { pageToken: "pt" } },
    ];
  }
  async publish(_a: AccountRef, input: PublishInput) {
    this.published.push(input);
    for (const m of input.media) if (this.media) this.mediaSeen.push((await this.media.fetch(m)).bytes.length);
    return { externalId: `post-${this.published.length}`, url: null };
  }
  async reply(_a: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }) {
    this.replies.push({ parent: input.parentExternalId, text: input.text, key: input.idempotencyKey });
    return { externalId: `reply-${this.replies.length}`, url: null };
  }
  async moderate(_a: AccountRef, input: { externalId: string; action: string }) {
    this.moderated.push({ id: input.externalId, action: input.action });
  }
  async fetchActivity() {
    return [];
  }
  async fetchMetrics() {
    return [];
  }
  async fetchAccountMetrics() {
    return [{ entityType: "social_account" as const, entityId: "ignored", metric: "followers_total" as const, value: 1234, observedAt: new Date().toISOString(), source: "full" }];
  }
  readonly webhook = {
    challenge: (q: Record<string, string>) => (q["hub.verify_token"] === "vt" ? (q["hub.challenge"] ?? null) : null),
    verify: (headers: Record<string, string>, raw: string) => {
      const sig = headers["x-hub-signature-256"] ?? "";
      const want = `sha256=${createHmac("sha256", "app-secret").update(raw).digest("hex")}`;
      return sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want));
    },
    parse: (body: unknown) =>
      ((body as { entry: { id: string; text: string; cid: string }[] }).entry ?? []).map((e) => ({
        network: "facebook" as const,
        accountExternalId: e.id,
        items: [{ network: "facebook" as const, kind: "comment" as const, externalId: e.cid, authorHandle: "fan", authorName: null, text: e.text, url: null, parentExternalId: "post-1", occurredAt: new Date().toISOString(), raw: e }],
      })),
  };
}

let h: DbHandle;
let m: BaseAir;
let full: FullConnector;
let owner: Principal;
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 4, 0, 0, 0, 3, 0, 8, 2, 0, 0, 0]);

beforeAll(async () => {
  h = await createTestDb();
  full = new FullConnector();
  const dir = mkdtempSync(join(tmpdir(), "base-air-media-"));
  m = new BaseAir({ handle: h, connectors: new ConnectorRegistry().register(full), scheduler: new InMemoryScheduler(), secrets: new SecretBox(randomBytes(32)), mediaStorage: new LocalStorage(dir, "https://app.example") });
  const ws = await m.workspaces.create({ slug: "acme", name: "Acme", timezone: "UTC" }, { type: "human", id: "u1" });
  owner = { workspaceId: ws.id, actor: { type: "human", id: "u1" }, role: "owner" };
  await m.policy.update(owner, { autonomy: { new_post: "schedule_with_approval", reply: "draft", dm: "suggest", repost: "draft", campaign: "suggest" }, redLines: [{ id: "g", kind: "forbidden_phrase", description: "No guarantees", severity: "block", phrases: ["guaranteed"] }] });
});
afterAll(() => h.close());

describe("probe", () => {
  it("reads PNG, JPEG, GIF dimensions and MP4 duration from bytes", () => {
    expect(probe(PNG)).toMatchObject({ kind: "image", mime: "image/png", width: 1024, height: 768 });
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x01, 0xe0, 0x02, 0x80, 3, 0, 0, 0]);
    expect(probe(jpeg)).toMatchObject({ mime: "image/jpeg", width: 640, height: 480 });
    expect(probe(Uint8Array.from([...Buffer.from("GIF89a"), 0x40, 0x01, 0xf0, 0x00, 0, 0, 0, 0]))).toMatchObject({ kind: "gif", width: 320, height: 240 });
    const box = (type: string, body: number[]) => { const size = 8 + body.length; return [(size >>> 24) & 255, (size >>> 16) & 255, (size >>> 8) & 255, size & 255, ...Buffer.from(type), ...body]; };
    const mvhd = box("mvhd", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x03, 0xe8, 0, 0, 0x75, 0x30]); // timescale 1000, duration 30000
    const mp4 = Uint8Array.from([...box("ftyp", [...Buffer.from("isom"), 0, 0, 0, 0]), ...box("moov", mvhd)]);
    expect(probe(mp4)).toMatchObject({ kind: "video", mime: "video/mp4" });
    expect(mp4DurationSeconds(mp4)).toBe(30);
    expect(probe(Uint8Array.from(Buffer.from("not a media file at all")))).toBeNull();
  });
});

describe("S3 signing", () => {
  it("matches AWS's documented SigV4 example (GET object with range)", () => {
    const s3 = new S3Storage(
      { endpoint: "https://s3.amazonaws.com", region: "us-east-1", bucket: "examplebucket", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", publicBaseUrl: "https://cdn.example" },
      undefined,
      () => new Date("2013-05-24T00:00:00Z"),
    );
    const headers = s3.sign("GET", new URL("https://examplebucket.s3.amazonaws.com/test.txt"), new Uint8Array(), { Range: "bytes=0-9" });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(s3.publicUrl("a/b.png")).toBe("https://cdn.example/a/b.png");
  });
});

describe("media library", () => {
  it("sniffs, dedupes by hash, serves public URLs, and refuses unknown files and viewers", async () => {
    const a = await m.media.upload(owner, { bytes: PNG, filename: "hero.png", alt: "hero" });
    expect(a).toMatchObject({ kind: "image", mime: "image/png", width: 1024, height: 768, bytes: PNG.length });
    expect(a.url).toMatch(/^https:\/\/app\.example\/media\/.+\.png$/);
    expect((await m.media.upload(owner, { bytes: PNG })).id).toBe(a.id);
    await expect(m.media.upload(owner, { bytes: Uint8Array.from(Buffer.from("#!/bin/sh echo hi")) })).rejects.toMatchObject({ code: "invalid" });
    await expect(m.media.upload({ ...owner, role: "viewer" }, { bytes: PNG })).rejects.toMatchObject({ code: "forbidden" });
    expect(m.media.toMedia(a)).toMatchObject({ kind: "image", assetId: a.id, alt: "hero" });
  });
});

describe("multi-account OAuth", () => {
  it("requires declared inputs, prepares per start, and connects every account the login yields", async () => {
    await expect(m.accounts.startOAuth(owner, { connector: "full", redirectUri: "https://app/cb" })).rejects.toMatchObject({ code: "invalid" });
    const start = await m.accounts.startOAuth(owner, { connector: "full", redirectUri: "https://app/cb", inputs: { instance: "mastodon.social" } });
    expect(start.authorizeUrl).toMatch(/^https:\/\/mastodon\.social\/oauth\/authorize\?state=/);
    const state = new URL(start.authorizeUrl).searchParams.get("state")!;
    const accts = await m.accounts.completeOAuth({ state, code: "ok", params: { code: "ok", state, device_id: "dev-42" } });
    expect(full.lastCallbackParams).toMatchObject({ device_id: "dev-42" }); // VK ID needs device_id in the token exchange
    expect(accts.map((a) => `${a.network}:${a.handle}`)).toEqual(["facebook:acmepage", "instagram:acme.ig"]);
    expect(accts[0]!.config).toEqual({ instance: "mastodon.social" });
    const s2 = new URL((await m.accounts.startOAuth(owner, { connector: "full", redirectUri: "https://app/cb", inputs: { instance: "x.y" } })).authorizeUrl).searchParams.get("state")!;
    await expect(m.accounts.completeOAuth({ state: s2, code: "bad" })).rejects.toMatchObject({ details: { reason: "exchange_failed" } });
  });
});

describe("publishing with options, media and first comment", () => {
  it("passes options and stored media bytes to the connector and posts the first comment", async () => {
    const [page] = (await m.accounts.list(owner.workspaceId)).filter((a) => a.network === "facebook");
    const asset = (await m.media.list(owner.workspaceId))[0]!;
    const r = await m.posts.create(owner, {
      body: "Launch",
      variants: [{ socialAccountId: page!.id, text: "Launch day", media: [m.media.toMedia(asset)], options: { kind: "post", firstComment: "Link in comments: https://acme.example" } }],
      scheduledAt: new Date().toISOString(),
    });
    expect(r.variants[0]!.options).toMatchObject({ firstComment: "Link in comments: https://acme.example" });
    await m.publishing.publishPost(r.post.id);
    const last = full.published.at(-1)!;
    expect(last.options?.firstComment).toMatch(/Link in comments/);
    expect(full.mediaSeen.at(-1)).toBe(PNG.length);
    expect(full.replies.at(-1)).toMatchObject({ parent: "post-1", key: `${r.variants[0]!.id}:first-comment` });
  });
});

describe("engagement", () => {
  it("replies go through the gate and the reply dial; moderation is people-only", async () => {
    const [page] = (await m.accounts.list(owner.workspaceId)).filter((a) => a.network === "facebook");
    await m.listening.ingestItems(owner.workspaceId, page!.id, [{ network: "facebook", kind: "comment", externalId: "c-77", authorHandle: "fan", authorName: null, text: "love it", url: null, parentExternalId: "post-1", occurredAt: new Date().toISOString(), raw: {} }]);
    const [act] = await m.listening.feed(owner.workspaceId, { kinds: ["comment"] });
    const blocked = await m.engagement.reply(owner, act!.id, "Results guaranteed!");
    expect(blocked.post.status).toBe("blocked");
    const ok = await m.engagement.reply(owner, act!.id, "Thank you!");
    expect(ok.post.status).toBe("scheduled"); // the owner's reply needs no approval
    await m.publishing.publishPost(ok.post.id);
    expect(full.replies.at(-1)).toMatchObject({ parent: "c-77", text: "Thank you!" });
    const agent = { workspaceId: owner.workspaceId, actor: { type: "mcp" as const, id: "claude" } };
    const drafted = await m.engagement.reply(agent, act!.id, "Thanks from the team");
    expect(drafted.post.status).toBe("pending_approval"); // reply dial is "draft" for agents
    await expect(m.engagement.moderate(agent, act!.id, "hide")).rejects.toMatchObject({ code: "forbidden" });
    await expect(m.engagement.moderate({ ...owner, role: "editor" }, act!.id, "delete")).rejects.toMatchObject({ code: "forbidden" });
    await m.engagement.moderate(owner, act!.id, "hide");
    expect(full.moderated.at(-1)).toEqual({ id: "c-77", action: "hide" });
  });
});

describe("webhooks and account metrics", () => {
  it("verifies signatures, answers challenges, routes items to the connected account", async () => {
    expect(await m.webhooks.challenge("full", { "hub.verify_token": "vt", "hub.challenge": "42" })).toBe("42");
    expect(await m.webhooks.challenge("full", { "hub.verify_token": "nope", "hub.challenge": "42" })).toBeNull();
    const raw = JSON.stringify({ entry: [{ id: "page-1", text: "webhook comment", cid: "c-900" }, { id: "unknown-page", text: "x", cid: "c-901" }] });
    await expect(m.webhooks.receive("full", { "x-hub-signature-256": "sha256=deadbeef" }, raw)).rejects.toMatchObject({ code: "forbidden" });
    const sig = `sha256=${createHmac("sha256", "app-secret").update(raw).digest("hex")}`;
    expect(await m.webhooks.receive("full", { "x-hub-signature-256": sig }, raw)).toEqual({ accepted: true, items: 1 });
    expect((await m.listening.feed(owner.workspaceId, { q: "webhook comment" })).length).toBe(1);
  });

  it("captures follower counts per account", async () => {
    const r = await m.metrics.captureAccountMetrics();
    expect(r.accounts).toBeGreaterThanOrEqual(2);
    const [page] = (await m.accounts.list(owner.workspaceId)).filter((a) => a.network === "facebook");
    expect((await m.metrics.latest("social_account", page!.id)).followers_total).toBe(1234);
  });
});
