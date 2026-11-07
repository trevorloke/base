# YouTube

Connector `youtube` (network `youtube`), in `packages/connectors/src/youtube.ts`, with shared Google plumbing in
`packages/connectors/src/google-oauth.ts`. Factory: `createYouTubeConnectors(env)`.
APIs: YouTube Data API v3 (`https://www.googleapis.com/youtube/v3`, uploads at `https://www.googleapis.com/upload/youtube/v3`)
and YouTube Analytics API v2 (`https://youtubeanalytics.googleapis.com/v2/reports`).

## What works

| Area | Behaviour |
|---|---|
| Connect | Google OAuth 2.0 web-server flow with PKCE, `access_type=offline` and `prompt=consent`, so a refresh token comes back on every consent. `oauthConnect` returns every channel `channels.list?mine=true` reports for the login (`externalId` = channel id `UC…`, handle = `@customUrl` without the `@`). `connectConfigured` is false unless both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set. `describeAccount` works from an auth blob. `refreshAuth` uses the refresh token. Google does not rotate refresh tokens, so channels from one login can each keep a copy. |
| Publish: video | Kind `video` (also the default, and what `post` means here). Uses the **resumable upload protocol**: POST the metadata with `uploadType=resumable` and get a session URI back in `Location`. PUT the bytes in 8 MiB chunks (multiples of 256 KiB) with `Content-Range`, and follow `308 Resume Incomplete` plus `Range`. After a 5xx or a dropped connection: exponential backoff (1 s, 2 s, 4 s… capped at 32 s), then a status query (`Content-Range: bytes */total`), then resume. After `maxChunkRetries` (5) failures it throws a retryable `network` error. The session is kept per idempotency key, so core's retry **resumes the same session** rather than re-uploading. 404/410 means the session expired: a retry starts over. Bytes come from `this.media.fetch()` (core), or from `media.url` when that is unset. |
| Publish: options | `options.title` (required, at most 100 characters, no `<`/`>`). Post text becomes the description (at most 5000 bytes). `options.tags` (at most 500 characters in total). `options.privacy` maps to `privacyStatus`: public (default), unlisted or private. `selfDeclaredMadeForKids` defaults to false. `notifySubscribers` defaults to true. Both, plus `categoryId` (default 22), can be overridden in the account `config` (`madeForKids`, `notifySubscribers`, `categoryId`). `options.brandedContent` sets `paidProductPlacementDetails.hasPaidProductPlacement` (unverified, see below). |
| Publish: Shorts | Kind `short`. YouTube has no "Short" flag: an upload that is at most 3 minutes long and vertical or square becomes a Short. `validate()` checks `durationSeconds`, `width` and `height` from the media metadata. At publish time the connector also probes the MP4/MOV header (moov/mvhd duration and tkhd dimensions, with 90° rotation applied) when metadata is missing, and refuses a landscape or over-length file before uploading. The returned URL is `youtube.com/shorts/{id}`. |
| Publish: thumbnail | `options.thumbnailUrl` is downloaded and sent with `thumbnails.set` (`uploadType=media`, 2 MB limit). This step is best-effort: the video is already live, so a refusal (for example a channel that is not phone-verified) is reported in `raw.thumbnail.error` and does not fail the publish. |
| Publish: processing | Polls `videos.list?part=status,processingDetails` up to 6 times, 5 s apart. `succeeded`/`processed` means done. `failed`/`rejected`/`terminated` throws `rejected` (for example `rejectionReason: duplicate`) with `partial.externalId` set, so core keeps the video id. If processing is still running when the wait ends, the publish **succeeds** with `raw.processing = "processing"`: the upload is complete and the video exists, so a retryable error would only risk a duplicate upload. `processingStatus(account, videoId)` checks later. If a failure comes after the upload (thumbnail fetch, polling), the error carries `partial` and the uploaded video is remembered per idempotency key, so a retry only polls again. If the requested privacy was public or unlisted but YouTube reports private, `raw.warning` explains the unverified-project lock. |
| First comment | Core posts `options.firstComment` through `reply(videoId)`, which is `commentThreads.insert`. The connector does not post it itself, to avoid a double comment. |
| Inbox | `fetchActivity`: `commentThreads.list?allThreadsRelatedToChannelId=…&order=time`, run once for `published` and once for `heldForReview` (up to 3 pages of 100 each). Top-level comments map to `comment` (parent = video id), inline replies to `reply` (parent = thread id). The channel's own comments are skipped. `raw` includes `videoId` and `moderationStatus`. The URL is `watch?v={video}&lc={comment}`. |
| Reply | Parent is an 11-character video id → `commentThreads.insert`. Anything else → `comments.insert` with `parentId` = the thread id. A reply to a reply attaches to the thread, because YouTube has only one level. Replies are idempotent per key within the process. |
| Moderate | `hide` → `setModerationStatus=heldForReview` (reversible). `unhide` → `published`. `delete` → `comments.delete`, which only works for the channel's own comments; on 403 it falls back to `setModerationStatus=rejected`, which removes the comment from public view. `setModerationStatus(account, ids, status, banAuthor)` is public for `rejected` plus `banAuthor`. `like`/`unlike` → `rejected`, because the API cannot rate comments. |
| Metrics | `fetchMetrics(videoIds)`: `videos.list?part=statistics` gives `video_views`, `likes` and `replies` (comment count), which are near real time. The Analytics API (`ids=channel==MINE`, `dimensions=video`, `filters=video==a,b,…`, lifetime range) gives `watch_time_seconds` (estimatedMinutesWatched × 60), `shares` and `follows` (subscribersGained). `engagements` = likes + comments + shares. If Analytics answers 403 or 400 (scope not granted, analytics unavailable), only the Data API numbers are returned. Analytics data lags by about 2–3 days. |
| Account metrics | `followers_total` = `subscriberCount` (omitted when the channel hides it). `video_views` = lifetime channel views. |
| Quota | Every call is charged to a process-local `YouTubeQuota` estimate that rolls over at midnight Pacific. The default pool is 10,000 units/day (list = 1, write = 50, thumbnails.set = 50). Uploads count against a separate bucket of 100/day (the June 2026 model), or against 1,600 units from the default pool when `quota.dailyUploads = null` (legacy model). When the estimate is spent, the call is refused locally with a `rate_limit` error that says when the quota resets. Google's own `quotaExceeded`/`dailyLimitExceeded`/`rateLimitExceeded` (HTTP 403) and `uploadLimitExceeded` (the per-channel daily limit) become `rate_limit`, retryable, with a clear message. A Google quota error also marks the estimate spent, so later calls fail fast. `connector.quota.usage()` shows the counts. |
| Webhooks | None. YouTube's PubSubHubbub feed announces new videos only, not comments, so `webhooks: false`. Comments are polled. |
| Errors | 401 → `auth`. 403 with a credential/scope reason (`insufficientPermissions`, `ACCESS_TOKEN_SCOPE_INSUFFICIENT`, `accessNotConfigured`, `youtubeSignupRequired`, `authError`) → `auth`. Any other 403 (`forbidden`, `commentsDisabled`…) → `rejected`, so a healthy account is not marked for reconnection. 429 or a quota reason → `rate_limit`, retryable, with Retry-After when present. 400/404 → `rejected`. 5xx and transport errors → `network`, retryable. |

