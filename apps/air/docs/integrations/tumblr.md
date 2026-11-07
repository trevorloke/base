# Tumblr

Connector `tumblr` · networks `["tumblr"]` · `packages/connectors/src/tumblr.ts` · factory `createTumblrConnectors(env)`

## What works
- **Connect** (`connectMethod: "oauth"`, OAuth 2.0 authorization code, no PKCE, client credentials in the token request body).
  Authorize `https://www.tumblr.com/oauth2/authorize`, token `https://api.tumblr.com/v2/oauth2/token`, scopes `basic write offline_access`.
  `oauthConnect` reads `GET /v2/user/info` and returns **one account per blog** the login belongs to (primary, secondary
  and group blogs): externalId = blog `uuid` (e.g. `t:abc…`), handle = blog name, displayName = blog title. Every account
  stores the shared user token plus `blogName`/`blogUuid`; config `{ blogName, blogUuid, primary, url }`.
  `connectConfigured` is false until `TUMBLR_CLIENT_ID` and `TUMBLR_CLIENT_SECRET` are set. `describeAccount` matches the
  blob's blog in `/user/info`.
- **Refresh**: `refreshAuth` uses the refresh token from `offline_access`. Because all blogs of one login share the
  token, a rotated refresh token is remembered in-process (old → new) so the sibling blogs refresh onto the same new token
  instead of failing.
- **Publish** (Neue Post Format) `POST /v2/blog/{blog}/posts`, `state: "published"`, kinds `post`, `link`, `carousel`, `video`:
  - text split into one NPF text block per paragraph (long paragraphs split at line breaks, ≤ 4096 characters per block);
    `options.title` becomes a `heading1` block first;
  - images and video are read through the core media fetcher and sent as **multipart**: a `json` part with the post and one
    file part per media item, referenced from the image/video block by `identifier`; alt text → `alt_text`; width/height when known;
  - `options.link` → a `link` block (title from `options.title`);
  - `options.tags` → the comma-separated `tags` field (leading `#` and commas removed).
  Result URL `https://www.tumblr.com/{blog}/{id}`. Idempotent in-process. Reblogs are out of scope.
- **Inbox**: `GET /v2/blog/{blog}/notifications` with `types[]` filters, paged with `before` (3 pages by default) and cut at
  `since`. Kinds: `reply` → reply, `reblog_with_content` → quote, `mention` / `mention_in_reply` / `mention_in_post` → mention,
  `like` → like, `follow` → follow, `ask` → dm. Reblogs and post mentions get externalId `<their blog>:<post id>` (so they can
  be liked); other notifications use the notification id or a stable composite (`<type>:<from>:<target post>:<timestamp>`).
  `parentExternalId` = `<blog>:<target post id>`.
- **Reply**: not available — the public API has no endpoint to write a reply. `capabilities().reply` is false.
- **Moderate**: `like` / `unlike` → `GET /v2/blog/{blog}/posts/{id}` for the `reblog_key`, then `POST /v2/user/like|unlike {id, reblog_key}`.
  `hide`/`delete` are refused (Tumblr has no API to remove other people's notes).
- **Metrics**: `GET /v2/blog/{blog}/notes?id=…&mode=all` → `total_notes` → engagements, `total_likes` → likes,
  `total_reblogs` → reposts. **Account**: `GET /v2/blog/{blog}/followers?limit=1` → `total_users` → followers_total (blog owners/admins only).
- **Errors**: 401 → auth; 403 → auth; 429 → rate_limit retryable (with `Retry-After`); 400 mentioning a limit → rate_limit
  (daily post cap); other 4xx → rejected; 5xx/network → retryable. Messages include Tumblr's `meta.msg` and `errors[].detail`.

## What base air can and cannot see
base air sees the activity of the blogs you connect: replies to your posts, reblogs that add a comment, mentions, likes,
new followers and asks. It does not see your dashboard, other blogs' private content or messages (Tumblr's chat has no API).

## Setup
1. Register an application at https://www.tumblr.com/oauth/apps (logged in as the account that will own the app).
2. Default callback / OAuth2 redirect URL: `${BASE_AIR_PUBLIC_URL}/oauth/tumblr/callback`.
3. Copy the OAuth consumer key and secret.
- Scopes requested: `basic`, `write`, `offline_access`.
- Webhook URL: none (Tumblr does not push events; the inbox polls).
- Env vars: `TUMBLR_CLIENT_ID` (consumer key), `TUMBLR_CLIENT_SECRET` (consumer secret).

## Review and access requirements
No formal app review for these endpoints today. New apps get the default rate limits; Tumblr can raise limits on request.
Group blogs: members can post but only admins can read followers (followers metrics fail with 403 for non-admins).

## Limits and quotas
- API: about 1,000 requests/hour and 5,000/day per consumer key by default (TODO(verify) current numbers).
- Posting: about 250 posts/day per user (plus reblogs), 150 photo uploads/day; a 400 mentioning the limit is mapped to rate_limit.
- Up to 10 media per post (base air's network limit); one video per post (TODO(verify)); tags ≤ 140 characters.
- Access tokens last about 42 minutes; refresh with the stored refresh token.

## Unverified
- `TODO(verify)`: the full list of notification type names (`mention` vs `mention_in_reply` / `mention_in_post`; all three are requested and mapped).
- `TODO(verify)`: asks mapped to `dm`.
- `TODO(verify)`: the public API has no endpoint to write a reply to a post (reply capability is off).
- `TODO(verify)`: whether Tumblr rotates refresh tokens on refresh (handled either way).
- `TODO(verify)`: one video per post.
- `TODO(verify)`: NPF also accepts `media: [{ url }]` for public URLs; the connector uploads bytes (documented multipart path).
- `TODO(verify)`: `notes?mode=all` returns `total_notes`, `total_likes`, `total_reblogs` (missing fields are skipped, not zeroed).
- Rate limit numbers above.

## Questions for the owner
- Should base air connect every blog of a login automatically (today), or let you pick?
- Do you want posts queued/drafted on Tumblr (`state: queue` / `draft`) instead of published immediately?
- Is reblogging (sharing others' posts) needed later?
