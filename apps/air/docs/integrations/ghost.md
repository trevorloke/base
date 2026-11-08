# Ghost

Connector `ghost` · networks `["ghost"]` · `packages/connectors/src/ghost.ts` · factory `createGhostConnectors(env)` · shared text→HTML helper `packages/connectors/src/html.ts`

## What works
- **Connect** (`connectMethod: "api_key"`): inputs `apiUrl` (the API URL on the integration screen; a pasted `…/ghost/` admin URL is accepted), `adminApiKey` (secret, `<24 hex id>:<64 hex secret>`), and optional `newsletter` (a newsletter slug). `connectWithInputs` reads `GET /ghost/api/admin/site/` (title, canonical URL), proves the key with `GET /posts/?limit=1&fields=id`, and when a newsletter slug is given checks `GET /newsletters/?filter=slug:<slug>` exists and is active. externalId/handle = site key `host[/path]`, displayName = site title. Auth blob `{ apiUrl, adminApiKey }`; config `{ siteUrl, siteTitle, newsletter }`.
- **Auth on every request**: a fresh JWT built with `node:crypto` (no dependency): header `{ alg: "HS256", typ: "JWT", kid: <key id> }`, payload `{ iat, exp: iat + 300, aud: "/admin/" }`, HMAC-SHA256 with the **hex-decoded** secret; sent as `Authorization: Ghost <token>` with `Accept-Version: v6.0` (same as `@tryghost/admin-api` 1.14). Override the version with `GHOST_ACCEPT_VERSION`.
- **Publish** (`POST /ghost/api/admin/posts/?source=html`): `{ posts: [{ title, html, status: "published", visibility, tags: [{ name }], feature_image, feature_image_alt }] }`.
  - `title` = `options.title` (required).
  - `html` = the post text rendered to safe HTML; `options.link` appended when missing; images after the first are placed inline.
  - Images/GIFs are uploaded with `POST /images/upload/` (multipart `file` with filename, `purpose=image`, `ref`), bytes from `this.media.fetch`. The first upload is the `feature_image` unless `options.thumbnailUrl` is set (used directly as the feature image URL).
  - `visibility`: `public` / unset → `public`; `unlisted` → `members`; `private` / `direct` → `paid`.
  - Tags: `options.tags` de-duplicated case-insensitively; Ghost creates missing tags by name.
  - **Newsletter send**: when the account has a `newsletter` slug and the variant's tags include **`#newsletter`** (removed before sending) — or the account config has `emailEveryPost: true` — the request adds `newsletter=<slug>&email_segment=<segment>`. Segment: config `emailSegment` if set (`all`, `status:free`, `status:-free`, or any Ghost member filter), else `status:-free` for paid-only posts and `all` otherwise. No schema change: the opt-in is an ordinary tag. `validate` flags `#newsletter` on an account without a slug.
  - Returns `externalId` = post id, `url` = post URL. Idempotent in-process; uploads are reused on retry.
  - Video and document attachments are refused (`validate` + `publish`).
- **Inbox (best effort)**: `fetchActivity` reads member comments from `GET /ghost/api/admin/comments/?include=member,post&order=created_at asc&filter=created_at:>'<since>'` (100 per page, ≤ 5 pages), the endpoint Ghost Admin's comment moderation (Feb 2026) uses. Mapping: kind `comment`, externalId = comment id, `parentExternalId` = post id, `authorName` = member name, `authorHandle` = null (members are identified by email, which is never copied), text = comment HTML as plain text, `url` = post URL. When the site answers 404/403/501 (older Ghost, or integrations not allowed) the account is remembered and `fetchActivity` returns `[]` without further calls.
- **moderate (best effort)**: `hide` → `PUT /comments/<id>/ { comments: [{ id, status: "hidden" }] }`, `unhide` → `status: "published"`. `delete`, `like`, `unlike` are refused. **reply** is not offered: Ghost comments are written by members, not by staff integrations.
- **Metrics**: `fetchMetrics` reads `GET /posts/<id>/?include=email,count.clicks`; for emailed posts: `reach` = `email.delivered_count` (else `email_count`), `impressions` = `email.opened_count`, `link_clicks` = `count.clicks`. Posts that were never emailed have no rows; unknown posts are skipped. `fetchAccountMetrics`: `followers_total` = `meta.pagination.total` of `GET /members/?limit=1`.
- **Errors**: Ghost's `{ errors: [{ type, message, context }] }` is put in the message. 401/403 → auth; 404/422 → rejected; 429 → rate_limit with `Retry-After`; 5xx/transport → retryable. Messages never contain the key.

## What Base Air can and cannot see
With the best-effort comments endpoint available, Base Air sees member comments on the site's posts: the member's name, the comment and the post. It does not store member emails, does not see member lists beyond the total count, payment data, or email replies sent to the newsletter's reply-to address.

## Setup
1. Ghost Admin → **Settings → Integrations → Add custom integration** → name it "Base Air".
2. Copy the **Admin API key** (not the Content API key) and the **API URL**.
3. Optional: Settings → Newsletters → open the newsletter → note its slug (shown in the URL / newsletter settings). Enter it when connecting to enable `#newsletter` sends.
4. In Base Air, connect Ghost with the API URL, Admin API key and optional newsletter slug.
- Redirect URI: none (not OAuth). Webhook URL: none today (Ghost webhooks exist for post/member events but carry no comments; polling is used).
- Env vars: optional `GHOST_ACCEPT_VERSION` (default `v6.0`).
- Account config the owner may set (no UI yet): `emailEveryPost: true` (email every publish), `emailSegment` (recipient filter).

## Review and access requirements
None. A custom integration's Admin API key has full Admin API access immediately. Ghost(Pro) plans without custom integrations (Starter) cannot create Admin API keys. Newsletter sending requires Ghost's email (Mailgun) to be configured — automatic on Ghost(Pro), manual on self-hosted.

## Limits and quotas
- Ghost does not publish fixed Admin API rate limits; Ghost(Pro) applies request limits and returns 429 (`TooManyRequestsError`), handled as retryable.
- Image uploads: the site's upload limit (Ghost(Pro) images up to about 10 MB; self-hosted depends on the proxy).
- Tokens must expire within 5 minutes of `iat`; Base Air signs a new one per request (clock skew on the server can still cause 401s).

## Unverified
- `GET /ghost/api/admin/site/` answers without authentication (hence the extra authenticated `/posts/` call to prove the key).
- The Admin comments endpoint: path `/ghost/api/admin/comments/`, its filter syntax (`created_at:>'…'` with an ISO timestamp), `include=member,post`, the comment field names (`post_id`, `html`, `member.name`, `post.url`), that integration tokens may read it, and the `PUT /comments/:id/` hide/show body. Not in Ghost's public Admin API reference.
- `include=email,count.clicks` on a single post and the field names `email.delivered_count`, `email.opened_count`, `count.clicks`.
- `docs.ghost.org` was not reachable from the sandbox; the token format, upload fields, `Accept-Version: v6.0` and endpoint paths were confirmed from the `@tryghost/admin-api` 1.14.14 and `@tryghost/admin-api-schema` 4.7.5 package sources on npm.

## Questions for the owner
- Is the `#newsletter` tag the right per-post opt-in for email sends, or should every post on an account with a newsletter be emailed (set `emailEveryPost`)?
- Which segment should non-paid posts go to by default (`all` vs `status:free`)?
- Is the visibility mapping (unlisted → members, private → paid) acceptable?
- Should video uploads (`/media/upload/`) be added for Ghost video cards?
