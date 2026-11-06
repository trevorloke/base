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
2. In Starsign, connect Discord and paste the URL. To post into a specific thread, append `?thread_id=<thread id>`.
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
