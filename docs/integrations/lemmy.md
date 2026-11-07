# Lemmy

Connector `lemmy` · networks `["lemmy"]` · `packages/connectors/src/lemmy.ts` · factory `createLemmyConnectors(env)`

## What works
- **Connect (typed credentials, `connectMethod: "app_password"`)**: instance host, username or email, password (`secret`), optional 2FA code (`secret`, `optional`), optional communities to post to and watch (comma list; `name`, `name@instance`, `!name@instance` or `https://instance/c/name`). `POST /api/v3/user/login` returns a JWT; `GET /api/v3/site` (Bearer JWT) gives the person. Each community is resolved with `GET /community?name=` and, for remote communities the instance has not seen yet, `GET /resolve_object?q=!name@instance`. Identity: externalId `<person id>@<host>`, handle `@name@host`. Auth `{ host, usernameOrEmail, password, jwt, personId }`; config `{ host, apiBase, communities: [{ name, id, title }], personName }`.
- **Re-login**: Lemmy has no refresh tokens or scoped app tokens. `refreshAuth` logs in again with the stored credentials; every call also re-logs in once and retries on HTTP 401 or `not_logged_in`. A 2FA code is single-use, so accounts with 2FA must reconnect when their JWT stops working (the error says so).
- **Publish**: `POST /api/v3/post` with `name` = `options.title` (required, ≤ 200 characters), `body` = the text (markdown), `url` = `options.link`, `nsfw`, `community_id` (first configured community, or `options.subreddit` naming another community by name). One image is uploaded to the instance's pict-rs (`POST /pictrs/image`, field `images[]`, Bearer JWT) and becomes the post URL (with `alt_text`); when a link is also given, the image is embedded in the body as markdown instead. If the instance refuses uploads (disabled, too large), the public Starsign media URL is linked. Videos and documents are linked, not uploaded. `options.firstComment` → `POST /api/v3/comment`; if it fails the post is kept, the error carries `partial`, and a retry posts only the comment. In-process idempotency cache.
- **Validate**: title required, no threads (use the first comment), one media item, a community must be configured or named.
- **Inbox**: `GET /user/mention` → `mention`; `GET /user/replies` (read and unread) → `comment` for a top-level comment on our post, `reply` for a reply to our comment; `GET /post/list?community_id=…&sort=New&type_=All` for each watched community → `message` (our own posts there → `own_post`). All items carry `conversation = { id: "name@instance", name: title, type: "group" }` (the community). Pages of 50, newest first, until an item predates `since`. External ids: `post:<id>@<host>`, `comment:<id>@<host>`; parent = the parent comment (from the comment `path`) or the post. Lemmy 0.18 zone-less timestamps are read as UTC.
- **reply**: to a post → `POST /comment { post_id, content }`; to a comment → looks up its post (`GET /comment?id=`) and sends `{ post_id, parent_id, content }`.
- **moderate**: `like` = `/post/like` or `/comment/like` with `score: 1`, `unlike` = `score: 0`, `delete` = `/post/delete` or `/comment/delete` with `deleted: true` (the instance only allows the author). `hide`/`unhide` are refused (removing others' content is a moderator action, not wired).
- **Metrics**: `GET /post?id=` → `likes` = upvotes, `replies` = comments, `engagements` = upvotes + downvotes + comments; comments work the same with `GET /comment?id=` (`child_count`). Deleted/unknown items are skipped. No views exist.
- **Account metrics: none.** Lemmy people have no followers; the person aggregates (post and comment counts, and scores on older versions) are not canonical metrics. `accountMetrics` is false.
- **Errors**: body `{ error: "snake_case_code" }`, mostly HTTP 400. `rate_limit_error`/429 → rate_limit (retryable); login/session codes (`incorrect_login`, `not_logged_in`, `missing_totp_token`, `email_not_verified`, `site_ban`, …) and 401 → auth; 403 → rejected on writes; other 4xx → rejected; 5xx and transport → network (retryable).
- **Webhooks**: none (Lemmy has no outbound webhooks for users). Activity is polled.

## Setup
- No developer app. The person uses their normal Lemmy login. Recommend a dedicated account for the brand.
- Redirect URI: none. Webhook URL: none.
- Env vars: optional `LEMMY_API_BASE` (default `/api/v3`); an account's `config.apiBase` overrides it.

## Review and access requirements
None from Lemmy itself. Each instance has its own rules: many require registration approval or email verification before login works, some forbid bots or brand accounts, and communities can restrict posting to moderators. Accounts that automate should set "bot account" in their profile where the instance's rules ask for it.

## Limits and quotas
- Lemmy 0.19 default rate limits per IP (admins change them): posts 6 per 10 min, comments 6 per 10 min, image uploads 6 per hour, other API calls 180 per minute. `TODO(verify)` the current defaults; Starsign calls from one server IP, so several accounts on one instance share these buckets.
- Title 200 characters; body and comments 10,000 characters (Starsign's generic limit for `lemmy` is 10,000 characters and 1 media item, no threads).
- Image upload size is set per instance (pict-rs config).

## What Starsign can and cannot see
- **Can see**: mentions of the account, replies to its posts and comments, new posts in the communities it watches (public), and vote/comment counts on its posts and comments.
- **Cannot see**: private messages (not read), who voted, views, posts in communities it does not watch, anything on instances that block the account's instance.
- **Holds**: the account's password and JWT (encrypted). Lemmy has no scoped tokens, so Starsign can do anything the person can. Changing the password revokes Starsign's access.

## Unverified
- `TODO(verify)`: Lemmy 1.0 moves to `/api/v4` with renamed routes (login under `/account/auth/login`, the user's data at `GET /api/v4/account`, notifications combined under `/account/notification/list`, cursor pagination, image upload at `/api/v4/image`). The base path is configurable but only v3 route names are implemented; a v4 adapter is needed once 1.0 is common.
- `TODO(verify)`: pict-rs upload at `POST /pictrs/image` with field `images[]` and response `{ msg: "ok", files: [{ file, delete_token }] }` matches lemmy-js-client 0.19; whether every 0.19.x instance accepts the Bearer header there (older ones read the `jwt` cookie) was not tested live.
- `TODO(verify)`: `resolve_object` federates a remote community on first use and can be slow or time out on busy instances.
- v3 request/response shapes (Login, GetPersonMentions, GetReplies, CreatePost, CreateComment, PostView, CommentView, aggregates) were read from lemmy-js-client `release/v0.19`. Tests mock `fetch`; no live instance was called.

## Questions for the owner
- Lemmy needs the account password (no app tokens). Is that acceptable, or should Lemmy be limited to monitoring with a read-only account?
- Should Starsign add a real "community" field to the composer (today: the first configured community, or `options.subreddit` as a name)?
- Should private messages (`/private_message/list`) come into the inbox as `dm`?
- Watched communities produce `message` items for every new post. Should that be limited to posts matching keywords?
