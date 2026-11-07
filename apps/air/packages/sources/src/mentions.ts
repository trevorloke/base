import type { ActivityInput } from "@base-air/schema";
import { fetchOf, getJson } from "./http.ts";
import { SourceError, type FetchLike } from "./types.ts";

/**
 * Public mention search for the tracker: the posts and articles that name a party, brand or person anywhere public,
 * not only in replies to the workspace's own accounts. Each adapter returns ordinary feed items; the tracker keeps
 * only those that pass the entity's own matching rules (context and exclusion words), so a search for a common
 * word does not flood the feed.
 */
export interface MentionSearchRequest {
  /** Names and aliases to look for (the tracker sends a few per entity). */
  terms: string[];
  /** Only items published after this. */
  since: Date;
  now: Date;
  /** Most items to return for this request. */
  limit?: number;
}

export interface MentionSearch {
  readonly name: string;
  readonly configured: boolean;
  search(req: MentionSearchRequest): Promise<ActivityInput[]>;
}

const quote = (t: string) => `"${t.replace(/"/g, "")}"`;

// ---------------------------------------------------------------- Bluesky

interface BskyPost {
  uri: string;
  author: { handle: string; displayName?: string };
  record: { text?: string; createdAt?: string; langs?: string[]; reply?: { parent?: { uri?: string } } };
  indexedAt?: string;
}

/** app.bsky.feed.searchPosts: the whole open network, newest first. */
export class BlueskyMentionSearch implements MentionSearch {
  readonly name = "bluesky";
  readonly configured = true;
  private readonly fetchFn: FetchLike;
  private readonly baseUrl: string;
  private readonly token: string | undefined;

  constructor(opts: { fetch?: FetchLike; baseUrl?: string; token?: string } = {}) {
    this.fetchFn = fetchOf(opts.fetch);
    this.baseUrl = opts.baseUrl ?? "https://public.api.bsky.app/xrpc";
    this.token = opts.token;
  }

  async search(req: MentionSearchRequest): Promise<ActivityInput[]> {
    const headers: Record<string, string> = this.token ? { authorization: `Bearer ${this.token}` } : {};
    const limit = Math.min(req.limit ?? 50, 100);
    const out = new Map<string, ActivityInput>();
    for (const term of req.terms.slice(0, 4)) {
      const params = new URLSearchParams({ q: term.includes(" ") ? quote(term) : term, sort: "latest", limit: String(limit), since: req.since.toISOString(), until: req.now.toISOString() });
      let body: { posts?: BskyPost[] };
      try {
        body = await getJson<{ posts?: BskyPost[] }>(this.fetchFn, this.name, `${this.baseUrl}/app.bsky.feed.searchPosts?${params}`, headers);
      } catch (e) {
        if (e instanceof SourceError && (e.status === 401 || e.status === 403)) {
          throw new SourceError("bluesky: post search needs authentication here; set BASE_AIR_BLUESKY_SEARCH_TOKEN", this.name, false, e.status);
        }
        throw e;
      }
      for (const p of body.posts ?? []) {
        if (out.has(p.uri)) continue;
        const rkey = p.uri.split("/").pop() ?? "";
        out.set(p.uri, {
          network: "bluesky",
          kind: "mention",
          externalId: p.uri,
          authorHandle: p.author.handle,
          authorName: p.author.displayName ?? null,
          text: p.record.text ?? null,
          url: `https://bsky.app/profile/${p.author.handle}/post/${rkey}`,
          parentExternalId: p.record.reply?.parent?.uri ?? null,
          occurredAt: new Date(p.record.createdAt ?? p.indexedAt ?? req.now).toISOString(),
          raw: p,
          ...(p.record.langs?.[0] && /^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(p.record.langs[0]) ? { lang: p.record.langs[0] } : {}),
        });
      }
    }
    return [...out.values()];
  }
}

// ---------------------------------------------------------------- Mastodon (hashtags)

interface MastoStatus {
  id: string;
  uri: string;
  url?: string | null;
  created_at: string;
  content: string;
  language?: string | null;
  account: { acct: string; display_name?: string };
  in_reply_to_id?: string | null;
}

