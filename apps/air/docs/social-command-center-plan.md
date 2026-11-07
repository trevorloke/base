# Social Command Center: Product & Technical Plan

*Working title. Drafted 2026-11-01. Hootsuite/Sprinklr publishing + old-Google-Analytics-style reporting + X-analytics depth + a trend radar, built for an agency workflow.*

---

## 1. What this is

One app with four pillars, sharing one data model:

| Pillar | What it does | Closest analogue |
|---|---|---|
| **Publish** | Compose once, adapt per channel, schedule, approve, post. Queue with retries, media handling, link tracking. | Hootsuite, Buffer |
| **Listen** | Live unified feed of every connected channel (own posts, mentions, replies, DMs, keyword/competitor streams), filterable, with alerting. | Sprinklr, TweetDeck |
| **Measure** | Per-post and per-channel analytics stored as time series you own. Cohorts, funnels, custom segments, scheduled reports. | Old Google Analytics, X Analytics |
| **Trend radar** | Google Trends + platform trend sources + your own feed velocity, scored and ranked in near real time, with "post about this now" suggestions. | Exploding Topics, Glimpse |

Agency layer on top: workspaces per client, roles, approval flows, white-label PDF/HTML reports, content calendar per client.

---

## 2. The constraints that shape everything: platform APIs (verified Nov 2026)

This is the part most people underestimate. Posting and reading on each network is gated differently, and several gates take weeks to months.

