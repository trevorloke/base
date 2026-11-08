import { describe, expect, it } from "vitest";
import { BlueskyMentionSearch, GdeltNewsSearch, MastodonTagSearch, YouTubeMentionSearch, createMentionSearches, gdeltTime, hashtagsFor, stripHtml } from "../src/index.ts";

const now = new Date("2026-11-06T12:00:00Z");
const since = new Date("2026-11-06T06:00:00Z");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function recorder(handler: (url: URL) => Response) {
  const urls: URL[] = [];
  const fetch = async (input: string) => {
    const u = new URL(input);
    urls.push(u);
    return handler(u);
  };
  return { urls, fetch };
}

describe("Bluesky mention search", () => {
  it("quotes phrases, maps posts to feed items with the post's language, and dedupes across terms", async () => {
    const post = { uri: "at://did:plc:a/app.bsky.feed.post/3k1", author: { handle: "voter.bsky.social", displayName: "A Voter" }, record: { text: "Partido Verde sube en las encuestas", createdAt: "2026-11-06T10:00:00Z", langs: ["es"] } };
    const r = recorder(() => json({ posts: [post] }));
    const items = await new BlueskyMentionSearch({ fetch: r.fetch }).search({ terms: ["Partido Verde", "#PartidoVerde"], since, now });
    expect(r.urls[0]!.searchParams.get("q")).toBe('"Partido Verde"');
    expect(r.urls[0]!.searchParams.get("since")).toBe(since.toISOString());
    expect(r.urls[1]!.searchParams.get("q")).toBe("#PartidoVerde");
    expect(items).toEqual([
      expect.objectContaining({ network: "bluesky", kind: "mention", externalId: post.uri, authorHandle: "voter.bsky.social", authorName: "A Voter", url: "https://bsky.app/profile/voter.bsky.social/post/3k1", lang: "es", occurredAt: "2026-11-06T10:00:00.000Z" }),
    ]);
  });
  it("says plainly when search needs a token", async () => {
    const r = recorder(() => json({ error: "AuthRequired" }, 401));
    await expect(new BlueskyMentionSearch({ fetch: r.fetch }).search({ terms: ["x"], since, now })).rejects.toThrow(/BASE_AIR_BLUESKY_SEARCH_TOKEN/);
  });
});

describe("Mastodon hashtag search", () => {
  it("turns names into hashtags, reads public tag timelines, skips servers that want sign-in, and drops old posts", async () => {
    expect(hashtagsFor(["Green Party", "#Greens", "緑の党", "AB"])).toEqual(["GreenParty", "Greens", "緑の党"]);
    expect(stripHtml("<p>Vote <a href='x'>#GreenParty</a> &amp; more</p><p>Second</p>")).toBe("Vote #GreenParty & more\n\nSecond");
    const r = recorder((u) =>
      u.host === "locked.example"
        ? json({ error: "This method requires an authenticated user" }, 401)
        : json([
            { id: "1", uri: "https://mastodon.social/users/a/statuses/1", url: "https://mastodon.social/@a/1", created_at: "2026-11-06T11:00:00Z", content: "<p>Go <b>Greens</b></p>", language: "en", account: { acct: "a", display_name: "A" } },
            { id: "0", uri: "https://mastodon.social/users/b/statuses/0", created_at: "2026-11-05T11:00:00Z", content: "<p>old</p>", account: { acct: "b@other.social" } },
          ]),
    );
    const items = await new MastodonTagSearch({ fetch: r.fetch, instances: ["locked.example", "https://mastodon.social/"] }).search({ terms: ["Greens"], since, now });
    expect(r.urls.map((u) => `${u.host}${u.pathname}`)).toEqual(["locked.example/api/v1/timelines/tag/Greens", "mastodon.social/api/v1/timelines/tag/Greens"]);
    expect(items).toEqual([expect.objectContaining({ network: "mastodon", text: "Go Greens", authorHandle: "a@mastodon.social", url: "https://mastodon.social/@a/1", lang: "en" })]);
  });
});

describe("YouTube mention search", () => {
  it("makes one OR query per request and only runs with a key", async () => {
    expect(await new YouTubeMentionSearch({}).search({ terms: ["x"], since, now })).toEqual([]);
    const r = recorder(() => json({ items: [{ id: { videoId: "v1" }, snippet: { publishedAt: "2026-11-06T09:00:00Z", channelId: "UC1", channelTitle: "Debate TV", title: "Tom Reed on housing", description: "Full interview" } }, { id: {}, snippet: {} }] }));
    const items = await new YouTubeMentionSearch({ apiKey: "k", fetch: r.fetch }).search({ terms: ["Tom Reed", "Reed"], since, now });
    expect(r.urls).toHaveLength(1);
    expect(r.urls[0]!.searchParams.get("q")).toBe('"Tom Reed"|Reed');
    expect(r.urls[0]!.searchParams.get("publishedAfter")).toBe(since.toISOString());
    expect(items).toEqual([expect.objectContaining({ network: "youtube", externalId: "v1", authorName: "Debate TV", text: "Tom Reed on housing\n\nFull interview", url: "https://www.youtube.com/watch?v=v1" })]);
  });
});

describe("GDELT news search", () => {
  it("ORs quoted names, sets the time window, maps language names, and tolerates GDELT's plain-text errors", async () => {
    expect(gdeltTime(new Date("2026-11-06T09:05:07.123Z"))).toBe("20261106090507");
    const r = recorder(() => json({ articles: [{ url: "https://news.example.jp/a1", title: "緑の党、支持率上昇", seendate: "20261106T101500Z", domain: "news.example.jp", language: "Japanese", sourcecountry: "Japan" }] }));
    const items = await new GdeltNewsSearch({ fetch: r.fetch }).search({ terms: ["Green Party", "Greens", "GP"], since, now });
    expect(r.urls[0]!.searchParams.get("query")).toBe('("Green Party" OR "Greens")'); // "GP" is too short for GDELT
    expect(r.urls[0]!.searchParams.get("startdatetime")).toBe("20261106060000");
    expect(items).toEqual([expect.objectContaining({ network: "news", kind: "mention", externalId: "https://news.example.jp/a1", authorHandle: "news.example.jp", text: "緑の党、支持率上昇", lang: "ja", occurredAt: "2026-11-06T10:15:00Z" })]);
    const plain = recorder(() => new Response("Your search contained a phrase that was too short.", { status: 200 }));
    expect(await new GdeltNewsSearch({ fetch: plain.fetch }).search({ terms: ["Green Party"], since, now })).toEqual([]);
  });
  it("lists only configured searches and honours BASE_AIR_MENTION_SOURCES", () => {
    expect(createMentionSearches({}).map((s) => s.name)).toEqual(["bluesky", "mastodon", "news"]);
    expect(createMentionSearches({ YOUTUBE_API_KEY: "k", BASE_AIR_MENTION_SOURCES: "news,youtube" }).map((s) => s.name)).toEqual(["youtube", "news"]);
  });
});