/** "#GreenParty", "Green Party" → "GreenParty": the hashtag forms people use for a name. */
export function hashtagsFor(terms: string[]): string[] {
  const tags = new Set<string>();
  for (const t of terms) {
    const tag = t.replace(/^#/, "").replace(/[^\p{L}\p{N}_]+/gu, "");
    if (tag.length >= 3 && tag.length <= 60) tags.add(tag);
  }
  return [...tags];
}

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/** Public hashtag timelines on a few large servers (no account needed on most servers). */
export class MastodonTagSearch implements MentionSearch {
  readonly name = "mastodon";
  readonly configured: boolean;
  private readonly fetchFn: FetchLike;
  private readonly instances: string[];

  constructor(opts: { fetch?: FetchLike; instances?: string[] } = {}) {
    this.fetchFn = fetchOf(opts.fetch);
    this.instances = (opts.instances ?? ["mastodon.social"]).map((i) => i.replace(/^https?:\/\//, "").replace(/\/+$/, "")).filter(Boolean);
    this.configured = this.instances.length > 0;
  }

  async search(req: MentionSearchRequest): Promise<ActivityInput[]> {
    const out = new Map<string, ActivityInput>();
    for (const instance of this.instances.slice(0, 3)) {
      for (const tag of hashtagsFor(req.terms).slice(0, 3)) {
        let statuses: MastoStatus[];
        try {
          statuses = await getJson<MastoStatus[]>(this.fetchFn, this.name, `https://${instance}/api/v1/timelines/tag/${encodeURIComponent(tag)}?limit=${Math.min(req.limit ?? 40, 40)}`);
        } catch (e) {
          // A server that wants sign-in for hashtag timelines: skip it, keep the others.
          if (e instanceof SourceError && (e.status === 401 || e.status === 403 || e.status === 422)) continue;
          throw e;
        }
        for (const s of statuses) {
          if (Date.parse(s.created_at) <= req.since.getTime() || out.has(s.uri)) continue;
          out.set(s.uri, {
            network: "mastodon",
            kind: "mention",
            externalId: s.uri,
            authorHandle: s.account.acct.includes("@") ? s.account.acct : `${s.account.acct}@${instance}`,
            authorName: s.account.display_name || null,
            text: stripHtml(s.content),
            url: s.url ?? s.uri,
            parentExternalId: null,
            occurredAt: new Date(s.created_at).toISOString(),
            raw: s,
            ...(s.language && /^[a-z]{2,3}$/.test(s.language) ? { lang: s.language } : {}),
          });
        }
      }
    }
    return [...out.values()];
  }
}

// ---------------------------------------------------------------- YouTube

interface YtSearchItem {
  id: { videoId?: string };
  snippet: { publishedAt: string; channelId: string; channelTitle: string; title: string; description: string; defaultAudioLanguage?: string };
}

/** search.list costs 100 quota units per call (10,000 a day by default), so the tracker asks sparingly. */
export class YouTubeMentionSearch implements MentionSearch {
  readonly name = "youtube";
  readonly configured: boolean;
  private readonly fetchFn: FetchLike;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;

  constructor(opts: { apiKey?: string; fetch?: FetchLike; baseUrl?: string } = {}) {
    this.apiKey = opts.apiKey;
    this.configured = !!opts.apiKey;
    this.fetchFn = fetchOf(opts.fetch);
    this.baseUrl = opts.baseUrl ?? "https://www.googleapis.com/youtube/v3";
  }

  async search(req: MentionSearchRequest): Promise<ActivityInput[]> {
    if (!this.apiKey) return [];
    // One call per request: the names joined with OR (YouTube supports | as OR).
    const q = req.terms.slice(0, 3).map((t) => (t.includes(" ") ? quote(t) : t)).join("|");
    const params = new URLSearchParams({ part: "snippet", type: "video", order: "date", maxResults: String(Math.min(req.limit ?? 25, 50)), q, publishedAfter: req.since.toISOString(), key: this.apiKey });
    const body = await getJson<{ items?: YtSearchItem[] }>(this.fetchFn, this.name, `${this.baseUrl}/search?${params}`);
    return (body.items ?? []).flatMap((it) =>
      it.id.videoId
        ? [
            {
              network: "youtube" as const,
              kind: "mention" as const,
              externalId: it.id.videoId,
              authorHandle: it.snippet.channelId,
              authorName: it.snippet.channelTitle,
              text: [it.snippet.title, it.snippet.description].filter(Boolean).join("\n\n"),
              url: `https://www.youtube.com/watch?v=${it.id.videoId}`,
              parentExternalId: null,
              occurredAt: new Date(it.snippet.publishedAt).toISOString(),
              raw: it,
            },
          ]
        : [],
    );
  }
}

// ---------------------------------------------------------------- News (GDELT)

interface GdeltArticle {
  url: string;
  title: string;
  seendate: string; // 20261106T101500Z
  domain: string;
  language?: string; // "Japanese"
  sourcecountry?: string;
}

/** GDELT reports languages by English name. */
const LANGUAGE_CODES: Record<string, string> = {
  english: "en", spanish: "es", french: "fr", german: "de", italian: "it", portuguese: "pt", dutch: "nl", russian: "ru", ukrainian: "uk", polish: "pl",
  turkish: "tr", arabic: "ar", persian: "fa", hebrew: "he", hindi: "hi", bengali: "bn", urdu: "ur", chinese: "zh", japanese: "ja", korean: "ko",
  vietnamese: "vi", thai: "th", indonesian: "id", malay: "ms", tagalog: "tl", swedish: "sv", norwegian: "no", danish: "da", finnish: "fi", greek: "el",
  czech: "cs", romanian: "ro", hungarian: "hu", bulgarian: "bg", serbian: "sr", croatian: "hr", tamil: "ta", swahili: "sw",
};

export function gdeltTime(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "");
}

/**
 * GDELT DOC 2.0: news in 65+ languages, free, no key. It also searches machine translations, so an English name
 * finds articles written in other languages. One request per entity at most every few seconds (GDELT asks for
 * gentle use); the tracker runs this on a slow schedule.
 */
export class GdeltNewsSearch implements MentionSearch {
  readonly name = "news";
  readonly configured = true;
  private readonly fetchFn: FetchLike;
  private readonly baseUrl: string;

  constructor(opts: { fetch?: FetchLike; baseUrl?: string } = {}) {
    this.fetchFn = fetchOf(opts.fetch);
    this.baseUrl = opts.baseUrl ?? "https://api.gdeltproject.org/api/v2/doc/doc";
  }

  async search(req: MentionSearchRequest): Promise<ActivityInput[]> {
    // TODO(verify): GDELT rejects very short or very common terms; phrases must be quoted; OR needs parentheses.
    const terms = req.terms.filter((t) => t.replace(/^#/, "").length >= 4).slice(0, 4);
    if (terms.length === 0) return [];
    const query = terms.length === 1 ? quote(terms[0]!) : `(${terms.map(quote).join(" OR ")})`;
    const since = new Date(Math.max(req.since.getTime(), req.now.getTime() - 3 * 86_400_000)); // GDELT's article list covers recent days best
    const params = new URLSearchParams({ query, mode: "artlist", format: "json", sort: "datedesc", maxrecords: String(Math.min(req.limit ?? 50, 250)), startdatetime: gdeltTime(since), enddatetime: gdeltTime(req.now) });
    const body = await getJson<{ articles?: GdeltArticle[] }>(this.fetchFn, this.name, `${this.baseUrl}?${params}`).catch((e) => {
      // GDELT answers some malformed queries with a plain-text explanation instead of JSON.
      if (e instanceof SourceError && /not JSON/.test(e.message)) return { articles: [] };
      throw e;
    });
    return (body.articles ?? []).map((a) => {
      const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(a.seendate);
      const at = m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : req.now.toISOString();
      const lang = a.language ? LANGUAGE_CODES[a.language.toLowerCase()] : undefined;
      return {
        network: "news" as const,
        kind: "mention" as const,
        externalId: a.url,
        authorHandle: a.domain,
        authorName: a.domain,
        text: a.title,
        url: a.url,
        parentExternalId: null,
        occurredAt: at,
        raw: a,
        ...(lang ? { lang } : {}),
      };
    });
  }
}

/** Every public mention search this deployment can use. */
export function createMentionSearches(env: NodeJS.ProcessEnv = process.env): MentionSearch[] {
  const all: MentionSearch[] = [
    new BlueskyMentionSearch({ ...(env.BASE_AIR_BLUESKY_SEARCH_TOKEN ? { token: env.BASE_AIR_BLUESKY_SEARCH_TOKEN } : {}) }),
    new MastodonTagSearch({ ...(env.BASE_AIR_MASTODON_SEARCH_INSTANCES ? { instances: env.BASE_AIR_MASTODON_SEARCH_INSTANCES.split(",") } : {}) }),
    new YouTubeMentionSearch({ apiKey: env.YOUTUBE_API_KEY }),
    new GdeltNewsSearch(),
  ];
  const only = env.BASE_AIR_MENTION_SOURCES?.split(",").map((s) => s.trim()).filter(Boolean);
  return (only?.length ? all.filter((s) => only.includes(s.name)) : all).filter((s) => s.configured);
}
