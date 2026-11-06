import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountRef } from "../src/index.ts";
import { ConnectorError } from "../src/types.ts";
import { decodeEntities, discoverFeedLink, htmlToText, parseFeed, parseFeedDate, parseXml } from "../src/feed-parse.ts";
import { RssConnector, createRssConnectors, decodeBody, feedItemToActivity } from "../src/rss.ts";

const NOW = new Date("2026-11-06T12:00:00Z");
const FEED = "https://blog.example.com/feed.xml";
const publicLookup = async () => [{ address: "93.184.216.34" }];

const RSS2 = `<?xml version="1.0" encoding="UTF-8"?>
<!-- a comment with <item> inside -->
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>Acme &amp; Co Blog</title>
  <link>https://blog.example.com/</link>
  <atom:link href="https://blog.example.com/feed.xml" rel="self" type="application/rss+xml"/>
  <language>en-GB</language>
  <item>
    <title><![CDATA[Launch: <b>Rocket</b> & friends]]></title>
    <link>https://blog.example.com/launch</link>
    <guid isPermaLink="true">https://blog.example.com/launch</guid>
    <pubDate>Thu, 05 Nov 2026 09:30:00 +0000</pubDate>
    <dc:creator>Jane Doe</dc:creator>
    <description>Short &lt;em&gt;teaser&lt;/em&gt; &#8211; read more</description>
    <content:encoded><![CDATA[<p>Full story about the <a href="/r">rocket</a>.</p><p>Second&nbsp;paragraph &amp; more &#x1F680;</p><script>alert(1)</script>]]></content:encoded>
  </item>
  <item>
    <title>Older post</title>
    <link>/older</link>
    <guid isPermaLink="false">1234</guid>
    <pubDate>Mon, 02 Nov 2026 08:00:00 GMT</pubDate>
    <author>editor@example.com (The Editor)</author>
    <description>Plain description</description>
  </item>
  <item>
    <title>Undated note</title>
    <description>No date here</description>
  </item>
</channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="fr-CA">
  <title type="text">Le Journal</title>
  <link rel="alternate" type="text/html" href="https://journal.example.org/"/>
  <link rel="self" href="https://journal.example.org/atom.xml"/>
  <id>urn:uuid:60a76c80-d399-11d9-b93C-0003939e0af6</id>
  <updated>2026-11-05T18:30:02Z</updated>
  <author><name>Rédaction</name></author>
  <entry>
    <title type="html">Café &amp;amp; croissants</title>
    <link rel="alternate" href="https://journal.example.org/2026/cafe"/>
    <link rel="enclosure" href="https://journal.example.org/cafe.mp3"/>
    <id>tag:journal.example.org,2026:cafe</id>
    <published>2026-11-05T10:00:00+01:00</published>
    <updated>2026-11-05T18:30:02Z</updated>
    <summary>Résumé court</summary>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Le <strong>café</strong> est prêt.</p><p>Deuxième.</p></div></content>
  </entry>
  <entry xml:lang="en">
    <title>English entry</title>
    <link href="https://journal.example.org/2026/en"/>
    <id>entry-2</id>
    <updated>2026-11-04T10:00:00Z</updated>
    <author><name>Sam</name></author>
    <content type="html">&lt;p&gt;Hello &lt;b&gt;world&lt;/b&gt;&lt;/p&gt;</content>
  </entry>
</feed>`;