Capabilities: `publish`, `fetchActivity`, `fetchMetrics`, `reply`, `moderate`, `accountMetrics`, `video`; `kinds: ["video", "short"]`;
`meteredReads: false` (quota-limited, not billed).

## Setup

1. In Google Cloud Console, create or choose a project. Enable **YouTube Data API v3** and **YouTube Analytics API**.
2. Set up the **OAuth consent screen**: External user type, app name, support email, privacy policy URL, terms URL,
   authorized domain = the domain of `STARSIGN_PUBLIC_URL`.
3. Create **Credentials → OAuth client ID → Web application** and add the authorized redirect URI:
   `${STARSIGN_PUBLIC_URL}/oauth/youtube/callback`
   (if Google Business Profile shares the same client, also add `${STARSIGN_PUBLIC_URL}/oauth/google_business/callback`).
4. Scopes the connector requests:
   - `https://www.googleapis.com/auth/youtube.upload` (sensitive)
   - `https://www.googleapis.com/auth/youtube.force-ssl` (sensitive: comments, moderation)
   - `https://www.googleapis.com/auth/youtube.readonly` (sensitive)
   - `https://www.googleapis.com/auth/yt-analytics.readonly` (sensitive)
5. Env vars (one OAuth client serves both Google connectors):
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
6. Webhook URL: not used (`${STARSIGN_PUBLIC_URL}/webhooks/youtube` is not registered anywhere).

## Review and access requirements

- **OAuth consent screen verification.** All four scopes are *sensitive*, so they need Google's OAuth app verification
  before the app can be published to all users. Verification requires a verified domain, a privacy policy, a demo
  video of each scope in use, and a written justification per scope. It typically takes a few days to several weeks.
  Before verification:
  - While the app is in **Testing**, only the test users listed on the consent screen (up to 100) can connect, and
    their **refresh tokens expire after 7 days**. `refreshAuth` then fails with `auth` and the account needs reconnecting.
  - Once the app is published but not yet verified, users see the "Google hasn't verified this app" warning, and the
    app is capped at 100 new users.
