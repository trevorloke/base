# TikTok

Connector name `tiktok`, network `tiktok`, file `packages/connectors/src/tiktok.ts`, factory `createTikTokConnectors(env)`.
It uses Login Kit (OAuth 2.0 with `client_key`), Content Posting API v2 (Direct Post) and the Display API (`user/info`, `video/list`, `video/query`) on `https://open.tiktokapis.com`.

## What works

| Area | Status |
|---|---|
| Connect | OAuth through `OAuth2Client` (`client_key`, scopes separated by `,`, client secret sent in the body). One login connects one creator. `externalId` is the `open_id` and `handle` is the `username`. `describeAccount` calls `GET /v2/user/info/`. |
| Refresh | `refreshAuth` uses the refresh token. The access token lasts about 24 h and the refresh token about 365 days. TikTok rotates refresh tokens, and the new one is stored. It returns `null` once the refresh token has expired, so the person reconnects. |
| Publish: video | Direct Post `POST /v2/post/publish/video/init/`. **FILE_UPLOAD** is the default: the connector reads bytes through `media.fetch` and sends them as chunked `PUT`s with `Content-Range`. **PULL_FROM_URL** is used when `TIKTOK_VIDEO_SOURCE=PULL_FROM_URL` or the account config has `videoSource: "PULL_FROM_URL"`, and it needs a verified domain. |
| Publish: photos (1–35) | `POST /v2/post/publish/content/init/` with `media_type: "PHOTO"`, `post_mode: "DIRECT_POST"` and `photo_images` set to Starsign media URLs. **Photo posts work only with PULL_FROM_URL**, so the media domain must be verified. `options.title` becomes the photo title (≤90 characters) and the post text becomes the description (≤4000). |
| Creator checks | `creator_info/query` runs **before every post** and the post is checked against it. `options.privacy` must map to one of `privacy_level_options`. Comments, duets or stitches turned off by the creator cannot be turned on. Video duration must be ≤ `max_video_post_duration_sec`. Breaking any of these gives `ConnectorError("rejected")`, and no post is made. |
| Privacy mapping | public→`PUBLIC_TO_EVERYONE`, friends→`MUTUAL_FOLLOW_FRIENDS`, followers→`FOLLOWER_OF_CREATOR`, self/private→`SELF_ONLY`. `unlisted` is rejected. **Privacy has no default**: a missing `options.privacy` fails validation and is rejected at publish. |
| Interactions | `allowComments`, `allowDuet` and `allowStitch` are **off unless set to true**, as TikTok's UX rule requires. Photo posts only have comments. |
| Commercial content | `options.brandedContent: true` → `brand_content_toggle: true` ("Branded content", a paid partnership). Branded content set to private is rejected. "Your brand" (`brand_organic_toggle`) is always `false` because Starsign has no option for it yet (see Questions). |
| Status polling | `POST /v2/post/publish/status/fetch/` runs until `PUBLISH_COMPLETE` or `FAILED`, with at most 20 checks 3 s apart by default. If the post is still processing, the connector returns a retryable `network` error. A retry with the same idempotency key **resumes polling the same `publish_id`** and does not post again. |
| Post id | When the post is public and has passed moderation, `externalId` is the video id from `publicaly_available_post_id` (TikTok's spelling), and the URL is `https://www.tiktok.com/@user/video/<id>`. Otherwise (SELF_ONLY, followers-only, or moderation still running) `externalId` is the `publish_id` and the URL is `null`. `fetchMetrics` resolves a stored `publish_id` to the video id once one exists. The connector keeps int64 ids exact by quoting them before JSON parsing. |
| Inbox | Only the account's own videos are fetched (`video/list` → `own_post`). **TikTok's public API has no comments or DMs**, so `reply` and `moderate` are not implemented and the capabilities report `false`. |
| Metrics | `POST /v2/video/query/` returns `view_count`→`video_views`, `like_count`→`likes`, `comment_count`→`replies` and `share_count`→`shares`. `engagements` is the sum of likes, comments and shares. Calls are batched 20 ids at a time. TikTok has no impressions, reach or watch time here. |
| Account metrics | `user/info` gives `follower_count`→`followers_total` and `likes_count`→`likes` (lifetime likes received). |
| Webhooks | `TikTok-Signature: t=<unix>,s=<hex>` is verified as HMAC-SHA256(secret, `"<t>.<rawBody>"`), compared in constant time, and rejected if the timestamp is more than 300 s off. `post.publish.publicly_available` becomes an `own_post` item routed by `user_openid`. Other events (`post.publish.complete`, `post.publish.failed`, `authorization.removed`, …) are kept raw by core and produce no items. TikTok has no handshake. |
| Errors | `access_token_invalid` and `scope_not_authorized` → `auth`. `rate_limit_exceeded`/429 → `rate_limit` (retryable). `spam_risk_too_many_posts` (daily cap) → `rate_limit` (retryable later). `unaudited_client_can_only_post_to_private_accounts` and `reached_active_user_cap` → `rejected`, with a message explaining the audit. `url_ownership_unverified` → `rejected`, with a message explaining domain verification. 5xx/`internal_error` → `network` (retryable). |

## Setup

1. Create an app at <https://developers.tiktok.com> → Manage apps. Add the products **Login Kit** and **Content Posting API**, and turn on **Direct Post** in the Content Posting API settings.
2. Platform: **Web**. Add the redirect URI exactly: `${STARSIGN_PUBLIC_URL}/oauth/tiktok/callback`.
3. Scopes (all must be approved for the app): `user.info.basic`, `user.info.profile`, `user.info.stats`, `video.publish`, `video.upload`, `video.list`.
   (`video.upload` is for Upload-to-inbox drafts, which Starsign does not use today. It is requested so the room can add drafts without asking users to reconnect.)
4. **Verify the media domain** under Content Posting API → *Manage URL properties*: add the domain or URL prefix that serves Starsign media (the host of `STARSIGN_PUBLIC_URL/media/...` or the S3/CDN host). This is **required for photo posts** and for PULL_FROM_URL video.
5. Webhooks (optional): set the callback URL to `${STARSIGN_PUBLIC_URL}/webhooks/tiktok` and subscribe to the Content Posting events.
6. Environment:
   - `TIKTOK_CLIENT_KEY`: the app's client key. Required to connect.
   - `TIKTOK_CLIENT_SECRET`: the app's client secret. Required to connect, and it is also the webhook signing key.
   - `TIKTOK_WEBHOOK_SECRET` (optional): overrides the webhook signing key. TikTok currently signs with the client secret, so leave this unset unless TikTok issues a separate key.
   - `TIKTOK_VIDEO_SOURCE` (optional): `FILE_UPLOAD` (default) or `PULL_FROM_URL`.
   - `connectConfigured` is false unless both the key and the secret are set.

## Review and access requirements

- **App review**: TikTok must approve the app and each scope before anyone outside the developer team can log in. You will need a demo video of the full flow, a privacy policy URL and terms of service URL. Reviews typically take days to a few weeks.
- **Direct Post audit**: this is separate from app review. Until the app passes the Content Posting audit:
  - every post is forced to **SELF_ONLY**, and the creator's account must be **private** when posting;
  - at most **5 creators** may post through the app in any 24 h window;
  - the API answers `unaudited_client_can_only_post_to_private_accounts` or `reached_active_user_cap`, and Starsign surfaces both as `rejected` with an explanation.

  The audit checks that the posting UI follows TikTok's Content Sharing Guidelines (below). Plan for several weeks and at least one revision round.
- **UX requirements the room must implement**, checked in the audit:
  1. **Show which account will post**: the creator's `creator_nickname` (and avatar) from `creator_info/query`, fetched when the composer opens for that account. If the query fails or says the creator cannot post right now, block posting and say why.
  2. **Privacy selector with no default.** List exactly the `privacy_level_options` returned for that creator, labelled in plain words (Everyone / Friends / Followers / Only me). The person must actively pick one every time, so never preselect, remember or auto-fill it. Scheduled posts store the person's explicit choice.
  3. **Interaction toggles** for Allow Comments, Allow Duet and Allow Stitch, **all off by default**. Grey out and disable any the creator has turned off (`comment_disabled`, `duet_disabled`, `stitch_disabled`). Photo posts show only Allow Comments.
  4. **Commercial content disclosure**: a "Disclose post content" toggle, off by default. When it is on, the person must tick at least one of **Your brand** (promoting themselves) and **Branded content** (paid partnership for a third party). Show the resulting label: "Promotional content" for Your brand, "Paid partnership" for Branded content. If Branded content is ticked, the "Only me" privacy option must be disabled with the explanation "Branded content visibility cannot be set to private".
  5. **Declarations next to the publish button**: "By posting, you agree to TikTok's Music Usage Confirmation". When Branded content is ticked, it becomes "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation". Each policy name must link to TikTok's page.
  6. **Duration limit**: block videos longer than `max_video_post_duration_sec` before upload.
  7. **Preview and explicit consent**: show the media and caption, and let the person edit the caption. Posting needs an explicit action by the person. Do not add watermarks or Starsign branding to the media.
  8. **After posting**, tell the person that TikTok may take a few minutes to process the post and that it will appear on their profile once done.
- Before approval, the connector still connects and posts, but only SELF_ONLY posts to private accounts, and only for app developers or testers listed in the developer portal.

## Limits and quotas

- Videos: MP4, WebM or MOV, ≤4 GB, ≥3 s, and no longer than the creator's `max_video_post_duration_sec` (up to 10 min). Captions ≤2200 UTF-16 units. One video per post.
- Photos: JPEG or WebP (no PNG, no GIF), 1–35 per post. Title ≤90 and description ≤4000 characters. Photos cannot be mixed with a video.
- Chunked upload: files ≤64 MB go up as one chunk. Larger files use 10 MB chunks with `total_chunk_count = floor(size / chunk_size)`, and the last chunk takes the remainder. TikTok's rules are 5–64 MB per chunk, at most 1000 chunks, sent in order. `upload_url` expires after about 1 h.
- Rate limits, per user access token and per minute: `creator_info/query` 20, `video/init` and `content/init` 6, `status/fetch` 30, `video/list` and `video/query` 600. A 429 / `rate_limit_exceeded` becomes `rate_limit`.
- Daily post cap per creator, shared by every app the creator uses: reaching it gives `spam_risk_too_many_posts` → `rate_limit`.
- Unaudited: SELF_ONLY only, private accounts only, 5 posting users per 24 h.

## Unverified

Every `TODO(verify)` in the code, plus facts that came only from search summaries. The sandbox could not reach developers.tiktok.com.

- `TODO(verify)` **PKCE for web apps**: TikTok documents PKCE as required for mobile/desktop only, and its desktop flow hex-encodes the SHA-256 challenge. The connector does not send PKCE parameters and relies on `client_secret`.
- Exact rate-limit numbers (20/6/30/600 per minute) and the daily post cap value (about 15/day is commonly cited).
- Chunk rules: whether the last chunk may be up to 128 MB, and whether files between 5 and 64 MB may always be sent as a single chunk (the connector assumes yes).
- Webhook payload shape (`content` as a JSON string carrying `publish_id`, `post_id`), event names (`post.publish.complete`, `post.publish.publicly_available`, `post.publish.failed`, `post.publish.inbox_delivered`, `post.publish.no_longer_publicaly_available`), and the absence of a separate webhook secret.
- Photo constraints: PNG not accepted, per-image size cap, and whether `photo_cover_index` is required.
- The list of status `fail_reason` values (`internal` is treated as retryable, any reason containing `pull` gets the domain hint).
- Whether `user/info` `likes_count` is lifetime likes received (mapped to account-level `likes`).

## Questions for the owner

1. **Audit**: who submits the Direct Post audit, and under which legal entity, privacy policy and terms URLs? Until it passes, TikTok posting is SELF_ONLY on private accounts.
2. **Media domain**: which domain serves Starsign media in production (app host or CDN/S3)? It must be verified in the TikTok portal for photo posts and PULL_FROM_URL.
3. **Agents and scheduling**: TikTok requires the person's explicit consent per post, and every privacy choice must be made by the person. Should agents be barred from creating TikTok posts that a human has not confirmed in the UI described above?
4. **"Your brand" disclosure**: add a schema option (for example `brandOrganic: boolean`, or make `brandedContent` an enum `none | your_brand | branded | both`)? Until then, only "Branded content" can be disclosed.
5. **AI-generated label**: TikTok has an `is_aigc` flag. Should Starsign set it from the post's Disclosure record (`aiContributions` includes generated media)? That needs the disclosure passed to connectors.
6. **Music**: photo posts send `auto_add_music: false`. Should creators be offered TikTok's auto-music for photo posts?
