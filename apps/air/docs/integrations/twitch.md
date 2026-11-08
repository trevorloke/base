# Twitch

Connector `twitch` · networks `["twitch"]` · `packages/connectors/src/twitch.ts` · factory `createTwitchConnectors(env)`

For creators and brands with a channel: watch and answer chat, delete messages, count followers.

## What works
- **Connect** (`connectMethod: "oauth"`, OAuth 2.0 authorization code; client id/secret in the token request body).
  Authorize `https://id.twitch.tv/oauth2/authorize`, token `https://id.twitch.tv/oauth2/token`.
  One account = the broadcaster who logs in (`GET /helix/users`): externalId = user id, handle = login, displayName = display name.
  Auth `{ accessToken, refreshToken, expiresAt, scope, userId, login }`; config `{ broadcasterId, login, broadcasterType, eventsub }`.
- **EventSub subscriptions at connect**: when `BASE_AIR_PUBLIC_URL`, `TWITCH_EVENTSUB_SECRET` and the client secret are set,
  the connector gets an **app access token** (client credentials, cached) and creates two webhook subscriptions
  (`POST /helix/eventsub/subscriptions`), callback `${BASE_AIR_PUBLIC_URL}/webhooks/twitch`:
  `channel.chat.message` v1 (`broadcaster_user_id` = `user_id` = the broadcaster) and `channel.follow` v2
  (`moderator_user_id` = the broadcaster). 409 (already exists) counts as success. The result is stored in
  `config.eventsub` as `subscribed`, `not_configured` (with what to set) or `failed` (with Twitch's message); the connection
  never fails because of it.
- **Webhook** `/webhooks/twitch` (app-wide secret):
  - `verify`: HMAC-SHA256 over `Twitch-Eventsub-Message-Id + Twitch-Eventsub-Message-Timestamp + raw body` with
    `TWITCH_EVENTSUB_SECRET`, compared constant-time with `Twitch-Eventsub-Message-Signature` (`sha256=<hex>`); deliveries
    whose timestamp is more than 10 minutes off are rejected (replay protection); no secret → everything rejected.
  - `webhook_callback_verification`: the body's `challenge` is answered as `text/plain` (see "Core change" below).
  - `revocation`: ignored (no items).
  - `channel.chat.message` → kind `message`; `mention` when a mention fragment targets the broadcaster; `reply` when it
    replies to one of the broadcaster's messages. externalId `<broadcaster id>:<message id>`, parentExternalId for replies,
    `conversation { id: broadcaster id, name: login, type: "channel" }`, url = the channel. The broadcaster's own messages are skipped.
  - `channel.follow` → kind `follow` (externalId `<broadcaster id>:follow:<user id>`, `followed_at`).
  - `fetchActivity` returns `[]` (chat cannot be polled); `capabilities().fetchActivity` is false and `webhooks` true.
- **Publish**: `POST /helix/chat/messages` as the broadcaster (`broadcaster_id` = `sender_id`), text only, ≤ 500 characters
  (validated). A message Twitch drops (`is_sent: false`, e.g. AutoMod or duplicate) is a `rejected` error with the drop reason.
  externalId `<broadcaster id>:<message id>`, url = the channel. Idempotent in-process.
- **Reply**: the same endpoint with `reply_parent_message_id` (only messages in the account's own channel).
- **Moderate**: `delete` → `DELETE /helix/moderation/chat?broadcaster_id&moderator_id&message_id`. Other actions refused.
- **Metrics**: chat messages have none (`fetchMetrics` → `[]`). **Account**: `GET /helix/channels/followers?broadcaster_id=…` → `total` → followers_total.
- **Refresh**: `refreshAuth` with the stored refresh token (user tokens last about 4 hours).
- **Errors**: 401 → auth; 403 → auth; 429 → rate_limit retryable with the `Ratelimit-Reset` time; 409/400 → rejected; 5xx/network → retryable.

## What Base Air can and cannot see
Base Air sees messages typed in the connected broadcaster's own chat while subscriptions are active, and new followers.
It does not see whispers (private messages), other channels' chats, chat from before the connection, or VOD/stream content.
Nothing is collected when `BASE_AIR_PUBLIC_URL`/`TWITCH_EVENTSUB_SECRET` are not configured.

## Setup
1. Register an application at https://dev.twitch.tv/console/apps (Category: e.g. "Website Integration", client type **Confidential**).
2. OAuth Redirect URL: `${BASE_AIR_PUBLIC_URL}/oauth/twitch/callback`.
3. Copy the Client ID and generate a Client Secret.
4. Choose a random EventSub secret (10–100 ASCII characters) for `TWITCH_EVENTSUB_SECRET`.
5. `BASE_AIR_PUBLIC_URL` must be publicly reachable over **HTTPS on port 443**; Twitch posts to `${BASE_AIR_PUBLIC_URL}/webhooks/twitch`.
6. Connect (or reconnect) the channel after setting these, so the subscriptions are created.
- Scopes (minimal): `user:read:chat`, `user:bot`, `channel:bot` (read chat over webhooks with an app token: the chatting user
  grants `user:bot`, the broadcaster `channel:bot` — here both are the broadcaster), `user:write:chat` (send and reply),
  `moderator:manage:chat_messages` (delete), `moderator:read:followers` (channel.follow; the follower total needs no scope).
- Env vars: `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_EVENTSUB_SECRET`, `BASE_AIR_PUBLIC_URL`.

## Core change
Done: core's `WebhookHandler.respond(body, headers)` answers the signed callback verification with its `challenge` as text/plain. The handler keeps no state between deliveries.

## Review and access requirements
No app review for these scopes. Chat sending is subject to the channel's AutoMod and chat settings (follower-only,
verified-phone, etc.). Unverified bots are limited in send rate; the broadcaster sending in their own channel has
broadcaster limits.

## Limits and quotas
- Helix: 800 points per minute per user token (most calls cost 1); `Ratelimit-Reset` gives the reset time.
- Chat: 500 characters per message; about 20 messages per 30 seconds for a non-moderator, 100 per 30 seconds for the
  broadcaster/moderators (TODO(verify) current chat limits for the Send Chat Message API).
- EventSub: webhook subscriptions are limited by cost (max total cost 10,000 per client id; these subscriptions cost 0 once
  the user has authorized the app). Twitch revokes a webhook subscription when the callback keeps failing.
- Webhooks must answer within a few seconds; duplicates are possible (core dedupes on externalId).

## Unverified
- `TODO(verify)`: reading chat as the broadcaster (`user_id` = `broadcaster_user_id`) satisfies the `user:bot` + `channel:bot`
  requirement for app-token webhook subscriptions without a separate bot account.
- Chat send limits above; whether `channel:bot` is still required when the reader is the broadcaster.
- Timestamps of chat items are the time Base Air received the delivery (the event has no timestamp; the message timestamp
  header is not passed to `parse` by core).

## Questions for the owner
- Should Base Air speak in chat as the broadcaster (today) or as a separate bot account (a second login with `user:bot`)?
- Should "announce" use `/helix/chat/announcements` (highlighted message, needs `moderator:manage:announcements`)?
- Do you want subscriptions, cheers, raids or channel-point redemptions in the feed (more EventSub types and scopes)?
