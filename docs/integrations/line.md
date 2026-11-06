# LINE

Connector `line` · networks `["line"]` · `packages/connectors/src/line.ts` · factory `createLineConnectors(env)`

Uses only the official **LINE Messaging API** (`https://api.line.me`). One Starsign account = one LINE Official
Account's Messaging API channel (its bot). Shapes follow LINE's official OpenAPI definitions
([line/line-openapi](https://github.com/line/line-openapi): `messaging-api.yml`, `webhook.yml`, `insight.yml`),
read November 2026.

## What works
- **Connect** (`connectMethod: "bot_token"`): inputs `channelAccessToken` (secret, the long-lived token) and
  `channelSecret` (secret). `connectWithInputs` calls `GET /v2/bot/info` and returns one account: externalId = the
  bot's `userId` (the same value LINE puts in a webhook's `destination`), handle = `basicId` (e.g. `@123abcde`),
  displayName. It also reads `GET /v2/bot/channel/webhook/endpoint` (informational) and keeps in config whether
  the channel's webhook URL points at Starsign and whether "Use webhook" is on. A bad token → `auth` error. Auth
  blob: `{ channelAccessToken, channelSecret }`. `describeAccount` reads the bot info again.
- **Webhooks** (per-channel secret): `route` reads `destination` from the unverified body; `verifyAccount` checks
  `x-line-signature` = base64(HMAC-SHA256(channel secret, raw body)) in constant time with that account's secret.
  Core ingests only into accounts that verified (another channel's secret cannot speak for this one).
  `parse` maps:
  - message events from a **group** → `message` in conversation `{ id: groupId, type: "group" }`; from a
    **room** (older multi-person chat) → `message` in `{ id: roomId, type: "group" }`; from a **user** (1:1 with the
    official account) → `dm` in `{ id: userId, type: "direct" }`.
  - a mention of the bot (`message.mention.mentionees[].isSelf === true`) → `mention`; quoting a message this
    process pushed → `reply`; `quotedMessageId` → `parentExternalId`.
  - text as is; sticker / image / video / audio / file / location → short summaries (`[Sticker: happy, smile]`,
    `[Image 2/3]`, `[Video 1:05]`, `[File: menu.pdf (2.4 MB)]`, `[Location: title, address]`). Content is not downloaded.
  - `join` (bot added to a chat), `memberJoined` (one item per member) and `follow` (friend add / unblock) → `follow`.
  - `unsend`, `leave`, `memberLeft`, `unfollow`, `postback`, `messageEdited` and others → ignored.
  - externalId `"<conversation id>:<message id>"`; occurredAt from `timestamp` (ms); authorHandle = `source.userId`
    (an opaque per-provider id, no phone numbers); `raw` = the whole event (keeps `replyToken`, `quoteToken`,
    `webhookEventId`, `deliveryContext.isRedelivery`). Redeliveries keep the same message id, so core's dedupe on
    externalId drops them.
  - LINE's console "Verify" button sends an empty `events` array: it verifies and ingests nothing.
- **Names**: `parse` is synchronous and network-free, so group names and display names come from an in-memory
  cache. Parse records what it could not name; `resolveNames(account)` (also run by `fetchActivity`) looks them up
  (`GET /v2/bot/group/{groupId}/summary`, `/v2/bot/group/{groupId}/member/{userId}`,
  `/v2/bot/room/{roomId}/member/{userId}`, `/v2/bot/profile/{userId}`), bounded to 20 lookups per call. Until then,
  and after a restart, names are `null`. Because `capabilities.fetchActivity` is false, core does not call it today;
  wiring `resolveNames` into a periodic job (or the webhook path) is the owner's call.
- **reply**: push message `POST /v2/bot/message/push` `{ to: <conversation id>, messages: [{ type: "text", text, quoteToken? }] }`
  to the conversation before the colon in the parent's externalId. The parent's `quoteToken` (seen in its webhook,
  kept in memory) makes LINE show the reply as a quote. `X-Line-Retry-Key` is a UUID derived from the idempotency
  key; a `409` (key already accepted) is treated as sent, using the `sentMessages` LINE returns with it (or
  `x-line-accepted-request-id`). Reply tokens are not used: they are single-use and expire in about a minute.
- **Publish**: broadcast to all friends (`POST /v2/bot/message/broadcast`), or push to `config.defaultGroupId` when
  the account config has one. Text (`options.link` appended when missing) plus at most one JPEG/PNG image
  (`originalContentUrl` = `media.url`, `previewImageUrl` = `options.thumbnailUrl` or `media.url`). Same retry key and
  409 handling. Broadcast returns no message ids, so its externalId is `broadcast:<x-line-request-id>`.
- **validate**: empty, > 5000 characters, threads, > 1 media, non-image / non-JPEG-PNG, non-HTTPS URL, URL > 2000
  characters, image > 10 MB, and preview > 1 MB (an image over 1 MB needs `options.thumbnailUrl`).
- **moderate**: not available (bots cannot hide or delete users' messages) → `rejected`.
- **fetchActivity**: `[]` (webhook-only; LINE has no history API). **fetchMetrics**: `[]`.
- **fetchAccountMetrics**: `followers_total` from `GET /v2/bot/insight/followers?date=yyyyMMdd` for yesterday in
  Asia/Tokyo (`followers`). `unready` falls back one day; still `unready` or `out_of_service` → no metric. Note that
  `followers` counts first-time friend adds and does **not** drop when people block the account.
- **fetchMessageQuota(account)**: `{ type, limit, used }` from `GET /v2/bot/message/quota` and
  `/v2/bot/message/quota/consumption`. A note for the UI, not a metric.
- **Errors**: 401 → `auth`; 429 → `rate_limit` (retryable), except "You have reached your monthly limit." →
  `rejected`, not retryable, with a plain message; 403 → `rejected` (the channel may not use that endpoint, e.g.
  plan-gated); other 4xx → `rejected` with LINE's `details`; 5xx and transport failures → retryable. Messages never
  contain the token.

## What Starsign can and cannot see
- **Can see**: messages in LINE **group chats and multi-person chats the official account's bot was invited to**,
  and **1:1 messages people send to the official account**; friend adds, unblocks, and people joining those groups.
  Stickers, photos, videos, voice messages, files and locations show as short descriptions, not the content.
- **Cannot see**: anyone's personal chats, groups the bot is not in, messages sent before the bot joined, or
  messages from LINE on PC/web in some group cases (LINE only includes `userId` for iOS/Android senders).
  **LINE OpenChat has no bot API**, so OpenChat rooms cannot be monitored. LINE VOOM posts and timeline comments
  are not in the Messaging API either.
- Names of people who are not friends of the account are only available through the group they wrote in.

## Setup
1. Create (or open) a **LINE Official Account** and, in **LINE Official Account Manager → Settings → Messaging API**,
   enable the Messaging API. This creates a **Messaging API channel** under a provider in the
   [LINE Developers console](https://developers.line.biz/console/).
2. In the LINE Developers console, open the channel:
   - **Basic settings** tab → copy the **Channel secret**.
   - **Messaging API** tab → **Channel access token (long-lived)** → **Issue**, and copy it. (Reissuing invalidates
     the previous long-lived token, so reconnect in Starsign afterwards.)
   - **Webhook URL** = `${STARSIGN_PUBLIC_URL}/webhooks/line`, then turn on **Use webhook** and press **Verify**.
   - Optionally turn on **Webhook redelivery** (redeliveries are deduped by message id).
3. In **LINE Official Account Manager → Settings → Response settings / Account settings**:
   - Allow the account to **join group chats and multi-person chats** ("Allow bot to join group chats").
   - Turn off **Auto-reply messages** and **Greeting messages** if Starsign (or a person) should answer instead.
4. In Starsign, connect LINE with the channel access token and channel secret. Invite the official account to the
   groups to monitor. To publish into one group instead of broadcasting, set `defaultGroupId` (a `C…` group id,
   visible in that group's webhook items) in the account config.
- Redirect URI: none (not OAuth).
- Webhook URL: `${STARSIGN_PUBLIC_URL}/webhooks/line`.
- Env vars: `STARSIGN_PUBLIC_URL` (used to check the webhook URL at connect), optional `LINE_API_BASE` (tests or a
  proxy). No app-wide secret: each account's channel secret is stored in its encrypted auth blob.

## Review and access requirements
None for the features used here. Any Messaging API channel works as soon as the token is issued. Insight
(`/v2/bot/insight/followers`) is available to official accounts generally; some APIs (narrowcast audiences,
mission stickers, the "verified"/premium account features) need extra applications and are not used.

## Limits and quotas
- **Message allowance (the main limit).** Push and broadcast messages count against the official account's monthly
  allowance; **broadcast counts once per friend**, push once per recipient (a group push counts each member, per
  LINE's pricing docs). Reply messages (reply token) are free, but the connector uses push for dependability.
  Japan plans as of late 2026: Communication (free, 200 messages/month, no extra), Light (¥5,000, 5,000, no extra),
  Standard (¥15,000, 30,000, extra messages charged). Prices differ by country (Taiwan revised 1 Nov 2026;
  Thailand differs). When the allowance runs out, sends fail with 429 "You have reached your monthly limit."
- **Rate limits** are per endpoint and per channel (token bucket); 429 without the monthly-limit text is retryable.
  Broadcast is limited to a small number of requests per hour.
- Text ≤ 5000 characters; up to 5 message objects per request (the connector sends ≤ 2). Images: JPEG/PNG over
  HTTPS (TLS 1.2+), URL ≤ 2000 characters, original ≤ 10 MB, preview ≤ 1 MB.
- Retry keys are honoured for 24 hours; a 2xx means LINE accepted the send, not that every recipient got it.
- Insight data is aggregated daily (UTC+9) and is usually ready the next day.

## Unverified
- `// TODO(verify)` in `line.ts`: image limits (10 MB original, 1 MB preview, 2000-character URLs). The OpenAPI
  spec has the fields but not the limits; the numbers come from secondary copies of LINE's reference
  (developers.line.biz was not reachable from the sandbox).
- The exact text of the monthly-limit 429 (the connector matches `/monthly limit/i`) and that it is the only
  quota-type 429 message. Confirmed from LINE's reference as quoted in search results, not fetched directly.
- Rate-limit numbers per endpoint (e.g. broadcast per hour) were not confirmed; the doc avoids exact numbers.
- Retry-key lifetime of 24 hours (from the Japanese "retrying API requests" guide, via search snippets).
- Whether a group push counts one message per member against the allowance (stated by LINE's pricing page as
  "counted by the number of people you send to"; not tested).
- Japan plan prices/allowances and the Standard-plan overage revision announced for late 2026 were seen only via
  search results.
- Long-lived channel access tokens are still listed as non-expiring in LINE's current docs (a 2018 deprecation
  notice never took effect, as far as current docs show).
- Whether a `messageEdited` event should update an already ingested message (ignored today; core dedupes by id).

## Questions for the owner
- Should `resolveNames` run periodically (core does not call `fetchActivity` because the capability is false), or
  should names stay null? Display names are personal data; LINE allows reading them for people in the bot's chats.
- Publishing: broadcast to all friends (costly: one message per friend) or push to one group by default? Should
  `defaultGroupId` be exposed in the room's account settings?
- Should replies use the free reply token when it is still fresh (< ~1 minute after the message) and fall back to
  push? It saves quota but a lost response can then double-send.
- Can the media library produce a ≤ 1 MB preview rendition automatically, so images over 1 MB do not need a
  manual thumbnail?
- Which LINE plan and region is the account on (so Starsign can warn before the monthly allowance runs out)?
