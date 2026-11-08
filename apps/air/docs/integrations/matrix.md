# Matrix

Connector `matrix` · networks `["matrix"]` · `packages/connectors/src/matrix.ts` · factory `createMatrixConnectors(env)`

Any Matrix homeserver (Synapse, Conduit/conduwuit, Dendrite, matrix.org…) through the official **Client-Server API
v3**. One Base Air account = one Matrix user (externalId = the MXID, e.g. `@baseair:example.org`, which already
names the homeserver). Use a dedicated account for Base Air, not a person's own account.

## What works
- **Connect** (`connectMethod: "api_key"`): inputs `homeserver` (URL or server name), `accessToken` (secret,
  optional), or `user` + `password` (optional; used once for `POST /_matrix/client/v3/login` with
  `m.login.password`, device name "Base Air"; the password is never stored), and `rooms` (optional comma list of room
  ids `!…` or aliases `#…`; the first unencrypted one is where posts go). A bare server name is resolved through
  `/.well-known/matrix/client`. `GET /account/whoami` verifies the token (guests refused); the display name comes from
  `/profile/{userId}/displayname`. Aliases resolve via `GET /directory/room/{alias}`. A listed room the account is not
  in is joined (`POST /join/{idOrAlias}`: accepts a pending invite or joins a public room); if that fails, connect is
  refused with "invite the account first". Without `rooms`, every joined room (max 50) is watched. Each room's name
  (`m.room.name` state) and whether it is encrypted (`m.room.encryption` state) are recorded. Auth blob:
  `{ homeserver, accessToken, userId, deviceId }`.
- **Listen** (`fetchActivity`): one `GET /sync?timeout=0` per poll with an inline filter: only the watched rooms,
  timeline types `m.room.message` and `m.room.encrypted` (limit 50 per room), state `m.room.name` and lazy-loaded
  `m.room.member`, top-level account data `m.direct`, no presence/receipts/typing. The `next_batch` token is kept in
  memory per account; the first poll (or after a restart) gets the latest events and drops those not after `since`.
  Mapping of `m.room.message`:
  - skipped: the account's own events, edits (`m.replace`), redacted events, `m.notice` (the msgtype bots use).
  - `reply` when it has `m.relates_to.m.in_reply_to` to one of the account's messages (sent by this process, or the
    reply mentions the account, as Matrix replies do); `parentExternalId` = `"<room>:<event id>"`.
  - `mention` when `m.mentions.user_ids` contains the account; for older clients without `m.mentions`, the MXID or
    the display name (as a whole word) in the body.
  - `dm` in rooms marked direct in `m.direct`, else `message`. Conversation `{ id: room id, name, type: "group" }`
    (`"direct"` for DMs); names from sync state or connect.
  - text = `body` (legacy reply fallbacks `> …` stripped); images/files/video/audio/location → `[Image: name]` etc.
  - externalId `"<room id>:<event id>"`; url = `https://matrix.to/#/<room>/<event>`; authorHandle = sender MXID,
    authorName = room display name when known; `raw` = the event.
  - **Encrypted rooms**: `m.room.encrypted` events are counted in `connector.lastSync.get(accountId).encryptedSkipped`
    and skipped. Rooms where the timeline was `limited` (a gap) are listed in `lastSync.limitedRooms`.
- **reply**: `PUT /rooms/{roomId}/send/m.room.message/{txnId}` with `m.relates_to: { m.in_reply_to: { event_id } }` and
  `m.mentions.user_ids = [parent sender]` (when seen). **txnId** = `starsign-` + sha256 of the idempotency key, so the
  homeserver itself dedupes a retried send with the same key (same access token), on top of the in-process cache.
- **publish** to the default room: `m.text` with `body` (plain) plus `format: org.matrix.custom.html` and
  `formatted_body` when the text has markdown-lite (`**bold**`, `*italic*`/`_italic_`, `` `code` ``,
  `[text](url)`); `m.mentions: {}` so a post never pings anyone. `options.link` appended when missing. One media file:
  `POST /_matrix/media/v3/upload?filename=…` (raw bytes) → `mxc://` URI → `m.image` / `m.video` / `m.audio` /
  `m.file` event with `info` (mimetype, size, w, h, duration). Text event = externalId; media event = thread id.
