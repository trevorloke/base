# Discord

Connector `discord` · networks `["discord"]` · `packages/connectors/src/discord.ts` · factory `createDiscordConnectors(env)`

## What works
- **Connect** (`connectMethod: "webhook_url"`): one input, the channel webhook URL. Accepted: `https://discord.com/api/webhooks/{id}/{token}`, `discordapp.com`, `ptb.`/`canary.` hosts, optional `/v{n}` and `?thread_id=`. `connectWithInputs` GETs the webhook (with its token) to prove it exists and read `guild_id`, `channel_id`, `name`. externalId = webhook id; auth `{ webhookUrl }` (normalized to discord.com API v10); config `{ webhookId, guildId, channelId, threadId, name }`.
- **Publish**: execute webhook with `?wait=true` so the message id comes back. `content` up to 2000 characters, `allowed_mentions: { parse: [] }` (scheduled posts never ping @everyone, roles or users), an embed for `options.link` when the link is not already in the text (title from `options.title`, thumbnail from `options.thumbnailUrl`), up to 10 file attachments uploaded as multipart (`payload_json` + `files[n]`, alt text as attachment `description`) from the core media fetcher, polls (`poll.question`, answers, duration in hours rounded up, max 768h), posting into a thread when the URL has `thread_id`. Result URL `https://discord.com/channels/{guild}/{channel}/{message}`. Idempotent in-process.
- **moderate**: `delete` → `DELETE /webhooks/{id}/{token}/messages/{message_id}` (webhooks can delete only their own messages). Other actions refused.
- **No inbox, no replies, no metrics, no follower counts**: webhooks are write-only. `capabilities` declare `fetchActivity`, `fetchMetrics`, `reply`, `accountMetrics` false; `fetchActivity`/`fetchMetrics` return [].
- Errors: 429 → rate_limit with `retry_after` (body or `X-RateLimit-Reset-After`); 401 and 404 Unknown Webhook (10015) → auth ("reconnect"); 400 → rejected with Discord's error code and field errors; 5xx/network → retryable. The webhook token is scrubbed from messages.

## Setup
1. In Discord: Server Settings or Channel Settings → Integrations → Webhooks → New Webhook → choose the channel → Copy Webhook URL (requires Manage Webhooks).
2. In base air, connect Discord and paste the URL. To post into a specific thread, append `?thread_id=<thread id>`.
- Redirect URI: none. Webhook URL (inbound): none.
- Env vars: none.

## Review and access requirements
None. A webhook works as soon as it is created. Anyone holding the URL can post as it, so it is stored encrypted like other credentials.

## Limits and quotas
- Webhook rate limit: roughly 5 requests / 2 seconds per webhook, and about 30 messages/minute per channel; honour `retry_after`.
- 2000 characters of content, 10 embeds, 10 files per message; 10 MiB per upload on unboosted servers (more with boosts); poll: question 300 characters, up to 10 answers of 55 characters, duration up to 32 days.

## Unverified
- `TODO(verify)`: execute-webhook accepts the `poll` object the same way as create-message.
- `TODO(verify)`: 10 MiB default upload cap (Discord lowered it from 25 MiB in 2024; boosted servers allow more). Validation flags files over 10 MiB when the size is known.
- Forum and media channels require `thread_name` or `thread_id`; the connector does not create forum threads yet (use a `?thread_id=` URL).

## Questions for the owner
- Should posts be allowed to ping roles or @everyone (today all mentions are suppressed)?
- Do you want a custom username/avatar per post, or forum-thread creation from `options.title`?
- For an inbox and metrics, a Discord bot (OAuth2 bot + Gateway) would be needed; is that in scope?

---

# Discord bot (monitoring servers)

Connector `discord_bot` · networks `["discord"]` · `packages/connectors/src/discord-bot.ts` · factory `createDiscordBotConnectors(env)`

The webhook connector above can only post. The bot connector lets base air **read** a server: it brings messages from the server's channels into the live feed, and it can reply, react, delete and post. It uses Discord's official bot API (REST v10, `Authorization: Bot <token>`). It never uses self-bots or user tokens.