const RDF = `<?xml version="1.0"?>
<!DOCTYPE rdf:RDF [ <!ENTITY lol "lol"> <!ENTITY lol2 "&lol;&lol;&lol;"> ]>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://news.example.net/">
    <title>Example News</title>
    <link>https://news.example.net/</link>
    <description>News</description>
    <dc:language>de</dc:language>
  </channel>
  <item rdf:about="https://news.example.net/a1">
    <title>Erste Meldung &lol2;</title>
    <link>https://news.example.net/a1</link>
    <description>Text mit &#252;mlaut</description>
    <dc:date>2026-11-05T07:00:00+00:00</dc:date>
    <dc:creator>Max</dc:creator>
  </item>
</rdf:RDF>`;

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
const xml = (body: string, headers: Record<string, string> = {}, status = 200) => new Response(body, { status, headers: { "content-type": "application/rss+xml; charset=utf-8", ...headers } });
function call(i: number) {
  const c = fetchMock.mock.calls[i];
  if (!c) throw new Error(`fetch call ${i} was not made`);
  return { url: String(c[0]), init: c[1]!, headers: (c[1]?.headers ?? {}) as Record<string, string> };
}
beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const connector = (extra: ConstructorParameters<typeof RssConnector>[0] = {}) => new RssConnector({ now: () => NOW, lookup: publicLookup, ...extra });
const account = (feedUrl = FEED, id = "acc-1"): AccountRef => ({ id, workspaceId: "w", network: "rss", externalId: feedUrl, handle: "Acme", auth: { feedUrl }, config: { feedUrl } });

describe("feed parsing", () => {
  it("reads RSS 2.0 with CDATA, entities, content:encoded, dc:creator and relative links", () => {
    const f = parseFeed(RSS2, FEED)!;
    expect(f).toMatchObject({ format: "rss2", title: "Acme & Co Blog", link: "https://blog.example.com/", language: "en-GB" });
    expect(f.items).toHaveLength(3);
    const [a, b, c] = f.items;
    expect(a).toMatchObject({ id: "https://blog.example.com/launch", title: "Launch: Rocket & friends", link: "https://blog.example.com/launch", author: "Jane Doe", published: "2026-11-05T09:30:00.000Z" });
    expect(a!.summary).toBe("Full story about the rocket.\n\nSecond paragraph & more \u{1F680}");
    expect(a!.summary).not.toContain("alert");
    expect(b).toMatchObject({ id: "1234", link: "https://blog.example.com/older", author: "The Editor", published: "2026-11-02T08:00:00.000Z", summary: "Plain description" });
    expect(c).toMatchObject({ id: null, link: null, published: null, title: "Undated note" });
  });

  it("reads Atom with xhtml/html content, xml:lang and rel=alternate links", () => {
    const f = parseFeed(ATOM, "https://journal.example.org/atom.xml")!;
    expect(f).toMatchObject({ format: "atom", title: "Le Journal", link: "https://journal.example.org/", language: "fr-CA" });
    const [a, b] = f.items;
    expect(a).toMatchObject({ id: "tag:journal.example.org,2026:cafe", title: "Café & croissants", link: "https://journal.example.org/2026/cafe", author: "Rédaction", published: "2026-11-05T09:00:00.000Z", lang: null });
    expect(a!.summary).toBe("Le café est prêt.\n\nDeuxième.");
    expect(b).toMatchObject({ id: "entry-2", link: "https://journal.example.org/2026/en", author: "Sam", published: "2026-11-04T10:00:00.000Z", summary: "Hello world", lang: "en" });
  });

  it("reads RSS 1.0 / RDF without expanding DTD entities", () => {
    const f = parseFeed(RDF, "https://news.example.net/rss")!;
    expect(f).toMatchObject({ format: "rss1", title: "Example News", language: "de" });
    expect(f.items[0]).toMatchObject({ id: "https://news.example.net/a1", title: "Erste Meldung &lol2;", summary: "Text mit ümlaut", author: "Max", published: "2026-11-05T07:00:00.000Z" });
  });

  it("is tolerant and safe", () => {
    expect(parseFeed("<html><head><title>x</title></head></html>")).toBeNull();
    expect(parseFeed("not xml at all")).toBeNull();
    expect(parseFeed("")).toBeNull();
    // Unclosed tags and stray ampersands still parse.
    const f = parseFeed(`<rss><channel><title>T & U</title><item><title>One<item><title>Two</title></item></channel></rss>`);
    expect(f?.title).toBe("T & U");
    expect(parseXml(`<a x='1>2' y="&lt;"/>`)?.attrs).toEqual({ x: "1>2", y: "<" });
    expect(decodeEntities("&#0; &#xD800; &#x110000; &bogus; &amp;amp;")).toBe("� � � &bogus; &amp;");
    expect(htmlToText("<ul><li>a</li><li>b</li></ul><style>x{}</style>")).toBe("• a\n\n• b");
  });

  it("parses feed dates and finds advertised feeds", () => {
    expect(parseFeedDate("Thu, 5 Nov 2026 09:30:00 EST")).toBe("2026-11-05T14:30:00.000Z");
    expect(parseFeedDate("2026-11-05")).toBe("2026-11-05T00:00:00.000Z");
    expect(parseFeedDate("Thu, 05 Nov 2026 09:30:00 +0000 (UTC)")).toBe("2026-11-05T09:30:00.000Z");
    expect(parseFeedDate("someday")).toBeNull();
    expect(discoverFeedLink(`<html><head><link rel="stylesheet" href="/s.css"><link rel="alternate" type="application/atom+xml" href="/atom.xml"></head>`, "https://site.example.com/blog/")).toBe("https://site.example.com/atom.xml");
  });

  it("decodes non-UTF-8 feeds from the XML declaration", () => {
    const latin1 = Uint8Array.from([...'<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel><title>Caf'].map((c) => c.charCodeAt(0)).concat([0xe9], [..."</title></channel></rss>"].map((c) => c.charCodeAt(0))));
    expect(parseFeed(decodeBody(latin1, "application/xml"))?.title).toBe("Café");
  });
});

