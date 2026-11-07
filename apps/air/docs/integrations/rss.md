# RSS / Atom feeds

Connector `rss` · network `rss` (listen only) · `packages/connectors/src/rss.ts` (+ parser `feed-parse.ts`) · factory `createRssConnectors(env)`

Follow any RSS or Atom feed: blogs, news sites, press rooms, podcasts, changelogs, forums, Google Alerts, a subreddit's
`.rss`, a YouTube channel's feed. New items show up in the live feed and the tracker scans them, like mentions from social networks.

## What works
- **Connect** (`connectMethod: "webhook_url"`, the form takes a URL). Inputs: **Feed URL** (http or https, required) and **Name** (optional).
  - A URL without a scheme gets `https://`.
  - base air fetches the URL once to check that it is a feed and to read its title.
  - If you paste a website address instead of the feed, base air reads the page's `<link rel="alternate" type="application/rss+xml|atom+xml">` and uses the feed it advertises.
  - One account per feed URL: externalId = the feed URL (without `#fragment`); handle = your name, else the feed title, else the host.
  - Auth: `{ feedUrl }`. Config: `{ feedUrl, title, siteUrl, host, format, language, name }`.
- **Listen** (`fetchActivity(account, since)`): GET the feed with `If-None-Match` / `If-Modified-Since` from the previous answer. Validators are kept in memory per account and feed, so one workspace's 304 never hides items from another. A 304 returns nothing. Validators are saved only after a body parses.
  - Formats: **RSS 2.0** (and 0.9x), **RSS 1.0 / RDF**, **Atom 1.0**. The parser handles:
    - CDATA and XML entities, numeric references, and common HTML entities that feeds use illegally
    - double-escaped HTML in descriptions
    - namespaces whatever their prefix: `content:encoded`, `dc:creator`, `dc:date`, `dc:language`, `atom:link rel="alternate"` inside RSS
    - Atom `type="text|html|xhtml"`
    - `xml:lang`
    - relative links (resolved against the feed URL)
    - ISO-8859-1 and other encodings (from Content-Type, else the XML declaration)
    - unclosed tags and stray `&`
  - Not a feed any more (for example an HTML error page) → `rejected` error.
  - Each item → activity:
    - `kind: "mention"`, `network: "rss"`.
    - `externalId` = guid / Atom id, else the link, else a hash of title+date+summary. Plain guids like `1234` are prefixed with the feed URL (`<feed>|1234`) because they repeat across feeds. Ids that are already URLs, `tag:` or `urn:` URIs are kept as is, so one article syndicated in two feeds stays one item.
    - `text` = title, a blank line, then the plain-text body. The body is `content:encoded` / Atom `content` when present, else `description` / `summary`. HTML, scripts and styles are stripped, and the text is capped at 4000 characters.
    - `url` = the item link (http/https only).
    - `authorHandle` = feed host (without `www.`). `authorName` = item author (`author`, `dc:creator`, Atom author; for `email (Name)` only the name; a bare e-mail address is never shown), else the feed title.
    - `occurredAt` = `pubDate` / `dc:date` / Atom `published` / `updated`. When missing or unreadable, the time of the poll is used. Dates more than 5 minutes in the future are pinned to now.
    - `conversation` = `{ id: feed URL, name: feed title, type: "channel" }`.
    - `lang` = primary subtag of the entry's `xml:lang`, else the feed's `<language>` / `dc:language` / `xml:lang` (`en-GB` → `en`).
    - `raw` = `{ feed: { url, title }, item: <parsed item> }`.
  - Which items: when `since` is set, only items dated after it (at most 200 per poll). On the first run (`since` null), the newest 50. Undated items are returned once per process (core also deduplicates on externalId).
- **Fetch safety**:
  - Only http/https URLs are fetched, at every redirect hop. Redirects are followed by hand (at most 5) and each target is re-checked, so a redirect to `file:`, `ftp:`, a private address or cloud metadata is refused.
  - Private, loopback and link-local hosts are refused, including hostnames that resolve to them, unless `BASE_AIR_ALLOW_PRIVATE_URLS=1`.
  - Responses are capped at 5 MB (declared or streamed), with a 20 s timeout including the body.
  - DTD entities are never expanded (no XXE, no "billion laughs").
  - The `User-Agent` is `Base-Air-RSS/1 (+<BASE_AIR_PUBLIC_URL>)`.
- **Errors**: 5xx/408/transport/timeout → `network`, retryable. 429 → `rate_limit`, retryable (`Retry-After` in the cause). 401/403 → `auth` (the feed needs a login or blocks automated readers). 404/410 → `rejected` (the feed is gone). Too large, too many redirects, or not a feed → `rejected`.
- **Capabilities**: `fetchActivity` true. `publish` is false (`publish` throws `rejected`). Reply, moderate, metrics, account metrics and webhooks are all false.

## Setup
1. Find the feed URL. Look for an RSS icon, or try `/feed`, `/rss`, `/atom.xml` or `/index.xml`, or just paste the site's address. Some common sources:
   - Google Alerts: choose "Deliver to: RSS feed".
   - Reddit: `https://www.reddit.com/r/<sub>/.rss`.
   - YouTube channel: `https://www.youtube.com/feeds/videos.xml?channel_id=<id>`.
2. In base air: Accounts → Connect → RSS / Atom, paste the URL, and optionally a name.
3. Add the account to a stream, or add tracker keywords. New items flow into the live feed at the listening poll interval.
- Env vars: none required. `BASE_AIR_PUBLIC_URL` (optional) is shown in the User-Agent. `BASE_AIR_ALLOW_PRIVATE_URLS=1` (self-hosted only) allows feeds on intranet hosts.
- Redirect URI: none. Webhook URL: none (polling only).

## What base air can and cannot see
- **Can see**: what the feed publishes to everyone: titles, summaries or full text when the feed includes it, links, author names and dates.
- **Cannot see**: pages behind a login or paywall, comments on the articles, anything not in the feed, or items that dropped out of the feed between two polls. Feeds that require a login are not supported (no credentials are sent).

## Review and access requirements
None. Public feeds need no approval. Respect each site's terms: some sites forbid automated reading or reuse of their full text.

## Limits and quotas
- One feed per account; 5 MB per response; 20 s timeout; 5 redirects.
- 50 items on the first poll, 200 per later poll, 4000 characters of text per item.
- Polling frequency is base air's listening interval. Conditional requests keep most polls to a 304. Some hosts rate-limit aggressive pollers (Reddit in particular); a 429 is retried later.
- Validators and the "seen undated items" set live in memory. After a restart, the first poll downloads the feed in full and relies on `since` and core deduplication.

## Unverified
- Nothing depends on a third-party API. The formats follow the RSS 2.0, RSS 1.0 and Atom (RFC 4287) specifications. Unusual dialects (iTunes-only fields, JSON Feed, Media RSS-only items without a title or description) are not read. JSON Feed is not supported.
- Items whose `pubDate` is earlier than the previous poll (a feed that publishes with a delay) can be missed when `since` is later than their date. Core decides `since`.

## Questions for the owner
- Should feeds also be offered to the trend radar as a source, beyond the live feed and tracker?
- Do you want JSON Feed support, or feeds behind HTTP Basic auth (credentials stored encrypted)?
- Should items carry the feed's categories/tags (for routing to streams), and should media enclosures (podcast audio, images) be kept?
- Is "mention" the right kind for your own blog's feed, or should a feed you own be marked `own_post`?
