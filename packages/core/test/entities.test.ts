import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { createTestDb } from "@starsign/db/test";
import { entityMentions, trendTopics, type DbHandle } from "@starsign/db";
import { ConnectorRegistry, MockConnector } from "@starsign/connectors";
import type { ActivityInput } from "@starsign/schema";
import { InMemoryScheduler, SecretBox, Starsign, matchEntity, type Principal } from "../src/index.ts";

let h: DbHandle;
let m: Starsign;
let owner: Principal;
let acct: string;
let n = 0;
const item = (text: string | null, extra: Partial<ActivityInput> = {}): ActivityInput => ({
  network: "x",
  kind: "mention",
  externalId: `t${++n}`,
  authorHandle: `user${n}`,
  authorName: null,
  text,
  url: null,
  parentExternalId: null,
  occurredAt: new Date().toISOString(),
  raw: {},
  ...extra,
});

beforeAll(async () => {
  h = await createTestDb();
  m = new Starsign({ handle: h, connectors: new ConnectorRegistry().register(new MockConnector()), scheduler: new InMemoryScheduler(), secrets: new SecretBox(randomBytes(32)) });
  const ws = await m.workspaces.create({ slug: "campaign", name: "Campaign desk" }, { type: "human", id: "u" });
  owner = { workspaceId: ws.id, actor: { type: "human", id: "u" }, role: "owner" };
  acct = (await m.accounts.connect(owner, { network: "x", externalId: "1", handle: "desk", connector: "mock" })).id;
});
afterAll(() => h.close());

describe("matchEntity", () => {
  const green = { name: "Green Party", aliases: ["Greens", "Green"], handles: { x: ["GreenPartyHQ"] }, context: ["party", "vote", "election", "candidate", "leader"], exclude: ["green tea"] };
  it("matches by authorship, @handle, and name, respecting context and exclusions", () => {
    expect(matchEntity(green, { network: "x", text: "Our platform launches today", authorHandle: "@GreenPartyHQ" })).toEqual({ how: "author", term: "@greenpartyhq" });
    expect(matchEntity(green, { network: "x", text: "cc @greenpartyhq on this", authorHandle: "someone" })).toEqual({ how: "handle", term: "@greenpartyhq" });
    expect(matchEntity(green, { network: "x", text: "Will vote Green this time", authorHandle: "a" })).toEqual({ how: "name", term: "Green" });
    expect(matchEntity(green, { network: "x", text: "The grass is green", authorHandle: "a" })).toBeNull(); // no context word
    expect(matchEntity(green, { network: "x", text: "Green tea before the party", authorHandle: "a" })).toBeNull(); // excluded
    expect(matchEntity(green, { network: "x", text: "緑の党の候補者", translation: "Green Party candidate", authorHandle: "a" })).toEqual({ how: "name", term: "Green Party" });
  });
});

