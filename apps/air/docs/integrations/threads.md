# Threads

Connector `threads`, network `threads`. Code: `packages/connectors/src/threads.ts`. Tests:
`packages/connectors/test/threads.test.ts`. Factory: `createThreadsConnectors(env)`.

The connector calls the Threads API at `https://graph.threads.net/v1.0`. Meta documents `graph.threads.com` as an equivalent
host; set `THREADS_API_BASE_URL` to switch. The Threads API is its own **use case** with its own app id and secret. Its tokens
do not work on graph.facebook.com, and Facebook tokens do not work here.

## What works

| Area | Support |
|---|---|
| Connect | OAuth (`threads.com/oauth/authorize`) → short-lived token (`POST /oauth/access_token`) → long-lived 60-day token (`GET /access_token?grant_type=th_exchange_token`) → `GET /me`. One login = one Threads profile (`externalId` = Threads user id, handle = username) |
| Text post | `media_type=TEXT` container → `threads_publish` |
| Link post (`options.link`) | TEXT container with `link_attachment`. Text-only posts only; with media, validation asks you to put the link in the text |
| Image / video | `IMAGE` (`image_url`, `alt_text`) / `VIDEO` (`video_url`, `alt_text`) |
| Carousel | 2–20 item containers (`is_carousel_item=true`, images and videos mixed) → `CAROUSEL` with `children` |
| Threads (multi-segment) | Segment 1 is the post (with media). Each later segment is a TEXT reply with `reply_to_id` = the previous segment's id. `threadExternalIds` lists every segment. If a segment fails after the root is out, the error carries `partial`; the retry resumes at the failed segment and reuses its container |
| Replies (`replyToExternalId`, `reply`) | A TEXT container with `reply_to_id`. Core's first comment arrives as a reply to the new post |
| Async processing | Every container is polled on `status` until `FINISHED` (`maxPolls`, default 20 × 3 s). `ERROR` → `rejected`, with the next attempt making a new container. `EXPIRED` → retryable. Still `IN_PROGRESS` → retryable `network`, and the retry reuses the container |
| Publishing quota | `GET /{user}/threads_publishing_limit` before the first segment. A spent quota → `rate_limit` (retryable) |
| Inbox (`fetchActivity`) | The 10 most recent own posts (`own_post`, repost facades skipped). For each, `/{post}/conversation` gives every reply in the tree as `reply`, with `parentExternalId` = `replied_to`. The account's own replies are skipped |
| Moderate | hide / unhide → `POST /{reply}/manage_reply hide=true|false` (top-level replies; hiding also hides their nested replies). delete → `DELETE /{id}` (own posts and replies only, `threads_delete`). like/unlike → `rejected` |
| Post metrics | `views` → `impressions`, `likes`, `replies`, `reposts`, `quotes`, `shares`, `engagements` = likes + replies + reposts + quotes |
| Account metrics | `/{user}/threads_insights` over the last 24 h: `followers_count` → `followers_total`, `views` (daily series, summed) → `impressions`, `clicks` → `link_clicks`, `engagements`. Metrics the API refuses are skipped (per-metric fallback) and remembered |
| Webhooks | Same handshake (`hub.challenge` + `THREADS_WEBHOOK_VERIFY_TOKEN`) and signature (`X-Hub-Signature-256`, HMAC with the **Threads app secret**) as Meta. `replies` → `reply`, `mentions` → `mention`, routed by `target_id` (falling back to `root_post.owner_id`) |
| Token refresh | `GET /refresh_access_token?grant_type=th_refresh_token` gives another 60 days. Core refreshes when `expiresAt` is within 5 minutes, so the auth blob stores `expiresAt` = the real expiry minus 7 days and `tokenExpiresAt` = the real expiry. Any use of the account in its last week renews the token |

Errors use the shared Graph mapping in `meta.ts`:

- Throttling codes and HTTP 429 → `rate_limit` (retryable).
- Codes 190 and 10/200–299 → `auth`.
- Transient errors, codes 1 and 2, and HTTP 5xx → `network` (retryable).
- Everything else → `rejected`.

Validation:

- No GIFs or documents.
- Images JPEG or PNG.
- Carousels of 2–20 items.
- Kinds `post`, `carousel`, `link` and `video` only.
- `link_attachment` only on text-only posts.
- The 500-character limit and 5-minute video limit come from the generic network limits.

## Setup

1. At developers.facebook.com → Create app, choose the **"Access the Threads API"** use case. This creates a Threads app id
   and secret, which differ from any Facebook app.