## What works
- **Connect** (`connectMethod: "bot_token"`). Inputs: bot token (secret), server (guild) ID, and an optional channel ID for posts. `connectWithInputs`:
  1. `GET /users/@me` checks the token. A bad token gives an `auth` error, and a user (non-bot) token is refused.
  2. `GET /guilds/{id}?with_counts=true` reads the server. A 403/404 means the bot is not in that server, which gives a `rejected` error telling you to invite it.
  3. `GET /applications/@me` checks that the **Message Content** intent is on (application flags). If it is off, you get a `rejected` error that names the intent.
  4. `GET /guilds/{id}/channels` plus `GET /guilds/{id}/members/{botId}` keep the text (0), announcement (5), forum (15) and media (16) channels where the bot's roles and the channel overwrites allow **View Channel** and **Read Message History**.
  5. It reads the newest 20 messages of the default channel. If every message from a person comes back blank, you get a `rejected` error that names the **Message Content** intent.
  - Result: ONE account per server, with externalId = guild ID and handle = server name. Auth is `{ botToken, guildId }`. Config is `{ guildId, botId, botUsername, channels: [{id,name,type}], defaultChannelId }`. The default channel is the first text channel by position, or the channel ID you entered.
- **Listen** (`fetchActivity(account, since)`): REST polling. Each text/announcement channel is read with `GET /channels/{id}/messages?after=<snowflake>&limit=100`, paging forward. Each channel keeps its own in-memory cursor (the newest message ID seen). When there is no cursor yet (first poll, or after a worker restart), the first `after` comes from `since` (`(ms - 1420070400000) << 22`). With neither, only the newest page is read.
  - Forum/media channels hold only threads. Up to 10 of their most recently active public threads (`GET /guilds/{id}/threads/active`) are polled the same way, and so are active threads under text channels.
  - Each poll is bounded: at most 3 pages (300 messages) per channel or thread. A channel answering 403 Missing Access or 404 is skipped while the others continue. If a rate limit lasts longer than the one short wait, the poll returns what it already read and the remaining channels wait for the next poll.
  - Mapping: kind `reply` when the message answers a message by the bot (`message_reference` + `referenced_message.author.id`). Kind `mention` when the bot is in `mentions` or the text contains `<@botId>`/`<@!botId>`. Otherwise `message`. The bot's own messages and system messages (joins, pins, boosts, thread starters, command echoes) are skipped. Only types 0 DEFAULT and 19 REPLY are kept.
  - Fields: `conversation` = `{ id: channelId, name: "#general", type: "channel" }` (for threads, `"#forum › thread title"`). externalId = `"<channelId>:<messageId>"`. url = `https://discord.com/channels/<guild>/<channel>/<message>`. authorHandle = username, authorName = display name (`global_name`). text = content, or `[attachment: file.png]` / `[sticker: name]` when there is no text. parentExternalId is set for replies. Forwards are not treated as replies. `raw` holds the full message.
- **Reply**: `POST /channels/{channelId}/messages` with `message_reference` to the parent (`fail_if_not_exists: false`). Mentions are suppressed except a ping to the person being answered (`allowed_mentions: { parse: [], replied_user: true }`).
- **Publish**: posts to the account's default channel. Text up to 2000 characters. All pings are suppressed (`allowed_mentions: { parse: [] }`). `options.link` becomes an embed when the link is not already in the text. Up to 10 files are sent as multipart (`payload_json` + `files[n]`, alt text as the attachment description), with bytes read through the core media fetcher. Idempotent in-process (`IdempotencyCache`). `validate` flags text over 2000 characters, more than 10 files, thread segments, an empty message, and files over 10 MiB.
- **Moderate**: `delete` → `DELETE /channels/{c}/messages/{m}`. The bot can always delete its own messages; deleting other people's needs **Manage Messages**, and without it you get an `auth` error that names that permission. `like`/`unlike` → `PUT`/`DELETE /channels/{c}/messages/{m}/reactions/%F0%9F%91%8D/@me` (a 👍 reaction). `hide`/`unhide` → `rejected` (Discord has no hide).
- **Account metrics**: `followers_total` = `approximate_member_count` from `GET /guilds/{id}?with_counts=true`.
- **No post metrics**: bots cannot see views. `fetchMetrics` returns [].
- **Errors**: 429 → `rate_limit`, retryable, with `retryAfter` from the body `retry_after` or the `X-RateLimit-Reset-After` header. A `retry_after` of 5 s or less is waited out once inside the call. 401 → `auth` ("reset the token"). 403 → `auth` (50001 Missing Access / 50013 Missing Permissions are told apart). Other 4xx → `rejected` with Discord's code. 5xx/network → `network`, retryable. Error messages are built from the status and Discord's JSON body only, and transport errors have the token scrubbed, so the bot token never appears in an error.
- **No Gateway (WebSocket)**: base air workers poll, so new messages arrive at the polling interval, not instantly. Real-time delivery (and reactions, edits and deletes as events) needs a Gateway connection, which is a later step.