describe("rss activity mapping", () => {
  it("maps an item to a mention with conversation, lang and namespaced plain guids", () => {
    const f = parseFeed(RSS2, FEED)!;
    const meta = { url: FEED, title: f.title, language: f.language };
    const a = feedItemToActivity(f.items[0]!, meta, NOW)!;
    expect(a).toMatchObject({
      network: "rss",
      kind: "mention",
      externalId: "https://blog.example.com/launch",
      authorHandle: "blog.example.com",
      authorName: "Jane Doe",
      url: "https://blog.example.com/launch",
      parentExternalId: null,
      occurredAt: "2026-11-05T09:30:00.000Z",
      conversation: { id: FEED, name: "Acme & Co Blog", type: "channel" },
      lang: "en",
    });
    expect(a.text).toBe("Launch: Rocket & friends\n\nFull story about the rocket.\n\nSecond paragraph & more \u{1F680}");
    expect(feedItemToActivity(f.items[1]!, meta, NOW)!.externalId).toBe(`${FEED}|1234`);
    const undated = feedItemToActivity(f.items[2]!, meta, NOW)!;
    expect(undated).toMatchObject({ occurredAt: NOW.toISOString(), authorName: "Acme & Co Blog", url: null });
    expect(undated.externalId).toMatch(/^https:\/\/blog\.example\.com\/feed\.xml\|[0-9a-f]{32}$/);
    const long = feedItemToActivity({ id: "x", title: "T", link: null, summary: "y".repeat(10_000), author: null, published: null, lang: null }, meta, NOW)!;
    expect(long.text).toHaveLength(4000);
    const future = feedItemToActivity({ id: "f", title: "F", link: null, summary: "", author: null, published: "2027-01-01T00:00:00Z", lang: "pt-BR" }, meta, NOW)!;
    expect(future).toMatchObject({ occurredAt: NOW.toISOString(), lang: "pt" });
  });
});

