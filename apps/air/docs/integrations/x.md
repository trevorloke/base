# X (Twitter)

Connector `x` · networks `["x"]` · `packages/connectors/src/x.ts` · registered by `factory.ts` as `new XConnector({ clientId: X_CLIENT_ID, clientSecret: X_CLIENT_SECRET })`

## What works
- **Connect**: OAuth 2.0 authorization code + PKCE (`https://x.com/i/oauth2/authorize`, token at `https://api.x.com/2/oauth2/token`), identity from `GET /2/users/me`. `refreshAuth` rotates refresh tokens. `connectConfigured` false without `X_CLIENT_ID`.
- **Publish** (`POST /2/tweets`): text, threads (reply chain with resume and `partial`), replies, up to 4 images (`POST /2/media/upload`, one shot), **video and GIF via chunked upload** (`POST /2/media/upload/initialize` → `/2/media/upload/{id}/append` per 4 MiB segment → `/2/media/upload/{id}/finalize`, then `GET /2/media/upload?command=STATUS&media_id=` polled with `check_after_secs`, bounded; a retryable "still processing" error keeps the upload so the retry only polls), alt text (`POST /2/media/metadata`), **polls** (`poll.options`, `duration_minutes` 5–10080). Media bytes come from the core media fetcher when set.
- **reply** (`POST /2/tweets` with `reply.in_reply_to_tweet_id`), idempotent.
- **moderate**: like/unlike (`POST /2/users/:id/likes`, `DELETE /2/users/:id/likes/:tweet_id`), hide/unhide replies in our conversations (`PUT /2/tweets/:id/hidden`), delete own tweet (`DELETE /2/tweets/:id`).
- **Inbox**: mentions (`/2/users/:id/mentions`) classified mention/reply/quote, plus own tweets. Metered: `readsUsed` counts every tweet read.
- **Metrics**: impressions, likes, replies, reposts, quotes, saves (bookmarks), link_clicks and profile_visits (non-public, own tweets only, falls back to public), engagements. **Account**: `followers_total` from `GET /2/users/me?user.fields=public_metrics` (counts as one read).
- Webhooks (Account Activity API) not implemented. Quote tweets not implemented (no composer field yet).
- Validation: no documents; one video or GIF and not mixed with images; polls without media, 2–4 options of ≤ 25 characters; generic 280 weighted characters and 140s video.

## Setup
1. developer.x.com → Projects & Apps → your app → User authentication settings: OAuth 2.0, type "Web App" (confidential) or "Native" (public PKCE), permissions Read and write.
2. Callback URI: `${BASE_AIR_PUBLIC_URL}/oauth/x/callback`. Website URL: your base air URL.
3. Scopes requested: `tweet.read tweet.write users.read media.write like.write tweet.moderate.write offline.access`. Accounts connected before this change lack `like.write` and `tweet.moderate.write`: like and hide will fail with an auth error until they reconnect.
- Webhook URL: none.
- Env vars: `X_CLIENT_ID`, `X_CLIENT_SECRET` (optional for public clients), `X_API_BASE_URL` (optional).

## Review and access requirements
X API access is paid (pay-per-use credits or a tier); no app review, but writes and reads consume credits/quotas and some endpoints (hide replies, likes) are restricted on the lowest tiers. Without a paid plan, posting is heavily capped.

## Limits and quotas
- Text 280 weighted characters; 4 images or 1 video/GIF; video ≤ 140s (512 MB); GIF ≤ 15 MB; images ≤ 5 MB.
- Rate limits per endpoint and plan, e.g. POST /2/tweets ~100 / 15 min per user on paid tiers; likes 50 / 15 min; hide replies 50 / 15 min. 429 → retryable with `x-rate-limit-reset`.
- Forum reports say `/initialize` and `/finalize` have low daily limits on the Free plan.

## Unverified
- `TODO(verify)`: chunked upload uses the path-style endpoints (`/2/media/upload/initialize`, `/{id}/append`, `/{id}/finalize`) that replaced the command-style INIT/APPEND/FINALIZE in 2025; X's quickstart page still shows the command form. STATUS is read via `GET /2/media/upload?command=STATUS&media_id=`.
- `TODO(verify)`: alt text via `POST /2/media/metadata` with `{ id, metadata: { alt_text: { text } } }`.
- `media_category` values `tweet_video` / `tweet_gif` (vs `amplify_video`).

## Questions for the owner
- Which X API plan does the deployment use (determines likes/hide availability and read spend caps)?
- Should base air prompt existing X accounts to reconnect for the new scopes?
