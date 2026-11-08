# Bluesky

Connector `bluesky` · networks `["bluesky"]` · `packages/connectors/src/bluesky.ts` · registered by `factory.ts` as `new BlueskyConnector()`

## What works
- **Connect** (`app_password`): handle + app password (never the main password) against `https://bsky.social` or the account's PDS; `describeAccount` logs in and returns DID + handle. Sessions are cached per account and dropped on auth errors.
- **Publish**: text with rich-text facets (links, hashtags, mentions resolved to DIDs; unresolved mentions stay plain), up to 4 images with alt text and aspect ratio, **video** (one MP4) through the video service, **link cards** (`app.bsky.embed.external`), threads (reply chain with resume and `partial`), replies with the correct thread root. Idempotent in-process; a video still processing at the end of the bounded wait gives a retryable error and the retry polls the same job.
- **Video flow**: `com.atproto.server.getServiceAuth` on the PDS with `aud = did:web:<PDS host>`, `lxm = com.atproto.repo.uploadBlob`, 30-minute expiry → `POST https://video.bsky.app/xrpc/app.bsky.video.uploadVideo?did=&name=` (Bearer service token, `video/mp4`) → poll `app.bsky.video.getJobStatus?jobId=` until `blob` (failed → rejected) → `app.bsky.embed.video` with `alt` and `aspectRatio` from the media's width/height.
- **Link cards**: for `options.link`, or else the first URL in the text, when the post has no media. Title/description/thumbnail come from the page's Open Graph tags (`options.title` and `options.thumbnailUrl` win); the thumbnail (≤ 1 MB) is uploaded as a blob. Best effort with a 5s timeout: if the page cannot be read and no title is given, the post goes out without a card.
- **reply**: posts a reply with root/parent refs, idempotent.
- **moderate**: `like` (creates an `app.bsky.feed.like` record unless already liked), `unlike` (deletes the viewer's like record), `delete` (own posts only). hide/unhide refused (threadgate hidden replies not wired).
- **Inbox**: notifications (mention, reply, quote, repost, like, follow) and own posts. **Metrics**: likes, reposts, replies, quotes, saves (bookmarks), engagements. **Account**: `followers_total` from `app.bsky.actor.getProfile`.
- No webhooks (Bluesky has no push to third parties; the firehose/Jetstream is an option for later).
- Validation: no documents, no polls, one video not mixed with images, video must be MP4 when the type is known.

## Setup
1. In Bluesky: Settings → Privacy and security → App passwords → Add (do not allow DM access unless needed).
2. In base air, connect Bluesky with the handle and the app password.
- Redirect URI: none (app password; Bluesky OAuth is not used yet). Webhook URL: none. Env vars: none.

## Review and access requirements
None. Video upload requires the account to have a **verified email** and is subject to daily video limits set by Bluesky.

## Limits and quotas
- 300 graphemes per post, 4 images (≤ ~1 MB each after Bluesky's limits), 1 video ≤ 3 minutes (lexicon allows up to 300 MB, formerly 100 MB), link-card thumbnails ≤ ~1 MB.
- PDS rate limits: creates ~1,666/hour and 11,666/day points per account (create = 3 points); login 30 / 5 min and 300 / day; 429 → retryable with `ratelimit-reset`.
- Daily video upload caps per account (`app.bsky.video.getUploadLimits`).

## Unverified
- `TODO(verify)`: a `409 already_exists` from `uploadVideo` carries the existing `jobId` at the top level; the connector reads `jobStatus.jobId` or `jobId`.
- `getJobStatus` is called without auth against video.bsky.app; some guides mint a service token with `aud = did:web:video.bsky.app` and `lxm = app.bsky.video.getJobStatus` for it. If unauthenticated status reads are refused, add that token.
- Upload limits (`getUploadLimits`) are not checked before uploading.

## Questions for the owner
- Link cards fetch the linked page from the base air server. Acceptable, or should base air use Bluesky's card service (cardyb) or only build cards when `options.link` is set?
- Should base air move from app passwords to Bluesky OAuth?
