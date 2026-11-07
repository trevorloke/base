# Misskey (and Sharkey, Firefish, Iceshrimp, other Misskey-API servers)

Connector `misskey` · networks `["misskey"]` · `packages/connectors/src/misskey.ts` · factory `createMisskeyConnectors(env)`

## What works
- **Connect (typed credentials, `connectMethod: "api_key"`)**: the person enters their server (`misskey.io`, `https://sharkey.example`, `@me@misskey.io` all work) and an access token (`secret: true`). The token is checked with `POST /api/i`; `POST /api/meta` supplies the server's `maxNoteTextLength`, name and version. Identity: externalId `<user id>@<host>`, handle `@user@host`. Auth `{ token, host, userId }`; config `{ host, maxNoteTextLength, serverName, serverVersion }`. Tokens do not expire: `refreshAuth` returns `null`. Private/loopback hosts are refused.
- Every call is `POST https://<host>/api/<endpoint>` with a JSON body; the token travels as the `i` field (accepted by every Misskey generation and fork; current Misskey also accepts `Authorization: Bearer`).
- **Publish**: `POST /api/notes/create` with `text`, `visibility` mapped from `options.visibility` (public → `public`, unlisted → `home`, private → `followers`, direct → `specified`), `cw` from `options.contentWarning` (≤ 100 chars), a poll from `options.poll` (`choices`, `expiredAfter` = minutes × 60,000 ms). Up to 16 files are uploaded to the drive with `POST /api/drive/files/create` (multipart: `i`, `file`, `comment` = alt text, `isSensitive` from `options.nsfw`; bytes from `this.media.fetch`) and attached as `fileIds`. Misskey processes files synchronously, so there is no wait loop. Threads are a `replyId` chain; `replyToExternalId` sets the first note's `replyId`. In-process idempotency cache; a part-posted thread resumes and reports `partial`; uploads are reused on retry.
- **Validate**: per-server text limit (from connect), poll ≤ 10 choices of ≤ 50 characters, CW ≤ 100, ≤ 16 files, non-empty notes.
- **Inbox**: `POST /api/i/notifications` with `includeTypes: [mention, reply, quote, renote, reaction, follow]`, `limit: 100`, `markAsRead: false` (Starsign does not clear the person's notification badge), paged newest-first with `untilId` until an item predates `since` (bounded by `maxPages`). Mapping: mention → `mention`, reply → `reply`, quote → `quote` (externalId = the note id, so `reply`/`moderate` work on it), renote → `repost`, reaction → `like` (emoji in `text`), follow → `follow` (externalId `notification:<id>@<host>`). CW is prefixed to the text as `CW: …`.
- **reply**: reads the parent (`/api/notes/show`) and replies with its visibility, so a reply never widens a followers-only thread.
- **moderate**: `like` = `/api/notes/reactions/create` with 👍 (configurable; notes that only accept likes convert it to ❤), `unlike` = `/api/notes/reactions/delete`, `delete` = `/api/notes/delete` (own notes). `ALREADY_REACTED` / `NOT_REACTED` count as success. `hide`/`unhide` are refused.
- **Metrics**: `/api/notes/show` → `likes` = all reactions (`reactionCount`, or the sum of `reactions`), `reposts` = `renoteCount`, `replies` = `repliesCount`, `engagements` = sum. Deleted notes (`NO_SUCH_NOTE`) are skipped. No impressions exist. **Account**: `followers_total` from `/api/i` `followersCount`.
- **Errors**: body `{ error: { code, message, id } }`. 401 / `AUTHENTICATION_FAILED` → auth; 403 / `PERMISSION_DENIED` → auth (message lists the needed permissions); 429 / `RATE_LIMIT_EXCEEDED` → rate_limit, retryable, with `Retry-After`; other 4xx → rejected; 5xx and transport → network, retryable.
- **Webhooks**: not used. Misskey has per-user webhooks (Settings → Webhook) but they are set up by hand per account; activity is polled.

## Setup
- On the person's server: **Settings → API → Generate access token** (on Sharkey/Firefish/Iceshrimp the same page may be under Settings → API or Apps). Give it a name ("Starsign") and these permissions: `read:account`, `write:notes`, `read:notifications`, `write:reactions`, `write:drive`. Paste the server host and the token into Starsign.
- No developer app, redirect URI or webhook URL. Env vars: optional `MISSKEY_LIKE_REACTION` (default `👍`).
- Later step: **MiAuth** (`https://<host>/miauth/<session>?name=Starsign&callback=…&permission=…`, then `POST /api/miauth/<session>/check`) lets the person approve in the browser instead of copying a token. It would use the redirect `${STARSIGN_PUBLIC_URL}/oauth/misskey/callback`.

## Review and access requirements
None. Any account can create tokens on its own server; there is no central review. Server admins can restrict API use, suspend accounts or set roles with lower rate limits.

## Limits and quotas
- From Misskey's source (defaults; forks and admins can change them): `notes/create` 300 per hour per user, `i/notifications` 30 per 30 s, `drive/files/create` 120 per hour.
- Text: `maxNoteTextLength` (Misskey default 3,000; read at connect). CW 100 characters. Up to 16 files per note. Polls 2-10 choices of ≤ 50 characters.
- Drive capacity and maximum file size are per role on each server.

## What Starsign can and cannot see
- **Can see**: the account's notifications of the listed types (mentions, replies, quotes, renotes, reactions, follows), the notes they point to, and counts on the account's own notes. Notifications are read without marking them as read.
- **Cannot see**: chat/direct messages (`specified` notes that do not mention the account are invisible to it), timelines, impressions or reach, who viewed a note, other people's drive files.
- **Holds**: the access token (encrypted). The person can revoke it any time in Settings → API / Apps.

## Unverified
- `TODO(verify)`: with `visibility: "specified"` (Starsign "direct"), current Misskey adds users mentioned in the text to `visibleUserIds`; the connector sends no explicit `visibleUserIds`.
- Endpoint parameters (notes/create, i/notifications incl. `includeTypes`/`untilId`/`markAsRead`, drive/files/create, notes/reactions/create, notes/delete, meta `maxNoteTextLength`), the `i`/Bearer token handling and the 429 + `Retry-After` behavior were read from Misskey's `develop` source in November 2026. Forks (Sharkey, Firefish, Iceshrimp) were not checked individually; they keep the same API but some older Firefish versions may lack `reactionCount` (the connector falls back to summing `reactions`).
- Tests mock `fetch`; no live server was called.

## Questions for the owner
- Which reaction should "like" send: 👍, ❤, or the server's custom `:like:` emoji?
- Should thread follow-ups use `home` visibility (common etiquette) instead of the root's visibility?
- Do you want MiAuth (browser approval) built next, so people never copy a token?
- Should Starsign also pull the account's own notes into the feed (`/api/users/notes`), like the Mastodon connector does?