| Channel | Posting | Reading feeds / analytics | Gate & timeline | Cost |
|---|---|---|---|---|
| **X** | Pay-per-use API (fixed Basic/Pro tiers closed to new devs since Feb 2026) | Reads metered, ~$0.005/post returned, cap ~2M reads/mo | No review for posting; rate limit ~100 posts/15 min/user | ~$0.015/post, ~$0.20/post with a link; reads add up fast for live feeds |
| **Instagram + Facebook** | Graph API, two-step container publish; business/creator accounts only | Insights API, comments, mentions | Meta App Review + Business Verification for Advanced Access (needed to post for accounts you don't own). ~2–4 weeks per submission; dev mode allows test users only | Free |
| **Threads** | Threads API (Meta), same review family | Insights + replies | Meta App Review | Free |
| **TikTok** | Content Posting API | Research/Display APIs limited | App audit required; until passed, posts are forced private. UX rules (creator nickname, commercial-content toggle, music consent). 2–6 weeks reported | Free |
| **LinkedIn** | Own profile: open. Company pages: Community Management API | Page analytics via same product | Partner approval for company pages; weeks to months, and they ask about multi-tenant data isolation | Free |
| **YouTube** | Data API upload/update | Analytics API | Standard quota (10k units/day) and a quota-extension audit for scale | Free |
| **Bluesky** | AT Protocol, open | Public firehose/Jetstream, open | None | Free |
| **Pinterest** | Pinterest API | Analytics | App review | Free |

**Implication:** a from-scratch build cannot post to Instagram, TikTok, or LinkedIn company pages for other people until reviews clear. Plan to apply for all of them in week one and build around the gap.

### Build vs. buy for connectors

Recommendation: **buy the publishing plumbing for the MVP, own everything above it.**

- **Zernio (formerly Late)**: usage-based, first 2 accounts free, then roughly $6 → $3 → $1 per account/month on a sliding scale. Covers posting to ~10+ networks under their already-approved apps. Cheapest hosted path that is production-ready.
- **Postiz**: open source, self-hostable, free. Good fallback and a reference implementation of OAuth flows per network. Cloud from ~$29/mo.
- **Ayrshare**: most mature (analytics, comments, DMs too) but $149/mo for one profile, $299 for 10, $599 for 30. Expensive at agency scale.

Buying connectors gets you posting to all channels in week two instead of month three. Native integrations come later, starting with the ones where you need depth the aggregators don't give you (X reads for the live feed, Meta Insights for analytics). The analytics, listening, and trend layers are the actual product, and no aggregator sells those well.

---

## 3. Trend and listening data sources

| Source | Access | Use |
|---|---|---|
| **Google Trends official API** | Alpha, invite only, apply at developers.google.com/search/apis/trends. Consistent scaling, 5 years of history | Core of the trend radar. Apply day one. |
| **Google Trends fallback** | Third-party providers (SerpApi, Scrapfly, etc.) or the unmaintained pytrends | Bridge until alpha access lands |
| **Google Trends RSS "Trending now"** | Public RSS per geo | Free realtime "what's spiking right now" feed |
| **TikTok Creative Center** | Free browsable; hashtag/song/creator trends, ~1-day lag | Scrape or vendor actor; check ToS |
| **Reddit** | Official API (OAuth, free tier limited) | Subreddit velocity for niche trends |
| **X** | Metered reads via API | Keyword/hashtag streams; budget-capped |
| **Bluesky Jetstream** | Free firehose | Cheap real-time text signal, good for early-detection experiments |
| **YouTube Data API** | Free, quota | Trending videos per region/category |
| **Exploding Topics API** | Paid | Validated emerging topics with growth curves |
| **Wikipedia pageviews API** | Free | Surprisingly good public-attention proxy |
| **Your own feeds** | Owned | Velocity of engagement on your and competitors' posts |

Trend score = blend of normalized velocity, acceleration, cross-source agreement, and relevance to each client's topic profile. Use Claude to cluster raw signals into named topics and write the "why this matters for client X" explainer.

---

## 4. Architecture

```
                 ┌──────────────────────────────────────────┐
                 │  Web app (Next.js + TypeScript, React)    │
                 │  Composer · Calendar · Live Feed · Reports│
                 │  Trend Radar · Admin                      │
                 └───────────────┬──────────────────────────┘
                                 │ tRPC / REST + SSE for live feed
┌───────────────────────────────┴──────────────────────────────────┐
│ API server (Node/TypeScript)                                       │
│  Auth (Clerk or Auth.js) · Workspaces/RBAC · Approvals             │
└───────┬──────────────────┬─────────────────────┬──────────────────┘
        │                  │                     │
┌───────▼───────┐ ┌────────▼────────┐  ┌─────────▼──────────┐
│ Scheduler     │ │ Ingestion       │  │ Trend engine        │
│ BullMQ+Redis  │ │ workers         │  │ workers             │
│ publish jobs, │ │ poll/webhook per│  │ pull sources, score,│
│ retries,      │ │ channel, normal-│  │ cluster (Claude),   │
│ per-channel   │ │ ize to Activity │  │ alert               │
│ rate limits   │ │ + Metric rows   │  │                     │
└───────┬───────┘ └────────┬────────┘  └─────────┬──────────┘
        │                  │                     │
┌───────▼──────────────────▼─────────────────────▼──────────┐
│ Connector layer: one interface, N adapters                 │
│  ZernioAdapter (MVP) · XAdapter · MetaAdapter · BlueskyAdapter│
│  TikTokAdapter · LinkedInAdapter · YouTubeAdapter          │
└──────────────────────────┬────────────────────────────────┘
                           │
┌──────────────────────────▼────────────────────────────────┐
│ Postgres (Neon/Supabase) + TimescaleDB extension           │
│  relational: workspaces, accounts, posts, approvals        │
│  hypertables: metrics (per post/account/hour), trend_points│
│ Object storage (S3/R2) for media                           │
└───────────────────────────────────────────────────────────┘
```

Why this stack:
- **TypeScript end to end** keeps one language across UI, API, and workers. Matches your existing React/Vite experience.
- **BullMQ + Redis** is the standard Node job queue: delayed jobs for scheduled posts, per-channel concurrency limits, retries with backoff.
- **TimescaleDB** turns Postgres into a time-series store, so "impressions per hour for this post over 30 days" is one SQL query and you keep one database.
- **Connector interface** with `publish()`, `fetchActivity(since)`, `fetchMetrics(postIds)`, `refreshAuth()`: swap Zernio out for native adapters channel by channel with no changes above.
- **Claude** (claude-sonnet-5-5 for bulk, claude-opus-5-5 for reports) for per-channel copy adaptation, topic clustering, and natural-language report narration.
- **Hosting**: Vercel (web) + Railway or Fly (workers, Redis) + Neon (Postgres) + Cloudflare R2 (media). Or all on Render, which you already use.

### Core data model

- `workspace` (client) → `member` (role: owner/editor/approver/viewer)
- `social_account` (workspace, network, external_id, auth tokens encrypted, connector)
- `post` (workspace, status: draft/pending_approval/scheduled/publishing/published/failed, scheduled_at, base content)
- `post_variant` (post, social_account, adapted text, media, external_post_id, published_at)
- `activity` (normalized inbound item: mention, reply, DM, comment, own_post; network, author, text, timestamps, sentiment, matched_streams)
- `stream` (saved search: keywords, accounts, networks, per workspace)
- `metric` hypertable (entity_type, entity_id, metric_name, value, observed_at)
- `trend_topic` + `trend_point` hypertable (topic, source, score, observed_at)
- `report` (workspace, template, schedule, last_rendered)

---

## 5. Roadmap

**Phase 0: Foundations (weeks 1–2)**
- New repo, monorepo (`apps/web`, `apps/api`, `apps/workers`, `packages/connectors`, `packages/db`).
- Auth, workspaces, roles. Postgres + Timescale schema. Redis + BullMQ running.
- Submit applications: Meta App Review, TikTok Content Posting audit, LinkedIn Community Management, YouTube quota, Google Trends alpha, X developer account with pay-per-use billing.

**Phase 1: Publish (weeks 3–5)**
- Connect accounts via Zernio. Composer with per-channel variants and previews. Media upload to R2. Calendar view. Scheduler with retries and failure notifications. Approval flow (draft → pending → approved → scheduled).
- Native Bluesky and X adapters (no review needed) to prove the adapter interface.

**Phase 2: Listen + Measure (weeks 6–9)**
- Ingestion workers per channel: own posts, comments, mentions, DMs where allowed. Normalize to `activity`. Live feed UI with columns (TweetDeck style), filters, keyword streams, SSE updates.
- Metrics collection on a schedule (hourly for the first 72 hours after a post, then daily). Per-post, per-account, per-workspace dashboards. Best-time-to-post from your own history.
- Link shortener with UTM tagging so web traffic ties back to posts.

**Phase 3: Trend radar (weeks 10–13)**
- Source pullers: Google Trends (alpha or fallback), Trends RSS, YouTube trending, Reddit, Bluesky Jetstream sample, Wikipedia pageviews, own-feed velocity.
- Scoring + Claude clustering into topics. Per-workspace relevance profiles. Radar UI with sparkline per topic, "rising / peaking / fading" state, one-click "draft a post about this".
- Alerts (email, Slack, in-app) when a topic crosses a threshold relevant to a client.

**Phase 4: Agency layer (weeks 14–16)**
- Client-facing scheduled reports (PDF/HTML, white label), narrated by Claude. Competitor tracking per client. Audit log. Billing per workspace if you sell it.

**Ongoing:** replace Zernio with native adapters as reviews clear, starting with Meta (for Insights depth).

---

## 6. Running costs (rough, MVP with ~10 client workspaces, ~40 connected accounts)

| Item | Monthly |
|---|---|
| Zernio connectors (40 accounts) | ~$100–150 |
| X API reads for live feeds (budget-capped) | $50–300 depending on stream volume |
| Neon Postgres + Timescale | $20–70 |
| Redis + workers (Railway/Fly) | $20–50 |
| Vercel | $20 |
| Cloudflare R2 | <$10 |
| Claude API (adaptation, clustering, reports) | $30–150 |
| Exploding Topics API (optional) | varies, paid tier |
| **Total** | **~$250–750/mo** |

Native connectors later remove the Zernio line but add review and maintenance effort.

---

## 7. Decisions I need from you before writing code

1. **Where it lives.** This session only has access to the `redlines-game` repo, which is the Red Lines game. This app needs its own repo. Create one (suggested name: `social-command-center` or whatever you prefer) and grant this session access, or tell me to scaffold into a folder here temporarily.
2. **Connectors: buy first or native first?** My recommendation is Zernio for the MVP with native X and Bluesky immediately. If you'd rather go fully native from day one, the first posting-capable channels are X, Bluesky, and your own LinkedIn profile, and Instagram/TikTok/LinkedIn pages arrive only after reviews.
3. **X spend ceiling.** Live X feeds are the one metered cost that can run away. Give me a monthly cap and I'll build the budget guard in.
4. **Single-tenant or agency from day one?** The schema above is multi-workspace either way, but if it's just you for now I'll skip approvals and billing in Phase 1.

Once you answer 1 (and ideally 2), the first deliverable is the Phase 0 scaffold with the connector interface, schema, scheduler, and a working Bluesky + X post from the composer.

---

---

# Part II: Futureproofing and the moat

*Added 2026-11-01 after a second pass on where the market and the tech are heading.*

## 8. Where the tech is converging (and what it means for the build)

Six shifts are visible right now. Each one is a design constraint, not a trend to admire.

**1. Agents are table stakes, not a differentiator.**
Sprout rolled its Trellis agents across publishing, listening, inbox, and reporting in mid-2026. Sprinklr ships autonomous workflows with a pre-launch evaluation layer. Hootsuite relaunched as a "Social OS" in June 2026 with three remote MCP servers (Perch for publishing and analytics, Nest for inbox, Lumen for listening via Talkwalker) that plug into ChatGPT, Claude, and Copilot. "We have AI" is a feature every incumbent has by Q1 2027.
*Implication:* don't position on AI features. Position on what the AI reasons over: your data, your feedback loop, your client context.

**2. MCP is becoming the distribution surface.**
When a marketer can say "schedule this to all client channels" inside Claude or ChatGPT, the chat window is the UI and the tool is whichever MCP server is connected. Hootsuite saw this; so did Zernio, Ayrshare, Postiz, and Metricool.
*Implication:* build headless-first. Every capability is a typed tool with a schema. The web UI and the MCP server are two thin clients over the same API. Ship the MCP server in Phase 1, not Phase 4.

**3. Platform data is being enclosed. Fast.**
Reddit ends RSS on Nov 13, 2026 and shuts its public Data API by March 2027, keeping licensed access for a handful of large listening vendors. X moved to metered pay-per-use. Meta and TikTok gate everything behind review. Google Trends is invite-only alpha.
*Implication:* historical, normalized, cross-channel data you have already captured becomes scarcer and more valuable every month. Capture raw payloads from day one, immutably. A dataset nobody can rebuild is the most durable moat available to a small team.

**4. Analytics is expanding from "social" to "where attention actually lives," including AI answers.**
Gartner's 2026 Magic Quadrant explicitly frames the category around AI, social search, and analytics. Sprinklr launched "LLM Insights" in June 2026 to track brand visibility inside ChatGPT, Gemini, and Perplexity. Profound raised $96M at a $1B valuation in Feb 2026 doing only that. Hootsuite's Gartner placement was tied to its Talkwalker social-search pairing.
*Implication:* the "old Google Analytics" ambition is right, but the surfaces have changed. Add an AI-answer visibility pillar (how often, and how, do ChatGPT/Perplexity/Gemini/Google AI Overviews mention each client) alongside social metrics. Same time-series store, same reports.

**5. Provenance and disclosure are becoming infrastructure.**
TikTok joined the C2PA steering committee in July 2026 and auto-labels content carrying credentials. LinkedIn displays a "CR" badge. EU AI Act Article 50 transparency obligations took effect August 2026. Platforms still strip metadata on upload, so the credential alone isn't enough.
*Implication:* sign every exported media file with C2PA, keep an internal disclosure record per post (what was AI-assisted, by whom, approved by whom), and surface it in client reports. Agencies will need this for enterprise clients; most tools don't have it.

**6. Open protocols are the stable ground.**
AT Protocol (Bluesky) remains fully open with a free realtime firehose. Fediverse/ActivityPub too. These are small in reach but large in signal quality and zero in platform risk.
*Implication:* use open networks as the always-available real-time signal layer for trend detection, and as the proving ground for new features before they hit gated networks.

## 9. The moat: what protects value

Honest framing first. A 16-week build of composer + scheduler + feed + dashboards is not a moat. Buffer and Postiz give that away; incumbents have agents. The moat has to come from things that compound with time and usage and are hard to copy even with the same code.

### Moat 1: The outcome ledger (proprietary data, compounding)
Every post goes out with a full record of its context: which trend it rode, how far along the trend curve it was, which channel variant, what time, which audience segment, what the approver changed, and then the engagement curve at 1h/6h/24h/72h/7d plus downstream clicks and conversions via your link layer.
Nobody else has the trend-to-outcome join at the per-post level, because listening tools and publishing tools are different products at every incumbent. This is the dataset that eventually powers "will this work?" predictions, best-time models per client, and trend-relevance scoring that improves with every post. Reddit's and X's enclosure make the historical part un-rebuildable.
*Build requirement:* append-only `raw_event` store from day one; never discard original payloads; every derived table must be re-computable from raw.

### Moat 2: The client context graph (switching cost)
Per workspace: brand voice examples and rules, audience personas, competitor set, approved/rejected drafts with reasons, campaign history, performance by topic. Stored as structured records plus embeddings in pgvector. Every Claude call is grounded in it. After six months a client's graph is something they cannot export to a competitor and get the same quality from, even if you give them the CSV.
*Build requirement:* treat approvals and edits as training signal, not just workflow state. Capture the diff between AI draft and human-published version.

### Moat 3: Closed-loop trend radar (unique capability)
Everyone shows trends. Almost nobody tells you *your* outcome when you acted on a trend at a given stage, across *your* channels, and uses that to rank the next trend. This is Moat 1 applied, and it gets better the more you post. It's also the most defensible against incumbents because they would need to cross-wire two product lines and two data teams.

### Moat 4: Agent-surface distribution (channel ownership)
Be the MCP server a marketer connects, and own the OAuth relationship with the platforms so the agent route goes through you. Once a client's Claude/ChatGPT is wired to your server with their accounts connected, you're infrastructure, not a tab they visit.

### Moat 5: Trust and compliance posture (enterprise door-opener)
C2PA signing, AI-disclosure records, approval audit logs, data residency per workspace, exportable everything. Small teams almost never do this early; enterprise and regulated clients won't buy without it. This is cheap to design in now and expensive to retrofit.

### What is NOT a moat (avoid over-investing)
- Number of networks supported. Aggregators commoditized this.
- Prettier composer or calendar. Table stakes.
- A specific LLM. Models will change three times before launch. Stay model-agnostic behind one gateway with an eval set.
- Scraped data sources. They break and now carry legal risk; use them only as bridges and never make a feature depend on one.

## 10. Architecture changes this forces

Changes to Section 4 and the roadmap, in priority order:

1. **Event store first.** `raw_event` table (or object-storage partition) with source, received_at, payload JSONB, immutable. Every connector writes raw first, then normalizes. Add `derivation_version` on derived tables so they can be rebuilt when models improve.
2. **Headless API + MCP server in Phase 1.** New package `apps/mcp` exposing the same tool schemas the UI uses: `create_post`, `schedule`, `list_feed`, `get_metrics`, `get_trends`, `draft_for_trend`, `request_approval`. Agent actions always land in the approval queue unless a workspace policy says otherwise.
3. **pgvector alongside Timescale.** Embeddings for posts, activities, brand examples, and trend topics. Enables semantic feed search, "find similar past posts that worked," and grounded drafting.
4. **Outcome ledger tables.** `post_outcome` (metric snapshots at fixed offsets), `trend_action` (post ↔ trend_topic ↔ trend stage at publish time), `approval_diff` (AI draft vs. published).
5. **Model gateway.** One module wrapping Claude (claude-sonnet-5-5 default, claude-opus-5-5 for reports and clustering) with prompt versioning and a small eval set built from your own approvals. Swappable provider.
6. **Media pipeline with provenance.** Transcode, caption, transcribe (for video), and C2PA-sign on export. Store the disclosure record with the post.
7. **AI-answer visibility pillar.** Scheduled prompts against ChatGPT, Perplexity, Gemini, and Google AI Overviews per client, recording mentions, position, sentiment, and cited sources into the same metric store. Phase 3 alongside the trend radar.
8. **Policy layer per workspace.** Autonomy level (suggest / draft / schedule-with-approval / autopost), spend caps (X reads), disclosure defaults. Agents, UI, and MCP all respect the same policy object.
9. **Open-network signal layer.** Bluesky Jetstream consumer from Phase 2; cheap, real-time, no key risk. Use it to prototype velocity detection before pointing it at metered X reads.
10. **Export everything.** Per-workspace full export (JSON + CSV) from day one. It builds trust, and it's a requirement for enterprise buyers.

Revised roadmap deltas: Phase 1 adds the event store and MCP server (adds ~1 week). Phase 2 adds Jetstream and outcome snapshots. Phase 3 adds AI-answer visibility. Phase 4 adds C2PA and compliance reports. Total ~18 weeks instead of 16.

## 11. Positioning in one line

"The outcome engine for social: it watches every channel and every trend, acts through your agents, and learns what actually works for each client, with a provenance trail enterprises can sign off on."

Hootsuite and Sprinklr sell seats and workflows. This sells compounding knowledge per client, delivered wherever the marketer already works.

---

## Sources (Part II)

- Incumbent agents: [Sprout Social Q1 2026 updates](https://sproutsocial.com/product-updates/2026-q1/), [rework.com agent grading](https://resources.rework.com/tools/ai-agents/best-ai-agents-for-social-media-2026), [buildmvpfast.com](https://www.buildmvpfast.com/articles/best-llms-2026-guide/social-media-ai), [socialneuron.com](https://socialneuron.com/blog/ai-agents-social-media-2026), [velocity.li](https://www.velocity.li/blog/ai-social-agents-2026)
- Hootsuite MCP servers: [hootsuite.com/integrations/mcp](https://www.hootsuite.com/integrations/mcp), [usecarly.com](https://www.usecarly.com/blog/claude-hootsuite-integration/), [eden.so](https://eden.so/blog/best-social-media-mcp-servers/)
- Social MCP landscape: [sociality.io](https://sociality.io/blog/best-social-media-mcp-servers/), [post-bridge.com](https://www.post-bridge.com/best-social-media-mcp-servers), [bundle.social](https://bundle.social/social-media-mcp-server), [blotato.com](https://www.blotato.com/blog/best-social-media-mcp-servers), [posteverywhere.ai](https://posteverywhere.ai/blog/social-media-mcp-servers), [socialync.io](https://socialync.io/blog/best-social-media-mcp-servers-2026)
- Reddit API shutdown: [ppc.land](https://ppc.land/reddit-to-halt-public-data-api-access-in-march-2027-as-14-000-apps-register/), [techwyse.com](https://www.techwyse.com/news/social-media/reddit-rss-feeds-ending-public-api-shutdown-2027), [shellypalmer.com](https://shellypalmer.com/2026/10/reddit-tightens-access-to-its-data/), [beri.net](https://www.beri.net/article/reddit-public-api-shutdown-march-2027-social-listening-ai-data-license-deadlines), [buildmvpfast.com](https://www.buildmvpfast.com/blog/reddit-api-shutdown-rss-social-listening-2026)
- Gartner 2026 SMML Magic Quadrant: [cxtoday.com](https://cxtoday.com/gartner-magic-quadrant-for-social-media-management-and-listening-2026-the-rundown)
- AI-answer visibility market: [airops.com Profound vs Peec](https://www.airops.com/blog/profound-vs-peec-comparison-2026), [rankability.com](https://www.rankability.com/blog/best-ai-search-visibility-tracking-tools), [clearscope.io](https://www.clearscope.io/blog/Best-AI-Search-Visibility-Tools-for-2026), [frase.io](https://frase.io/blog/the-10-best-ai-visibility-tools-in-2026), [datadab.com](https://www.datadab.com/research/ai-visibility-tools-compared)
- C2PA and disclosure: [c2pa.org TikTok steering committee](https://c2pa.org/c2pa-welcomes-tiktok-to-steering-committee/), [c2pa.org Content Credentials 2.3](https://c2pa.org/the-c2pa-launches-content-credentials-2-3-and-celebrates-5-years-of-impact-across-the-digital-ecosystem/), [softwareseni.com](https://www.softwareseni.com/what-is-c2pa-and-how-does-content-provenance-infrastructure-work/), [makeinfluence.com](https://www.makeinfluence.com/en/academy/content-credentials-c2pa-how-platforms-label-ai-assisted-content), [storrito.com TikTok labeling](https://storrito.com/resources/tiktoks-2026-ai-labeling-rules-and-what-they-signal-for-platform-governance), [billo.app](https://billo.app/?p=52174)


## Sources (Part I)

- X API pricing: [outstand.so](https://www.outstand.so/blog/x-api-pricing), [postproxy.dev](https://postproxy.dev/blog/x-api-pricing-2026/), [elfsight.com](https://elfsight.com/blog/how-to-get-x-twitter-api-key-in-2026/), [data365.co](https://data365.co/guides/twitter-api-limitations-and-pricing), [wearefounders.uk](https://www.wearefounders.uk/the-x-api-price-hike-a-blow-to-indie-hackers/), [socialcrawl.dev](https://www.socialcrawl.dev/blog/x-twitter-api-2026), [postzen.dev](https://www.postzen.dev/blog/twitter-api-pricing)
- Google Trends API alpha: [medium.com](https://medium.com/@wordstotech/google-trends-api-95d50970cd46), [scrapegraphai.com](https://scrapegraphai.com/blog/google-trends-api), [scrapfly.io](https://scrapfly.io/blog/posts/google-trends-api-alternatives), [lilachbullock.com](https://www.lilachbullock.com/google-trends-api/), [scrapebadger.com](https://scrapebadger.com/blog/does-google-trends-have-an-api-what-to-use-in-2026), [risingtrends.co](https://www.risingtrends.co/blog/google-trends-api)
- Meta / Instagram publishing: [developers.facebook.com overview](https://developers.facebook.com/documentation/instagram-platform/overview), [content publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing), [bundle.social](https://bundle.social/blog/instagram-graph-api), [postproxy.dev](https://postproxy.dev/blog/post-to-instagram-via-api/), [getphyllo.com](https://www.getphyllo.com/post/instagram-api-integration-101-for-developers-of-the-creator-economy)
- TikTok Content Posting audit: [developers.tiktok.com](https://developers.tiktok.com/doc/content-sharing-guidelines), [bundle.social](https://bundle.social/blog/tiktok-api-approval), [getphyllo.com](https://www.getphyllo.com/post/tiktok-api-integration-guide-2026-setup-endpoints-common-pitfalls), [postiz issue #1362](https://github.com/gitroomhq/postiz-app/issues/1362)
- LinkedIn Community Management API: [bundle.social](https://bundle.social/blog/linkedin-api-permissions), [postproxy.dev](https://postproxy.dev/blog/linkedin-api-automate-company-page-publishing/), [opentweet.io](https://opentweet.io/answers/can-i-post-to-linkedin-without-partner-approval), [zernio.com](https://zernio.com/blog/linkedin-posting-api)
- Bluesky / AT Protocol: [ayrshare.com guide](https://www.ayrshare.com/blog/complete-guide-to-bluesky-api-integration-authorization-posting-analytics-comments.md), [zuplo.com](https://zuplo.com/blog/2025/03/12/bluesky-api), [softwareseni.com](https://www.softwareseni.com/comparing-developer-apis-and-ecosystems-of-threads-and-bluesky)
- Unified posting APIs: [dev.to price comparison Oct 2026](https://dev.to/perufitlife/9-social-media-posting-apis-compared-by-price-october-2026-read-from-each-pricing-page-509b), [buffer.com](https://buffer.com/resources/best-social-media-apis/), [socialchamp.com](https://www.socialchamp.com/blog/best-social-media-apis/), [blotato.com](https://www.blotato.com/blog/best-social-media-api-tools), [upload-post.com](https://www.upload-post.com/best-social-media-apis/), [getsocialclaw.com](https://getsocialclaw.com/blog/cheapest-social-media-api)
- Trend tools: [explodingtopics.com vs Glimpse](https://explodingtopics.com/blog/exploding-topics-vs-glimpse), [explodingtopics.com dashboard](https://explodingtopics.com/blog/dashboard-announcement), [skedsocial.com](https://skedsocial.com/en-au/blog/find-trends-social-media), [Trends MCP](https://mcpservers.org/servers/trendsmcp/trends-mcp), [Apify trend radar](https://apify.com/yasaslive/cptr-trend-radar.md)