- **YouTube API Services audit (compliance audit).** Videos uploaded through `videos.insert` from an **unverified API
  project** (one created after 28 July 2020 that has not passed the audit) are **locked to private**, whatever
  `privacyStatus` was requested. The connector detects this after processing and reports it in `raw.warning`. Videos
  that were locked private cannot be appealed and must be re-uploaded once the project passes. The audit uses the
  YouTube API Services "Audit and Quota Extension" form. Google reviews the app against the YouTube API Services Terms
  and Developer Policies. Expect several weeks. The same form requests more quota (more than 100 uploads/day or more
  than 10,000 units/day).
- **Channel-level features.** Custom thumbnails, and uploads longer than 15 minutes, need a phone-verified channel.
  Without verification, `thumbnails.set` returns 403; the connector reports it in `raw.thumbnail` and the publish still succeeds.

## Limits and quotas

- Quota is per Google Cloud project, shared by every Starsign workspace and channel on the deployment, and resets at
  midnight Pacific.
  - Default pool: 10,000 units/day. Lists cost 1 unit; `commentThreads.insert`, `comments.insert`, `setModerationStatus`, `comments.delete` and `thumbnails.set` cost about 50 each.
  - Uploads (current docs, since 1 June 2026): a separate "Video Uploads" bucket of **100 `videos.insert` calls/day**,
    1 unit each. Under the old model (the brief's figure) an upload cost about 1,600 of the 10,000 units, roughly 6
    uploads a day. Set `quota: { dailyUploads: null }` to model that.
  - Per-channel upload limits also apply (`uploadLimitExceeded`).
- Title: 100 characters, no `<`/`>`. Description: 5,000 bytes. Tags: 500 characters in total.
- Thumbnail: JPEG/PNG, 2 MB maximum.
- Shorts: 3 minutes maximum, vertical or square.
- An upload session URI stays valid for about a week. Chunks must be multiples of 256 KiB, except the last.
- Analytics data lags by about 2–3 days. The connector sends 200 video ids per Analytics query.

## Unverified

Everything marked `TODO(verify)` in the code, plus figures taken from secondary sources:

1. **Upload quota model.** Third-party write-ups and the search snippet of the `videos.insert` reference say that from
   1 June 2026 uploads use their own bucket (100/day, 1 unit each). I could not open developers.google.com from this
   sandbox to read it directly. The default is the new model; check the project's quota page in Cloud Console.
2. **Costs of the other calls** (list = 1, writes = 50, thumbnails.set = 50) come from the long-standing quota table and
   were not re-confirmed for November 2026.
3. **Brand Accounts.** I believe one Google login with several Brand Account channels picks ONE channel at the consent
   screen, and `mine=true` then returns that channel. Connecting another Brand channel means running Connect again and
   picking it. `oauthConnect` returns every channel the API lists, but in practice that is usually one.
4. **`paidProductPlacementDetails`** being settable on insert, for `options.brandedContent`.
5. Whether **custom thumbnails apply to Shorts** (sources disagree). The connector still calls `thumbnails.set` and treats a refusal as non-fatal.
6. **Analytics `video` filter limit** (500 ids is documented for v1; the connector sends 200 per query) and `channel==MINE` support in v2.
7. **Inline replies** in `commentThreads.list` are limited, so long threads may be missing replies. A follow-up would page `comments.list?parentId=` for threads where `totalReplyCount` exceeds the inline count.
8. **Quota reset** at midnight Pacific and the 7-day refresh-token expiry for Testing apps reflect long-standing behaviour and were not re-read from current docs.

## Questions for the owner

1. **Google Cloud project**: which project, who owns it, and has it passed (or applied for) the YouTube API Services audit? Until it does, every upload is locked private.
2. **Consent screen verification**: who will record the scope demo video and own the verified domain for `STARSIGN_PUBLIC_URL`?
3. **Upload volume**: expected uploads per day across all workspaces. Above 100/day needs a quota extension.
4. **Defaults**: keep `notifySubscribers: true`, `madeForKids: false` and category 22 (People & Blogs) as deployment defaults, or expose them in the composer?
5. **Shorts thumbnails**: should a `thumbnailUrl` on a Short be dropped silently or flagged in the composer?
6. **Validation codes**: `ValidationIssue.code` has no "invalid" value, so angle brackets in a title are reported as `unsupported_media`. Add an `invalid` code to the contract?