- **moderate**: `like` = `m.reaction` with `m.annotation` key 👍; `unlike` = find the account's 👍 via
  `GET /_matrix/client/v1/rooms/{roomId}/relations/{eventId}/m.annotation/m.reaction` and redact it; `delete` =
  `PUT /rooms/{roomId}/redact/{eventId}/{txnId}` (others' messages need a high enough power level; 403 → `rejected`).
  No hide.
- **fetchAccountMetrics**: `followers_total` = members of the default room (`GET /rooms/{id}/joined_members`).
  **fetchMetrics**: none.
- **Errors**: 401 / `M_UNKNOWN_TOKEN` / `M_MISSING_TOKEN` → `auth`; 429 / `M_LIMIT_EXCEEDED` → `rate_limit` with
  `retry_after_ms` (waited once when ≤ 5 s); 403 `M_FORBIDDEN` on room actions → `rejected` (on login → `auth`);
  5xx and transport errors → retryable `network`. Messages never contain the token.

## What Base Air can and cannot see
- **Can see**: unencrypted messages in the rooms the Base Air account has joined and you chose to watch, including
  direct chats with it, and who wrote them. Images and files show as short descriptions, not their contents.
- **Cannot see**: **end-to-end encrypted rooms** (most DMs and many private rooms created by Element default to
  encryption). Reading them needs an E2EE-capable device holding Olm/Megolm keys, which this connector does not
  implement; it counts and skips those events. Also not visible: rooms the account is not in, messages from before it
  joined (beyond what /sync returns), edits and deletions.

## Setup
1. Create a dedicated Matrix account for Base Air on your homeserver (or matrix.org).
2. Get an access token: in Element, **Settings → Help & About → Advanced → Access Token** (treat it as a password;
   logging that session out invalidates it). Or let Base Air log in once with user + password.
3. Invite the account to the rooms to watch (or make sure they are public), and give it a power level that allows
   redaction if it should delete others' messages.
4. In Base Air, connect Matrix with the homeserver, the token (or user + password) and the rooms.
- Redirect URI: none. Webhook URL: none (polling /sync).
- Env vars: none.

## Review and access requirements
None. Matrix is an open protocol; any account on a homeserver that allows it can use the Client-Server API. Some
homeservers restrict registration or rate-limit new accounts; ask the server admin to exempt the Base Air account
from rate limits if it is busy.

## Limits and quotas
- Rate limits are per homeserver (Synapse defaults to a few messages per second per user with bursts); 429s carry
  `retry_after_ms`.
- Events are capped at 65,536 bytes as JSON; the connector allows 30,000 characters of text. Media upload size is
  set by the homeserver (`GET /_matrix/client/v1/media/config` → `m.upload.size`; Synapse default 50 MB).
- One /sync per poll with up to 50 timeline events per room; busier rooms report a gap (`limited`) that is not
  back-filled.

## Unverified
- `// TODO(verify)` upload stays on `/_matrix/media/v3/upload` after authenticated media (Matrix 1.11, MSC3916),
  which moved download/thumbnail to `/_matrix/client/v1/media/*`. Search results covered the download side only.
- The relations endpoint path (`/_matrix/client/v1/rooms/{roomId}/relations/{eventId}/{relType}/{eventType}`) and
  that replies mention the replied-to user (spec "Mentioning the replied to user") are from memory of the spec.
- Reply fallbacks were removed in Matrix v1.13 (confirmed via the v1.13 changelog); the connector no longer sends
  them and strips them from incoming messages.

## Questions for the owner
- Should Base Air persist the `/sync` `next_batch` token (it lives in memory today, so a restart re-reads the latest
  50 events per room, deduped by core)?
- Do you want E2EE support later (a device with key storage and cross-signing), or are unencrypted community rooms
  enough?
- Should the connector auto-join rooms it is invited to after connect?
