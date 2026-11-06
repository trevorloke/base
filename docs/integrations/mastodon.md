# Mastodon

Connector `mastodon` · networks `["mastodon"]` · `packages/connectors/src/mastodon.ts` · factory `createMastodonConnectors(env)`

## What works
- **Connect (any server)**: the person types their server (`mastodon.social`, `https://hachyderm.io`, `@me@fosstodon.org` all work). `oauthPrepare` registers a Starsign app on that server (`POST /api/v1/apps`, scopes `read write push`), caches it in memory per server + redirect URI, and returns the server's `/oauth/authorize` URL with PKCE (S256). The client id/secret travel in the pending-state config (encrypted by core) and end up in the account's auth blob.
- `oauthConnect` exchanges the code at `https://<server>/oauth/token` through `OAuth2Client` and reads the account with `GET /api/v1/accounts/verify_credentials`. Identity: externalId `<account id>@<server>` (account ids are only unique per server), handle `@user@server`; config `{ instance, accountUrl }`.
- Tokens do not expire and Mastodon issues no refresh token: `refreshAuth` returns `null`; a 401 means "reconnect".
- Server input is normalized and loopback/private/IP-literal hosts are refused (the host is fetched server-side).
- **Publish**: statuses with visibility (`options.visibility`, default public), `spoiler_text` + `sensitive` from `options.contentWarning`, up to 4 media uploaded with `POST /api/v2/media` (alt text as `description`), polling `GET /api/v1/media/:id` (206 → processing) for video/GIF with a bounded wait and a retryable "still processing" error that reuses the upload on retry, polls (`poll.options`, `expires_in` = durationMinutes × 60, min 300s), threads via `in_reply_to_id`, replies to `replyToExternalId`. Each status carries `Idempotency-Key: <key>:<segment>` (server dedups ~1h) on top of the in-process cache; a part-posted thread resumes and reports `partial`.
- **Inbox**: `GET /api/v1/notifications?types[]=mention,reblog,favourite,follow` → reply (mention replying to us) / mention / repost / like / follow; plus own statuses from `GET /api/v1/accounts/:id/statuses?exclude_reblogs=true`. Paged with `max_id`, bounded by `maxPages`, filtered by `since`. HTML content is flattened to text.
- **reply**: fetches the parent, prepends `@author` (Mastodon only notifies mentioned accounts) and keeps the parent's visibility.
- **moderate**: `delete` own status, `like`/`unlike` = favourite/unfavourite. `hide`/`unhide` are refused (no per-reply hide in Mastodon).
- **Metrics**: per status `likes` (favourites_count), `reposts` (reblogs_count), `replies` (replies_count), `quotes` (when the server reports quotes_count), `engagements` (sum). Deleted statuses are skipped. No impressions/reach exist in the API. **Account**: `followers_total` from verify_credentials.
- **Webhooks/streaming**: not implemented. Mastodon offers a streaming API and Web Push (the `push` scope is requested so this can be added later); admin webhooks only cover moderation events. Activity is polled.
- Errors: 401 → auth; 403 → rejected on writes, auth on reads; 429 → rate_limit (retryable, message carries `X-RateLimit-Reset`); 422/4xx → rejected; 5xx/network → retryable.

## Setup
- No developer portal and no deployment-wide client id: apps are registered per server automatically. `connectConfigured` is always true.
- Redirect URI: `${STARSIGN_PUBLIC_URL}/oauth/mastodon/callback` (registered on each server as part of `POST /api/v1/apps`).
- Webhook URL: none (no inbound webhooks).
- Env vars: `STARSIGN_PUBLIC_URL` (sent as the app website), optional `MASTODON_APP_NAME` (default `Starsign`, shown on the authorize page and as "via" on posts).

## Review and access requirements
None. Any person with an account on a server can authorize. Some servers restrict sign-ups or API apps, and server admins can suspend the app; there is no central review.

## Limits and quotas
- Default Mastodon rate limit: 300 requests / 5 min per account; media uploads 30 / 30 min; status deletes 30 / 30 min. Servers can change these.
- Default text limit 500 characters, 4 media, poll 4 options × 50 characters, 5 min to 7 days. Many servers raise these (validate uses defaults).
- Media size limits are per server (default 16 MB images, 99 MB video).

## Unverified
- `TODO(verify)`: per-server poll limits should come from `/api/v2/instance` `configuration.polls`; the connector uses Mastodon's defaults (4 options, 50 characters).
- Docs site docs.joinmastodon.org was not reachable from the build sandbox; endpoint shapes were confirmed through search results (apps registration, PKCE ≥ 4.3, `redirect_uris` array ≥ 4.3, `client_secret_expires_at` ≥ 4.4, media 202/206 flow, `Idempotency-Key`, poll `expires_in`). Batch `GET /api/v1/statuses?id[]=` (4.3+) was not confirmed, so metrics use one `GET /api/v1/statuses/:id` per post.
- Older servers (< 4.3) ignore PKCE parameters; this is fine because the app is confidential and the secret is sent.

## Questions for the owner
- App name shown on servers and posts: keep "Starsign"?
- Should thread follow-ups be `unlisted` (common etiquette) instead of inheriting the root's visibility?
- Do you want quote posts (Mastodon 4.5 quote_id) once the composer has a quote field?