2. Use case → Permissions. Add `threads_basic`, `threads_content_publish`, `threads_manage_replies`, `threads_read_replies`,
   `threads_manage_insights` and `threads_delete`. Mention webhooks also need `threads_manage_mentions` (see Questions).
3. Use case → Settings:
   - Redirect callback URL: `${BASE_AIR_PUBLIC_URL}/oauth/threads/callback`
   - Uninstall and delete callback URLs: required by Meta. base air has no endpoint for these yet (see Questions).
4. Webhooks: add the **Threads webhooks** sub-use case.
   - Callback URL: `${BASE_AIR_PUBLIC_URL}/webhooks/threads`
   - Verify token: `THREADS_WEBHOOK_VERIFY_TOKEN`
   - Subscribe the fields `replies` and `mentions`.
5. Roles → add Threads testers. Each tester accepts the invite in the Threads app (Settings → Account → Website permissions)
   before they can authorize while the app is in development.
6. Environment:

| Variable | Required | Meaning |
|---|---|---|
| `THREADS_CLIENT_ID` | yes | Threads app id. Without it (or without the secret), `connectConfigured` is false |
| `THREADS_CLIENT_SECRET` | yes | Threads app secret. Used for the token exchange and webhook signatures |
| `THREADS_WEBHOOK_VERIFY_TOKEN` | for webhooks | Random string; the same value goes in the dashboard |
| `THREADS_API_BASE_URL` | no | Default `https://graph.threads.net` |

## Review and access requirements

- **Before review:** all permissions work for app-role users and accepted Threads testers only.
- **App Review (Advanced Access)** for each permission, with a written use description and a screencast per permission
  showing the Threads login and the feature: posting a text, image, carousel and multi-segment thread; reading, replying to,
  hiding and deleting replies; the analytics screen.
- The **`replies` webhook field requires Advanced Access** on `threads_read_replies`. Before approval, no reply webhooks are
  delivered, but polling via `/conversation` works for testers.
- **Business Verification** may be requested during review. Plan for it as with the Meta app.
- **Typical timeline:** 1–2 weeks per review round.

## Limits and quotas

- **250 published posts per profile per rolling 24 h.** A carousel counts as one post. Replies have a separate quota (about
  1000 per 24 h), readable through `threads_publishing_limit` with `reply_quota_usage` (needs `threads_manage_replies`).
- **Text:** 500 characters. A text post can carry one link preview (`link_attachment`).
- **Carousel:** 2–20 items.
- **Video:** up to 5 minutes. **Images:** JPEG or PNG, up to 8 MB.
- **Containers:** Meta recommends waiting (about 30 s for video) before publishing. The connector polls `status` instead.
  Containers expire after 24 h.
- **Tokens:** short-lived tokens last 1 h. Long-lived tokens last 60 days, can be refreshed once they are at least 24 h old,
  and expire if not refreshed within 60 days.
- **Insights:** post views include replies to the root. User-level `replies` count only top-level replies. Insights for
  repost facades are empty.

## Unverified

The sandbox could not reach developers.facebook.com; these come from search snippets or best understanding:

- The authorization host: `threads.com/oauth/authorize` (current Meta docs) vs `threads.net/oauth/authorize` (older guides).
  The URL can be overridden through the `authorizeUrl` option.
- The `alt_text` parameter name on Threads IMAGE, VIDEO and carousel-item containers.
- The user insight metrics `clicks` and `followers_count`, and their response shapes. `clicks` may be broken down by
  `link_url`; the connector sums the series or reads `total_value`. Refused metrics are skipped.
- The webhook envelope (`target_id`, `values[] { field, value }`) and routing by `target_id`. The parser also accepts a
  Graph-style `entry[].changes[]` envelope.
- Whether Threads webhooks are signed with the Threads app secret in `X-Hub-Signature-256`, as Meta's other webhooks are.
- `threads_delete` as the permission name for `DELETE /{media-id}`.
- Whether `/conversation` returns `hide_status` and `root_post` for every reply, and its paging. Only the first page is read.

## Questions for the owner

1. Is **threads_delete** wanted? It is in the default scopes so that "delete" works for the account's own posts and replies.
   Dropping it shortens App Review.
2. Should mention webhooks be enabled? They need **`threads_manage_mentions`** (not requested yet) and its own review.
3. Is keyword search or listening on Threads wanted? That is `threads_keyword_search`, a separate review and not built.
4. base air needs **uninstall and delete-data callback endpoints** for the Threads app settings. Who owns building those?
   Meta requires them before going live.
5. Which Threads profiles will be testers during development, and who records the review screencasts?
6. Should the API host be `graph.threads.com` (Meta's newer name) instead of the default `graph.threads.net`?
