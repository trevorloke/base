import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { createTestDb } from "@base-air/db/test";
import { activities, type DbHandle } from "@base-air/db";
import { ConnectorRegistry, type AccountRef, type Connector, type ConnectorCapabilities, type WebhookHandler } from "@base-air/connectors";
import type { Network } from "@base-air/schema";
import { InMemoryScheduler, SecretBox, BaseAir, type Principal } from "../src/index.ts";

/** Like LINE: each channel signs with its own secret, and the body names the channel. */
class PerAccountChat implements Connector {
  readonly name = "chat";
  readonly networks: readonly Network[] = ["line"];
  readonly connectMethod = "bot_token" as const;
  capabilities(): ConnectorCapabilities {
    return { publish: false, fetchActivity: false, fetchMetrics: false, meteredReads: false, webhooks: true };
  }
  async publish(): Promise<never> {
    throw new Error("no");
  }
  async fetchActivity() {
    return [];
  }
  async fetchMetrics() {
    return [];
  }
  readonly webhook: WebhookHandler = {
    verify: () => false, // never used: route + verifyAccount take over
    route: (raw, query) => {
      if (query.channel) return { network: "line", accountExternalId: query.channel };
      try {
        return { network: "line", accountExternalId: String((JSON.parse(raw) as { destination: string }).destination) };
      } catch {
        return null;
      }
    },
    verifyAccount: (account: AccountRef, headers, raw) => {
      const want = createHmac("sha256", String(account.auth?.secret)).update(raw).digest("base64");
      return headers["x-signature"] === want;
    },
    challengeAccount: (account, query) => (query.token === account.auth?.secret ? (query.echo ?? null) : null),
    parse: (body) => {
      const b = body as { destination: string; text: string; id: string };
      return [{ network: "line", accountExternalId: b.destination, items: [{ network: "line", kind: "message", externalId: b.id, authorHandle: "u1", authorName: null, text: b.text, url: null, parentExternalId: null, occurredAt: new Date().toISOString(), raw: b, conversation: { id: "g1", name: "Fans", type: "group" } }] }];
    },
    ack: { body: "ok", contentType: "text/plain" },
    // Like Slack's url_verification: a signed delivery that only wants its challenge echoed.
    respond: (body) => {
      const c = (body as { challenge?: unknown }).challenge;
      return typeof c === "string" ? { body: c, contentType: "text/plain" } : null;
    },
  };
}

let h: DbHandle;
let m: BaseAir;
let ws: Principal;

beforeAll(async () => {
  h = await createTestDb();
  m = new BaseAir({ handle: h, connectors: new ConnectorRegistry().register(new PerAccountChat()), scheduler: new InMemoryScheduler(), secrets: new SecretBox(randomBytes(32)) });
  const w = await m.workspaces.create({ slug: "acme", name: "Acme" }, { type: "human", id: "u" });
  ws = { workspaceId: w.id, actor: { type: "human", id: "u" }, role: "owner" };
  await m.accounts.connect(ws, { network: "line", externalId: "chan-A", handle: "acme_jp", connector: "chat", auth: { secret: "secret-A" } });
  await m.accounts.connect(ws, { network: "line", externalId: "chan-B", handle: "acme_tw", connector: "chat", auth: { secret: "secret-B" } });
});
afterAll(() => h.close());

describe("webhooks signed with each account's own secret", () => {
  it("verifies with the named account's secret, ingests only there, and answers with the platform's ack", async () => {
    const raw = JSON.stringify({ destination: "chan-A", text: "新商品はいつ？", id: "m1" });
    const sig = (secret: string) => createHmac("sha256", secret).update(raw).digest("base64");
    await expect(m.webhooks.receive("chat", { "x-signature": sig("secret-B") }, raw)).rejects.toMatchObject({ code: "forbidden" }); // B's secret cannot speak for A
    const r = await m.webhooks.receive("chat", { "x-signature": sig("secret-A") }, raw);
    expect(r).toEqual({ accepted: true, items: 1, ack: { body: "ok", contentType: "text/plain" } });
    const rows = await m.ctx.db.select().from(activities);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "message", text: "新商品はいつ？", conversationId: "g1", conversationName: "Fans", conversationType: "group" });
  });

  it("answers the handshake only with the right account's secret", async () => {
    expect(await m.webhooks.challenge("chat", { channel: "chan-B", token: "secret-B", echo: "hi" })).toBe("hi");
    expect(await m.webhooks.challenge("chat", { channel: "chan-B", token: "secret-A", echo: "hi" })).toBeNull();
    expect(await m.webhooks.challenge("chat", { channel: "nobody", token: "secret-A", echo: "hi" })).toBeNull();
  });

  it("answers a verification delivery with the challenge from its own signed body", async () => {
    const raw = JSON.stringify({ destination: "chan-B", challenge: "abc123", text: "", id: "v1" });
    const sig = createHmac("sha256", "secret-B").update(raw).digest("base64");
    const r = await m.webhooks.receive("chat", { "x-signature": sig }, raw);
    expect(r.ack).toEqual({ body: "abc123", contentType: "text/plain" });
    // An ordinary delivery still gets the static ack.
    const raw2 = JSON.stringify({ destination: "chan-B", text: "hello", id: "m2" });
    const r2 = await m.webhooks.receive("chat", { "x-signature": createHmac("sha256", "secret-B").update(raw2).digest("base64") }, raw2);
    expect(r2.ack).toEqual({ body: "ok", contentType: "text/plain" });
  });
});