## Setup
1. Open the Discord Developer Portal → **Applications** → **New Application** → name it (e.g. "base air").
2. **Bot** page → **Reset Token** → copy the token (shown once). Under **Privileged Gateway Intents**, turn on **Message Content Intent**. **Server Members Intent** and **Presence Intent** are not needed.
3. **OAuth2 → URL Generator**: scope `bot`. Bot permissions: **View Channels**, **Read Message History**, **Send Messages**, **Add Reactions**, and optionally **Manage Messages** (only to delete other people's messages). Open the generated URL and add the bot to your server (needs Manage Server on that server).
4. To keep the bot out of a channel, deny it View Channel there. Channels it cannot read are not listed.
5. In Discord: User Settings → Advanced → **Developer Mode** on. Then right-click the server → **Copy Server ID** (and optionally right-click a channel → Copy Channel ID for posts).
6. In base air, connect **Discord (bot)** and paste the token and server ID.
- Redirect URI: none. Inbound webhook URL: none.
- Env vars: none.
- New channels created after connecting are picked up when you reconnect the server.

## What base air can and cannot see
- **Can see**: messages in the text, announcement and forum channels of the connected server where the bot has View Channel and Read Message History, plus active public threads in those channels. It sees the text, attachment file names, author username and display name, and which message a reply answers. Only messages since the previous poll (or since connect) are read.
- **Cannot see**: servers the bot was not invited to, channels it is denied, private threads, voice/stage chat, DMs (not polled), deleted or edited message history, reactions as events, member lists, presence or email addresses. No user tokens are ever used, and base air never reads anything as a person.

## Review and access requirements
- None while the bot is in **fewer than 100 servers**: you turn on the Message Content intent yourself.
- Once an application is in 100 or more servers, it must pass Discord's **app verification**, and Message Content becomes a privileged intent that Discord must approve (they ask why you need it). Each customer using their own bot application stays far below this. A shared base air-owned bot would hit it.

## Limits and quotas
- Global rate limit is about 50 requests/second per bot. Per-route limits come in the `X-RateLimit-*` headers. Repeated invalid requests (401/403/429) can get the bot's IP temporarily banned, which is why the poll is bounded and skips forbidden channels.
- Each poll reads at most 3 pages × 100 messages per channel and up to 10 active threads. A very busy channel catches up over several polls (the cursor moves forward each poll).
- Messages: 2000 characters, 10 files; 10 MiB per upload on unboosted servers.

## Unverified
- `TODO(verify)`: bot token format (three dot-separated base64url parts). Discord does not document it, so the connector only checks the shape.
- `TODO(verify)`: bots may call `GET /applications/@me`, and flags `1<<18` / `1<<19` are `GATEWAY_MESSAGE_CONTENT` / `GATEWAY_MESSAGE_CONTENT_LIMITED`. If the call fails, the connector falls back to the sample check.
- `TODO(verify)`: `GET /guilds/{id}/members/{botId}` works for the bot itself without the Server Members intent. If it fails, every channel of the right type is listed and polling skips the 403s.
- `TODO(verify)`: with `after`, Discord returns the messages immediately after the ID, sorted newest first. The connector does not rely on the order (it pages by the largest ID seen).
- `TODO(verify)`: 10 MiB default upload cap.
- Whether the "messages that mention the bot keep their content" exemption from the Message Content intent applies to REST reads as well as Gateway events.

## Questions for the owner
- Should each customer create their own bot (recommended: no verification, their own token), or should base air run one shared verified bot?
- Which channels should be monitored: all readable ones (today), or a chosen list?
- Should replies ping the person being answered (today: yes, nobody else)?
- How often should servers be polled? A Gateway worker for real-time messages would be a separate long-running process; is that in scope?
- Should DMs to the bot be monitored as well (needs a Gateway or user-initiated DM channels)?