describe("rss connector", () => {
  it("connects: fetches once, reads the title, one account per feed URL", async () => {
    fetchMock.mockResolvedValueOnce(xml(RSS2));
    const c = connector();
    const [acc] = await c.connectWithInputs({ network: "rss", inputs: { feedUrl: `${FEED}#frag` } });
    expect(acc).toEqual({
      network: "rss",
      identity: { externalId: FEED, handle: "Acme & Co Blog", displayName: "Acme & Co Blog" },
      auth: { feedUrl: FEED },
      config: { feedUrl: FEED, title: "Acme & Co Blog", siteUrl: "https://blog.example.com/", host: "blog.example.com", format: "rss2", language: "en", name: null },
    });
    expect(call(0).init.redirect).toBe("manual");
    expect(c.capabilities()).toMatchObject({ publish: false, fetchActivity: true, fetchMetrics: false, reply: false, moderate: false, webhooks: false });
    await expect(c.publish()).rejects.toMatchObject({ kind: "rejected" });
  });

  it("uses the given name, adds https://, and discovers the feed from an HTML page", async () => {
    fetchMock.mockResolvedValueOnce(new Response(`<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body>hi</body></html>`, { headers: { "content-type": "text/html" } }));
    fetchMock.mockResolvedValueOnce(xml(RSS2));
    const [acc] = await connector().connectWithInputs({ network: "rss", inputs: { feedUrl: "blog.example.com", name: "Acme blog" } });
    expect(call(0).url).toBe("https://blog.example.com/");
    expect(call(1).url).toBe(FEED);
    expect(acc!.identity).toEqual({ externalId: FEED, handle: "Acme blog", displayName: "Acme & Co Blog" });
  });

  it("refuses non-feeds, private hosts and bad schemes", async () => {
    const c = connector();
    fetchMock.mockResolvedValueOnce(new Response("<html><body>no feed</body></html>", { headers: { "content-type": "text/html" } }));
    await expect(c.connectWithInputs({ network: "rss", inputs: { feedUrl: FEED } })).rejects.toMatchObject({ kind: "rejected" });
    await expect(c.connectWithInputs({ network: "rss", inputs: { feedUrl: "http://192.168.1.10/feed" } })).rejects.toThrow(/private/);
    await expect(c.connectWithInputs({ network: "rss", inputs: { feedUrl: "file:///etc/passwd" } })).rejects.toThrow(/https/);
    await expect(c.connectWithInputs({ network: "rss", inputs: { feedUrl: "" } })).rejects.toMatchObject({ kind: "rejected" });
  });

  it("first run returns the newest 50; later runs only items newer than since", async () => {
    const items = Array.from({ length: 60 }, (_, i) => `<item><title>Post ${i}</title><guid>g${i}</guid><pubDate>${new Date(NOW.getTime() - (i + 1) * 3600_000).toUTCString()}</pubDate></item>`).join("");
    const big = `<rss><channel><title>Many</title>${items}</channel></rss>`;
    fetchMock.mockImplementation(async () => xml(big));
    const c = connector();
    const first = await c.fetchActivity(account(), null);
    expect(first).toHaveLength(50);
    expect(first[0]!.text).toBe("Post 0");
    expect(first[49]!.text).toBe("Post 49");
    const later = await c.fetchActivity(account(), new Date(NOW.getTime() - 3.5 * 3600_000));
    expect(later.map((a) => a.text)).toEqual(["Post 0", "Post 1", "Post 2"]);
  });

  it("sends conditional requests and returns nothing on 304, per account", async () => {
    const c = connector();
    fetchMock.mockResolvedValueOnce(xml(RSS2, { etag: '"v1"', "last-modified": "Thu, 05 Nov 2026 10:00:00 GMT" }));
    const first = await c.fetchActivity(account(), null);
    expect(first.map((a) => a.text?.split("\n")[0])).toEqual(["Undated note", "Launch: Rocket & friends", "Older post"]);
    expect(call(0).headers["if-none-match"]).toBeUndefined();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 304 }));
    expect(await c.fetchActivity(account(), new Date("2026-11-01T00:00:00Z"))).toEqual([]);
    expect(call(1).headers).toMatchObject({ "if-none-match": '"v1"', "if-modified-since": "Thu, 05 Nov 2026 10:00:00 GMT" });
    // Another account on the same feed has its own validators: a full fetch, not a 304 that would hide items.
    fetchMock.mockResolvedValueOnce(xml(RSS2));
    expect((await c.fetchActivity(account(FEED, "acc-2"), null)).length).toBe(3);
    expect(call(2).headers["if-none-match"]).toBeUndefined();
  });

  it("does not return undated items twice in one process", async () => {
    const c = connector();
    fetchMock.mockImplementation(async () => xml(RSS2));
    const since = new Date("2026-11-04T00:00:00Z");
    const a = await c.fetchActivity(account(), since);
    expect(a.map((x) => x.text?.split("\n")[0])).toEqual(["Undated note", "Launch: Rocket & friends"]);
    const b = await c.fetchActivity(account(), since);
    expect(b.map((x) => x.text?.split("\n")[0])).toEqual(["Launch: Rocket & friends"]);
  });

  it("follows http(s) redirects with checks, refuses other schemes and private hops", async () => {
    const c = connector();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: "https://cdn.example.com/feed.xml" } }));
    fetchMock.mockResolvedValueOnce(xml(ATOM));
    expect((await c.fetchActivity(account(), null)).length).toBe(2);
    expect(call(1).url).toBe("https://cdn.example.com/feed.xml");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "file:///etc/passwd" } }));
    await expect(c.fetchActivity(account(FEED, "acc-3"), null)).rejects.toThrow(/only http and https/);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } }));
    await expect(c.fetchActivity(account(FEED, "acc-4"), null)).rejects.toThrow(/private/);
    fetchMock.mockImplementation(async () => new Response(null, { status: 302, headers: { location: FEED } }));
    await expect(c.fetchActivity(account(FEED, "acc-5"), null)).rejects.toThrow(/redirects/);
  });

  it("caps the response size (declared and streamed)", async () => {
    const c = connector({ maxBytes: 1000 });
    fetchMock.mockResolvedValueOnce(xml("x", { "content-length": "5000000" }));
    await expect(c.fetchActivity(account(), null)).rejects.toThrow(/limit is/);
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        for (let i = 0; i < 5; i++) ctrl.enqueue(new Uint8Array(400));
        ctrl.close();
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(stream, { status: 200 }));
    const err = (await c.fetchActivity(account(), null).catch((e: unknown) => e)) as ConnectorError;
    expect(err).toMatchObject({ kind: "rejected", retryable: false });
    expect(err.message).toMatch(/larger than/);
  });

  it("maps HTTP errors and transport failures", async () => {
    const c = connector();
    const cases: [Response | Error, Partial<ConnectorError>][] = [
      [new Response("", { status: 503 }), { kind: "network", retryable: true }],
      [new Response("", { status: 429, headers: { "retry-after": "60" } }), { kind: "rate_limit", retryable: true }],
      [new Response("", { status: 403 }), { kind: "auth", retryable: false }],
      [new Response("", { status: 404 }), { kind: "rejected", retryable: false }],
      [new TypeError("fetch failed"), { kind: "network", retryable: true }],
      [xml("<html>gone</html>"), { kind: "rejected", retryable: false }],
    ];
    for (const [res, want] of cases) {
      if (res instanceof Error) fetchMock.mockRejectedValueOnce(res);
      else fetchMock.mockResolvedValueOnce(res);
      await expect(c.fetchActivity(account(), null)).rejects.toMatchObject(want);
    }
  });

  it("factory honours STARSIGN_ALLOW_PRIVATE_URLS", async () => {
    const [c] = createRssConnectors({ STARSIGN_ALLOW_PRIVATE_URLS: "1", STARSIGN_PUBLIC_URL: "https://starsign.example.com" }) as [RssConnector];
    fetchMock.mockResolvedValueOnce(xml(RDF));
    const out = await c.fetchActivity(account("http://intranet.local/rss"), null);
    expect(out[0]).toMatchObject({ kind: "mention", lang: "de", authorName: "Max", conversation: { id: "http://intranet.local/rss", name: "Example News", type: "channel" } });
    expect(call(0).headers["user-agent"]).toBe("Starsign-RSS/1 (+https://starsign.example.com)");
  });
});
