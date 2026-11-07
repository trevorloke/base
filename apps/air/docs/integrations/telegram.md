# Telegram

Connector `telegram` · networks `["telegram"]` · `packages/connectors/src/telegram.ts` · factory `createTelegramConnectors(env)`

## What works
- **Connect** (`connectMethod: "bot_token"`): inputs `botToken` (secret) and `chat` (`@channel`, `t.me/channel` or a numeric chat id). `connectWithInputs` calls `getMe`, `getChat` and `getChatMember` and requires the bot to be an administrator (and, for channels, allowed to post). externalId is the chat id; handle `@username` or the chat title; config keeps chat type, title, username, linked discussion group id, bot id/username and whether a webhook was registered. Auth blob: `{ botToken }`.
- **Publish**: `sendMessage` in `parse_mode=HTML` with full escaping of `& < >`; `options.title` becomes a bold first line, `options.link` is appended when not in the text. One media → `sendPhoto` / `sendVideo` (supports_streaming, duration, size) / `sendAnimation` (GIF) / `sendDocument`; 2–10 media → `sendMediaGroup` with the caption on the first item. Media goes **by URL** first (Telegram fetches up to 5 MB photos / 20 MB other) and falls back to **multipart upload** from the core media fetcher when the file is larger, the URL is not https, or Telegram says it cannot fetch it. Captions over 1024 characters are sent as a follow-up text message. Polls via `sendPoll` (anonymous, as channels require; `open_period` only when ≤ 600s). Idempotent in-process.
- **Inbox**: without a webhook, `getUpdates` is polled with a shared per-bot offset (so several chats on one bot share the stream). With a webhook, items arrive through `webhook.parse`. Mapping: `channel_post` → own_post; a message in the linked discussion group replying to the automatic forward of a channel post → `comment` on that channel post (routed to the channel account); replies to the bot → `reply`; messages naming `@bot` → `mention`; other group messages → `comment`. Private chats are ignored. External ids are `<chat id>:<message id>`.
- **reply**: replies with `reply_parameters`. A reply to a channel post goes to its copy in the discussion group when that copy has been seen; otherwise the reply is posted in the parent's chat.
- **moderate**: `delete` → `deleteMessage`; `like`/`unlike` → 👍 reaction via `setMessageReaction`; hide/unhide refused.
- **Metrics**: per-message views are **not available through the Bot API**, so `fetchMetrics` is empty and `capabilities.fetchMetrics` is false. `fetchAccountMetrics` returns `followers_total` from `getChatMemberCount`.
- **Webhooks**: when `TELEGRAM_WEBHOOK_SECRET` (and `STARSIGN_PUBLIC_URL`) are set, connecting calls `setWebhook` with `secret_token` and `allowed_updates: ["message","channel_post"]`; `webhook.verify` compares `X-Telegram-Bot-Api-Secret-Token` in constant time; `webhook.parse` turns one Update into a batch for the right chat.
- Errors: 429 → rate_limit with `retry_after`; 401/404 → auth (bad token); 403 → auth (bot kicked / lacks rights); 409 → rejected (getUpdates while a webhook is set); 400 → rejected; 5xx/network → retryable. Error messages never include the bot token.

## Setup
1. In Telegram, talk to **@BotFather** → `/newbot` → copy the token.
2. Add the bot to the channel as an **administrator** with "Post messages" (and "Delete messages" for moderation). For comments, also add it to the channel's linked discussion group (admin, so it receives all messages despite privacy mode).
3. In Starsign, connect Telegram with the token and the channel's @username or id.
- Redirect URI: none (not OAuth).
- Webhook URL: `${STARSIGN_PUBLIC_URL}/webhooks/telegram` (registered automatically on connect when the secret is configured).
- Env vars: `TELEGRAM_WEBHOOK_SECRET` (1–256 chars of `A-Z a-z 0-9 _ -`; enables webhooks), `STARSIGN_PUBLIC_URL`, optional `TELEGRAM_API_BASE` (self-hosted Bot API server).

## Review and access requirements
None. Any bot token works immediately; the only requirement is admin rights in the target chat.

## Limits and quotas
- ~30 messages/second per bot overall, ~20 messages/minute per group, about 1 message/second per chat (Telegram FAQ guidance); 429 responses carry `retry_after`.
- Text 4096 characters, captions 1024, albums 2–10 items (no GIFs, documents only with documents), poll question 300 characters, 2–10 options of ≤ 100 characters.
- Upload by URL: 5 MB photos, 20 MB other files. Multipart upload: 10 MB photos, 50 MB other (2 GB with a self-hosted Bot API server).
- Updates wait at most 24 hours on Telegram's side for `getUpdates`.

## Unverified
- Bot API 9.6/10.x added poll fields (`correct_option_ids`, reported `members_only` requirement in 10.0 by python-telegram-bot); the connector sends only `question`, `options` (InputPollOption objects), `is_anonymous` and `open_period`. Confirm `sendPoll` still accepts that minimal set.
- Telegram's documentation site was not reachable from the sandbox; method names and fields come from long-standing Bot API behaviour (reply_parameters since 7.0, InputPollOption since 7.3, setMessageReaction since 7.0).

## Questions for the owner
- Should Starsign own the bot's webhook? `setWebhook` replaces any webhook the bot already has (and disables `getUpdates` for other tools using the same bot). Use a dedicated bot per brand if unsure.
- Disconnecting does not call `deleteWebhook`; should it?
- Are long polls (> 10 minutes) acceptable as "open until closed manually"? Telegram's `open_period` caps at 600 seconds.