describe("tracking a party and its candidates", () => {
  it("creates organisations and people, links candidates to their party, makes a trend topic, and backfills history", async () => {
    // A message already in the feed before anyone tracked the name.
    await m.listening.ingestItems(owner.workspaceId, acct, [item("María López had a strong debate tonight")]);
    const party = await m.entities.create(owner, { kind: "organization", name: "Green Party", role: "party", relation: "own", aliases: ["Greens", "Partido Verde", "緑の党"], handles: { x: ["@GreenPartyHQ"] }, context: ["party", "vote", "election", "candidate", "debate", "partido", "党"], wikipedia: ["Green_Party"] });
    const maria = await m.entities.create(owner, { kind: "person", name: "María López", role: "candidate", parentId: party.id, aliases: ["Maria Lopez", "マリア・ロペス"], handles: { x: ["mlopez"] } });
    const tom = await m.entities.create(owner, { kind: "person", name: "Tom Reed", role: "candidate", parentId: party.id, exclude: ["Tom Reed Jr"] });
    const rival = await m.entities.create(owner, { kind: "organization", name: "Blue Alliance", role: "party", relation: "opponent", aliases: ["Alianza Azul"] });
    expect(maria.parentId).toBe(party.id);
    const [topic] = await m.ctx.db.select().from(trendTopics).where(eq(trendTopics.id, party.trendTopicId!));
    expect(topic!.keywords).toEqual(expect.arrayContaining(["Green Party", "緑の党", "wiki:Green_Party"]));
    expect((await m.entities.mentions(owner.workspaceId, maria.id)).map((r) => r.activity.text)).toEqual(["María López had a strong debate tonight"]); // backfilled

    // New messages in several languages and from the entities themselves.
    await m.listening.ingestItems(owner.workspaceId, acct, [
      item("Partido Verde gana terreno en las encuestas", { lang: "es" }),
      item("緑の党のマリア・ロペス候補が演説", { network: "line", kind: "message", conversation: { id: "g1", name: "Supporters Tokyo", type: "group" } }),
      item("Thanks to everyone who came out today", { authorHandle: "mlopez" }),
      item("Tom Reed Jr scored twice last night"), // the namesake
      item("Tom Reed on housing: a thread"),
      item("Alianza Azul y el Partido Verde empatados", { lang: "es" }),
      item("Nothing to do with anyone"),
    ]);
    await expect(m.entities.create({ ...owner, role: "viewer" }, { kind: "person", name: "X" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(m.entities.create(owner, { kind: "person", name: "Y", parentId: tom.id })).rejects.toMatchObject({ code: "invalid" }); // people belong to organisations
    await expect(m.entities.update(owner, party.id, { parentId: party.id })).rejects.toMatchObject({ code: "invalid" }); // no cycles

    const report = await m.entities.report(owner.workspaceId, new Date(Date.now() - 86_400_000), new Date(Date.now() + 60_000));
    const by = Object.fromEntries(report.entities.map((e) => [e.name, e]));
    expect(by["María López"]).toMatchObject({ mentions: 2, authored: 1, shareWithinParent: expect.any(Number) });
    expect(by["Tom Reed"]).toMatchObject({ mentions: 1 }); // not the footballer
    expect(by["Green Party"]).toMatchObject({ mentions: 3, familyMentions: 6 });
    expect(by["Blue Alliance"]).toMatchObject({ mentions: 1 });
    expect(by["Green Party"]!.shareOfVoice! + by["Blue Alliance"]!.shareOfVoice!).toBeCloseTo(100, 0);
    expect(by["Green Party"]!.byLanguage).toEqual(expect.arrayContaining([{ lang: "es", n: 2 }, { lang: "ja", n: 1 }]));
    expect(by["María López"]!.byNetwork).toEqual(expect.arrayContaining([{ network: "line", n: 1 }]));
    // The feed filtered to the party, with and without its candidates.
    expect(await m.entities.activityIdsFor(owner.workspaceId, party.id)).toHaveLength(3);
    expect(await m.entities.activityIdsFor(owner.workspaceId, party.id, { includeChildren: true })).toHaveLength(6);
    void rival;
  });

  it("rebuilds mentions when the names change, finds translated mentions, and archives without losing history", async () => {
    const [rival] = (await m.entities.list(owner.workspaceId)).filter((e) => e.name === "Blue Alliance");
    // Add a nickname: past messages are rescanned.
    await m.listening.ingestItems(owner.workspaceId, acct, [item("The Blues are rallying downtown")]);
    expect((await m.entities.mentions(owner.workspaceId, rival!.id)).length).toBe(1);
    await m.entities.update(owner, rival!.id, { aliases: ["Alianza Azul", "the Blues"] });
    expect((await m.entities.mentions(owner.workspaceId, rival!.id)).length).toBe(2);

    // A message only matched through its translation.
    await m.listening.ingestItems(owner.workspaceId, acct, [item("蓝色联盟今天举行集会", { lang: "zh" })]);
    await m.translations.translateWorkspace(owner.workspaceId, async (items) => ({ translations: Object.fromEntries(items.map((i) => [i.id, i.text === "蓝色联盟今天举行集会" ? "Blue Alliance holds a rally today" : `[en] ${i.text}`])) }));
    expect((await m.entities.mentions(owner.workspaceId, rival!.id)).map((r) => r.activity.text)).toContain("蓝色联盟今天举行集会");

    const before = await m.ctx.db.select().from(entityMentions).where(eq(entityMentions.entityId, rival!.id));
    await m.entities.archive(owner, rival!.id);
    expect((await m.entities.list(owner.workspaceId)).map((e) => e.name)).not.toContain("Blue Alliance");
    expect(await m.ctx.db.select().from(entityMentions).where(eq(entityMentions.entityId, rival!.id))).toHaveLength(before.length);
  });
});
