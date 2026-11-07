import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { createTestDb } from "@starsign/db/test";
import { activities, operatorRuns, type DbHandle } from "@starsign/db";
import { ConnectorRegistry, MockConnector } from "@starsign/connectors";
import type { ActivityInput } from "@starsign/schema";
import { InMemoryScheduler, SecretBox, Starsign, detectLanguage, type Principal, type Translator } from "../src/index.ts";

let h: DbHandle;
let m: Starsign;
let owner: Principal;
let acct: string;
let n = 0;
const msg = (text: string, extra: Partial<ActivityInput> = {}): ActivityInput => ({
  network: "line",
  kind: "message",
  externalId: `m${++n}`,
  authorHandle: "u1",
  authorName: null,
  text,
  url: null,
  parentExternalId: null,
  occurredAt: new Date().toISOString(),
  raw: {},
  ...extra,
});
/** A translator that says what it did, and counts its calls. */
let calls = 0;
const fakeTranslate: Translator = async (items, to) => {
  calls++;
  const dict: Record<string, string> = { "新しいレインジャケットはいつ発売ですか？": "When does the new rain jacket come out?", "¿Dónde puedo comprar la chaqueta impermeable?": "Where can I buy the rain jacket?" };
  return { translations: Object.fromEntries(items.map((i) => [i.id, dict[i.text] ?? `[${to}] ${i.text}`])), costUsd: 0.001, inputTokens: 100, outputTokens: 40 };
};

beforeAll(async () => {
  h = await createTestDb();
  m = new Starsign({ handle: h, connectors: new ConnectorRegistry().register(new MockConnector()), scheduler: new InMemoryScheduler(), secrets: new SecretBox(randomBytes(32)) });
  const ws = await m.workspaces.create({ slug: "acme", name: "Acme" }, { type: "human", id: "u" });
  owner = { workspaceId: ws.id, actor: { type: "human", id: "u" }, role: "owner" };
  acct = (await m.accounts.connect(owner, { network: "line", externalId: "bot-1", handle: "acme_jp", connector: "mock" })).id;
});
afterAll(() => h.close());

describe("language detection", () => {
  it("labels full sentences and refuses to guess on scraps", () => {
    expect(detectLanguage("新しいレインジャケットはいつ発売ですか？")?.lang).toBe("ja");
    expect(detectLanguage("这件夹克什么时候上市？")?.lang).toBe("zh");
    expect(detectLanguage("¿Dónde puedo comprar la chaqueta impermeable?")?.lang).toBe("es");
    expect(detectLanguage("@acme https://acme.test 👍")).toBeNull();
    expect(detectLanguage("ok")).toBeNull();
  });
});

