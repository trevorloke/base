# Reddit

Connector name `reddit`, network `reddit`, file `packages/connectors/src/reddit.ts`, factory `createRedditConnectors(env)`.
OAuth 2.0 runs on `https://www.reddit.com/api/v1`; the Data API on `https://oauth.reddit.com`.

> **Policy status (November 2026): read this before relying on Reddit.** Under the Responsible Builder Policy (late 2025), creating a new app requires Reddit's manual approval. On 2026‑09‑30 Reddit announced a move of Data API apps to its Developer Platform (Devvit): app registration was due 2026‑09‑30, **new requests for public Data API access stopped being accepted after 2026‑10‑31**, Reddit begins removing access from unregistered apps on 2027‑01‑12, and **remaining public Data API access ends in March 2027**. Credentials that were already approved still work. It is not clear whether a multi-tenant scheduler posting on users' behalf will be offered a path after March 2027; commercial use already required a written agreement. These dates come from secondary coverage of Reddit's posts (sources listed under Unverified). **Unless base air already holds an approved, registered OAuth app, this connector cannot be enabled in production.**

## What works

| Area | Status |
|---|---|
| Connect | Standard authorization-code OAuth through `OAuth2Client`, with `duration=permanent` so a refresh token is issued, and Basic `client_id:secret` at `/api/v1/access_token`. Reddit has no PKCE. One login connects one user: `externalId` = `t2_<id>`, `handle` = `u/<name>`, `displayName` = profile title. Subreddits the user moderates are posting targets, not separate accounts. |
| User-Agent | Every call sends `REDDIT_USER_AGENT`, including token exchange and refresh. |
| Refresh | Access tokens last 1 h. `refreshAuth` uses the permanent refresh token and keeps it, because Reddit does not rotate it. |
| Publish: text | `POST /api/submit` with `kind=self`, `text` = the post text. |
| Publish: link | `kind=link`, `url=options.link`, chosen when `options.kind === "link"` or a link is set with no media. |
| Publish: image | Media lease `POST /api/media/asset.json` → multipart upload to the S3 `action` with the lease fields → `kind=image` with the uploaded URL. |
| Publish: video | Same lease flow for the video and for a **required poster image** (`options.thumbnailUrl`, uploaded too), then `kind=video` with `video_poster_url`. |
| Publish: gallery (2–20 images) | Each image is leased, then `POST /api/submit_gallery_post.json` sends `items[{media_id, caption (alt text, ≤180), outbound_url}]`. |
| Post options | `options.subreddit` (required; `u_<name>` posts to the profile), `options.title` (required, ≤300), `options.flairId` → `flair_id`, `options.contentWarning` or tag `spoiler` → `spoiler=true`, tag `nsfw` → `nsfw=true`, `sendreplies=true` so comments land in the inbox. |
| First comment | `options.firstComment` is posted via `/api/comment` right after the post. Link, image, video and gallery posts have no body field, so **their post text is posted as the first comment** (followed by `firstComment` if both are set). If the comment fails, the error carries `partial` with the post id, so core keeps the post. |
| Async media | For `kind=image/video`, Reddit replies with `websocket_url` and no post id. The connector looks for the post in `/user/<name>/submitted` (matching title, subreddit and time), up to 10 checks 2 s apart. If the post is not there yet, it throws a retryable `network` error, and a retry with the same idempotency key **keeps looking without submitting again**. |
| Idempotency | `IdempotencyCache` for publish and reply. Per-key progress makes sure a post that was submitted is never submitted again. |
| Inbox | `GET /message/inbox` maps comment replies on your posts (`post_reply`) → `comment`, replies to your comments (`comment_reply`) → `reply`, username mentions → `mention`, private messages (`t4`) → `dm`. `/user/<name>/submitted` → `own_post`. Pages hold 100 items, up to 3 pages each, and paging stops at `since`. `raw_json=1` is sent so bodies are not HTML-escaped. |
| Reply | `POST /api/comment` with `thing_id` = the parent fullname (`t1_` comment, `t3_` post, `t4_` DM). |
| Moderate | `delete` → `/api/del` (your own posts and comments only). `like`/`unlike` → `/api/vote` dir 1/0. `hide` → `/api/remove` (spam=false) and `unhide` → `/api/approve`: **these work only in subreddits the connected user moderates**, otherwise Reddit answers 403 → `rejected` with an explanation. Reddit has no "hide someone else's comment" for non-moderators. |
| Metrics | `GET /api/info?id=t3_…` (100 per call): `score` (net votes) → `likes`, `num_comments` → `replies`, `num_crossposts` → `reposts`, `view_count` (usually null) → `video_views`, `engagements` = score + comments. `upvote_ratio` has no canonical metric and is not emitted. Reddit's API has no impressions or reach. |
| Account metrics | `/api/v1/me`: `subreddit.subscribers` (the profile's follower count) → `followers_total` when present. **`total_karma` → account-level `engagements`.** Reddit shows no follower count for many users and karma is the account's own score, so the karma row is the reliable one. |
| Webhooks | None. Reddit does not push events, so the inbox is polled. |
| Errors | HTTP 401 → `auth`. 403 → `rejected` on actions (banned, private or restricted subreddit, not a moderator) and `auth` on reads. 429 → `rate_limit` with `X-Ratelimit-Reset`/`-Remaining`/`-Used` in the message. 5xx and transport failures → `network` (retryable). JSON `errors` on HTTP 200: `RATELIMIT` → `rate_limit` (retryable). `USER_REQUIRED` and scope errors → `auth`. Everything else (`SUBREDDIT_NOEXIST`, `SUBMIT_VALIDATION_FLAIR_REQUIRED`, `NO_SELFS`, `NO_LINKS`, `ALREADY_SUB`…) → `rejected` with Reddit's message. |

## Setup

1. Have an **approved** Reddit app (see the policy note above). At <https://www.reddit.com/prefs/apps> choose type **web app**.
2. Redirect URI, exactly: `${BASE_AIR_PUBLIC_URL}/oauth/reddit/callback`. Reddit allows one redirect URI per app.
3. Scopes requested: `identity submit read edit history privatemessages mysubreddits flair vote modposts`.
   - `edit` lets the user delete their own posts and comments. `vote` covers like/unlike. `modposts` covers remove/approve, which only matters in subreddits the user moderates. `flair` and `mysubreddits` are for the composer's subreddit and flair pickers.
4. Webhook URL: not applicable. Reddit has no webhooks.
5. Environment:
   - `REDDIT_CLIENT_ID`: the app's client id (the string under the app name).
   - `REDDIT_CLIENT_SECRET`: the app's secret. `connectConfigured` is false unless both the id and the secret are set.
   - `REDDIT_USER_AGENT`: **must be set by the owner**. Reddit asks for `<platform>:<app id>:<version> (by /u/<reddit username>)`, e.g. `web:base-air:0.1.0 (by /u/your_account)`. The default placeholder `starsign/0.1 by <owner>` is not acceptable in production, and Reddit throttles or blocks generic agents.

## Review and access requirements

- **App approval**: under the Responsible Builder Policy, every new app needs Reddit's manual approval. Third-party reports describe weeks of waiting and rejections without a stated reason. After 2026‑10‑31 Reddit no longer takes new public Data API access requests.
- **Registration**: existing apps had to register by 2026‑09‑30 (migration support applications by 2026‑11‑30). Unregistered apps start losing access on 2027‑01‑12.
- **Commercial use**: Reddit's Data API terms require a written agreement for commercial use. A SaaS publishing tool is commercial use.
- **Shutdown**: remaining public Data API access ends in **March 2027**. Long term, base air needs either a commercial agreement with Reddit or a Developer Platform (Devvit) based integration, which today is aimed at in-Reddit apps and moderation tools, not off-platform schedulers.
- Before approval, nothing works: OAuth needs an approved client id and secret.

## Limits and quotas

- **100 queries per minute per OAuth client id**, averaged over a 10-minute window. Responses carry `X-Ratelimit-Used`, `X-Ratelimit-Remaining` and `X-Ratelimit-Reset` (seconds). Because the limit is per client id, it is shared by every base air workspace on the same deployment.
- Posting is also limited by Reddit's anti-spam rules per account and per subreddit (new or low-karma accounts get "you are doing that too much" → `RATELIMIT` → `rate_limit`). Subreddit rules (required flair, text-only or link-only, minimum karma or account age) appear as `rejected`.
- Title ≤300 characters. Self text ≤40,000. Gallery ≤20 images. One video per post, with a poster image. Images and video cannot be mixed. Polls are not available through the API.

## Unverified

Facts that came only from search summaries or memory (the sandbox could not reach reddit.com or reddithelp.com), plus every `TODO(verify)` in the code.

- `TODO(verify)` **kind=image/video post id**: Reddit returns `websocket_url` + `user_submitted_page` without an id. The connector finds the post in the user's newest submissions instead of listening on the websocket.
- `TODO(verify)` **`subreddit.subscribers` on `/api/v1/me`** is the profile follower count.
- `TODO(verify)` **`upvote_ratio`** is not emitted because there is no canonical metric for it.
- Whether `/api/submit_gallery_post.json` returns `data.url` (the connector also accepts `id`/`name`) and the 180-character caption limit.
- The S3 upload response format (`<Location>` in XML; the connector falls back to `action/key`).
- Whether link posts now accept a body (`text`) through the API. The connector posts the body as the first comment instead.
- Video limits (length, size) and whether `kind=videogif` is needed for GIF uploads (GIFs are currently uploaded as `kind=image`).
- The policy timeline above: Responsible Builder Policy (Nov 2025; updated June 2026), 2026‑09‑30 registration, 2026‑10‑31 end of new access requests, 2026‑11‑30 migration-support deadline, 2027‑01‑12 enforcement, March 2027 end of public access. Sources: [ppc.land](https://ppc.land/reddit-to-halt-public-data-api-access-in-march-2027-as-14-000-apps-register/), [TechRepublic](https://www.techrepublic.com/article/news-reddit-rss-public-api-shutdown/), [creuto](https://creuto.com/reddit-data-api-registration-developer-platform-2026), [redditapis.com](https://www.redditapis.com/blogs/reddit-developer-platform-migration-2026), [prowlo](https://prowlo.com/blog/reddit-data-api). Check them against Reddit's own r/redditdev post and the Data API wiki.
- The 100 QPM per client id figure (from the Data API wiki, as quoted by secondary sources).

## Questions for the owner

1. **Do we hold an approved, registered Reddit OAuth app?** If not, new access requests closed on 2026‑10‑31, and the connector cannot be enabled. Should Reddit be hidden in the room until we have one?
2. **Commercial terms**: will base air seek a commercial Data API agreement with Reddit, which is needed for a paid product and after March 2027? Who owns that conversation?
3. **User-Agent**: which Reddit username should appear in `REDDIT_USER_AGENT` (`web:base-air:<version> (by /u/<name>)`)?
4. **NSFW flag**: `VariantOptions` has no NSFW field, so the connector reads the tag `nsfw`. Should a proper `nsfw: boolean` option be added?
5. **Body of link/media posts**: is posting the text as the first comment the behaviour you want, or should the text be dropped for non-text posts?
6. **Moderator actions**: should the room offer hide/unhide (remove/approve) only when the connected user moderates the subreddit? The room can learn this via `/subreddits/mine/moderator`, which is not yet exposed by the connector.
7. **Validation codes**: the shared `ValidationIssue.code` enum has no "missing required option" code, so a missing subreddit or title is reported as `empty`. Should an `option_required`/`invalid_option` code be added to `types.ts`?