describe("monitoring across languages and chat rooms", () => {
  it("stores the language and the room, matches Japanese keywords inside unspaced text, and filters by language", async () => {
    const jp = await m.listening.createStream(owner, { name: "Jackets (ja)", query: { keywords: ["レインジャケット"] } });
    const esOnly = await m.listening.createStream(owner, { name: "Spanish only", query: { languages: ["es"] } });
    await m.listening.ingestItems(owner.workspaceId, acct, [
      msg("新しいレインジャケットはいつ発売ですか？", { conversation: { id: "g-tokyo", name: "Acme Fans Tokyo", type: "group" } }),
      msg("¿Dónde puedo comprar la chaqueta impermeable?", { network: "whatsapp", kind: "dm", conversation: { id: "34600000000", type: "direct" } }),
      msg("Where do I buy the rain jacket?", { network: "discord", conversation: { id: "c1", name: "#general", type: "channel" } }),
      msg("ok 👍"),
    ]);
    const rows = await m.listening.feed(owner.workspaceId, {});
    const ja = rows.find((r) => r.text?.startsWith("新しい"))!;
    expect(ja).toMatchObject({ lang: "ja", conversationId: "g-tokyo", conversationName: "Acme Fans Tokyo", conversationType: "group" });
    expect(ja.matchedStreams).toContain(jp.id);
    expect(rows.find((r) => r.text === "ok 👍")!.lang).toBeNull();
    expect(rows.find((r) => r.text?.startsWith("¿Dónde"))!.matchedStreams).toEqual([esOnly.id]);
    expect((await m.listening.feed(owner.workspaceId, { languages: ["ja", "es"] })).map((r) => r.lang).sort()).toEqual(["es", "ja"]);
    expect(await m.listening.feed(owner.workspaceId, { conversationId: "g-tokyo" })).toHaveLength(1);
    expect(await m.translations.languagesSeen(owner.workspaceId, new Date(0))).toEqual(expect.arrayContaining([{ lang: "ja", n: 1 }, { lang: "en", n: 1 }]));
  });

  it("translates other languages into the team's, skips its own, re-matches English streams, records the cost, and searches translations", async () => {
    const en = await m.listening.createStream(owner, { name: "Rain jacket (en)", query: { keywords: ["rain jacket"] } });
    const r = await m.translations.translateWorkspace(owner.workspaceId, fakeTranslate);
    expect(r).toMatchObject({ translated: 2, skipped: 1 }); // the English message left the queue without a model call
    const rows = await m.listening.feed(owner.workspaceId, {});
    const ja = rows.find((x) => x.lang === "ja")!;
    expect(ja).toMatchObject({ translation: "When does the new rain jacket come out?", translationLang: "en" });
    expect(ja.matchedStreams).toContain(en.id); // an English keyword now finds a Japanese message
    expect(rows.find((x) => x.lang === "en")!.translation).toBeNull();
    const [run] = await m.ctx.db.select().from(operatorRuns).where(eq(operatorRuns.operator, "translator"));
    expect(run).toMatchObject({ status: "succeeded", costUsd: 0.001 });
    expect(await m.listening.feed(owner.workspaceId, { q: "come out" })).toHaveLength(1);
    // Nothing left: a second run makes no model call.
    const before = calls;
    expect((await m.translations.translateWorkspace(owner.workspaceId, fakeTranslate)).translated).toBe(0);
    expect(calls).toBe(before);
  });

  it("respects the daily limit and the off switch; translates on demand whatever was detected", async () => {
    await m.translations.updateSettings(owner, { dailyLimit: 3 });
    await m.listening.ingestItems(owner.workspaceId, acct, [msg("这件夹克什么时候上市？"), msg("Quand sort la nouvelle veste de pluie ?"), msg("Wann kommt die neue Regenjacke raus?")]);
    const r = await m.translations.translateWorkspace(owner.workspaceId, fakeTranslate);
    expect(r.translated).toBe(1); // 2 already today, limit 3
    await m.translations.updateSettings(owner, { autoTranslate: false, dailyLimit: 2000 });
    expect((await m.translations.translateWorkspace(owner.workspaceId, fakeTranslate)).translated).toBe(0);
    const unknown = (await m.listening.feed(owner.workspaceId, {})).find((x) => x.text === "ok 👍")!;
    expect((await m.translations.translateOne(owner, unknown.id, fakeTranslate)).translation).toBe("[en] ok 👍");
    await expect(m.translations.updateSettings({ ...owner, role: "editor" }, { home: "ja" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("expands a stream's keywords into other languages and matches with them", async () => {
    const s = await m.listening.createStream(owner, { name: "Jacket launch", query: { keywords: ["rain jacket"] } });
    const updated = await m.translations.expandStream(owner, s.id, ["ja", "zh-TW", "ja"], async (_k, langs) => ({ byLanguage: Object.fromEntries(langs.map((l) => [l, l === "ja" ? ["レインジャケット", "雨具"] : ["雨衣"]])) }));
    expect((updated.query as { translations: Record<string, string[]> }).translations).toEqual({ ja: ["レインジャケット", "雨具"], zh: ["雨衣"] });
    await m.listening.ingestItems(owner.workspaceId, acct, [msg("下雨天穿雨衣最舒服了")]);
    const row = (await m.listening.feed(owner.workspaceId, {})).find((x) => x.text === "下雨天穿雨衣最舒服了")!;
    expect(row.matchedStreams).toContain(s.id);
    await expect(m.translations.expandStream({ ...owner, role: "viewer" }, s.id, ["ja"], async () => ({ byLanguage: {} }))).rejects.toMatchObject({ code: "forbidden" });
  });

  it("keeps rows untranslated when the model leaves one out", async () => {
    await m.translations.updateSettings(owner, { autoTranslate: true });
    await m.listening.ingestItems(owner.workspaceId, acct, [msg("Il nuovo giubbotto impermeabile è bellissimo")]);
    await m.translations.translateWorkspace(owner.workspaceId, async () => ({ translations: {} }));
    const [row] = await m.ctx.db.select().from(activities).where(eq(activities.text, "Il nuovo giubbotto impermeabile è bellissimo"));
    expect(row!.translatedAt).toBeNull(); // still waiting for the next run
  });
});
