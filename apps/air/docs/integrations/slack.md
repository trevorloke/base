# Slack

Connector `slack` · networks `["slack"]` · `packages/connectors/src/slack.ts` · factory `createSlackConnectors(env)`

For a company's own workspace or a community workspace, through an **internal Slack app** (installed only to that
workspace, so no Slack Marketplace review). Uses the official Web API (`https://slack.com/api/<method>`) and the
Events API. One Starsign account = one workspace (externalId = the team id `T…`).

## What works
- **Connect** (`connectMethod: "bot_token"`): inputs `botToken` (secret, the Bot User OAuth Token `xoxb-…`),
  `signingSecret` (secret, optional; needed only for real-time events) and `channelIds` (optional, comma-separated;
  the first is where posts go). `auth.test` checks the token (a user token `xoxp-…` or a token without `bot_id` is
  refused) and gives the team id, team name, workspace URL and the bot's user id. `conversations.list`
  (`types=public_channel,private_channel`, `exclude_archived`, 200 per page, cursor-paged) lists channels, kept only
  where `is_member` is true. A listed channel the app is not in is refused with a `/invite` hint. Default channel:
  the first listed id, else the first public channel the app is in. Config keeps the channel list, the watch list,
  and `eventsRequestUrl` = `${STARSIGN_PUBLIC_URL}/webhooks/slack?team=<team id>` (the URL to paste into Slack).
  `describeAccount` calls `auth.test`.
- **Events API webhook** (per-workspace signing secret): `route` reads the team from `?team=` first, then the body's
  `team_id` / `authorizations[0].team_id`. `verifyAccount` checks `X-Slack-Signature` = `v0=` + hex
  HMAC-SHA256(signing secret, `v0:{X-Slack-Request-Timestamp}:{raw body}`) in constant time, and refuses
  timestamps more than 5 minutes off. An account connected without a signing secret never verifies.
  - **`url_verification`**: the handshake comes as a signed POST with **no team id in the body**, which is why the
    Request URL carries `?team=`. After it verifies, the handler's `respond` echoes the `challenge` as text/plain;
    event deliveries get core's default JSON reply, which Slack accepts.
  - `parse` maps `event_callback` envelopes: `message` events from people (skipping `bot_id`, the bot's own user,
    and every subtype except `thread_broadcast` and `file_share`) and `app_mention` events. Kinds: `dm` in an im,
    `reply` for a thread reply to a message the app posted (`parent_user_id` = the bot, or a ts this process posted),
    `mention` when the text contains `<@bot user id>` or the event is `app_mention`, else `message`. Conversation:
    `{ id: channel, name: "#name", type: "channel" }` for public and private channels, `type: "group"` for group DMs
    (mpim), `type: "direct"` for ims. externalId `"<channel>:<ts>"`; `parentExternalId` = `"<channel>:<thread_ts>"`
    for thread replies; `url` = permalink built from the workspace URL; `raw` = the whole envelope. The bot user id
    comes from `authorizations[].is_bot`; channel names are learned when the account verifies (parse stays
    synchronous). Slack's retries and the duplicate `message` + `app_mention` pair for one message share the same
    externalId, so core's dedupe drops them.
- **Polling fallback** (`fetchActivity`): `conversations.history` for each watched channel (all member channels when
  no watch list; max 50) with `oldest` = max(per-channel cursor, `since`), `inclusive=false`, `limit=200`, following
  `response_metadata.next_cursor` up to 3 pages. Without a cursor or `since` only the newest page is read. Cursors are
  in memory. Channels the app left (`not_in_channel`, `channel_not_found`, `is_archived`) are skipped. On HTTP 429
  the connector honors `Retry-After` once when it is ≤ 5 s, otherwise returns what it has read (or throws
  `rate_limit` with `retryAfter` when nothing was read). Author names come from `users.info` (max 20 lookups per
  poll, cached). Polling sees top-level messages and thread broadcasts only; thread replies arrive through events.
- **reply**: `chat.postMessage` with `thread_ts` = the thread root (a reply to a reply still goes to the root, when
  the reply was seen by this process). Idempotent per key in-process.
- **publish**: `chat.postMessage` to the default channel with `mrkdwn`, `unfurl_links` and `unfurl_media` on. Text
  is converted from markdown-lite (`**bold**` → `*bold*`, `~~x~~` → `~x~`, `[text](url)` → `<url|text>`) after
  escaping `&`, `<`, `>`. `options.link` is appended when missing (Slack unfurls it). **Files** (up to 10) use the
  current flow: `files.getUploadURLExternal` (filename, length, `alt_txt`) → POST the bytes to `upload_url` →
  `files.completeUploadExternal` (`files` JSON, `channel_id`, text as `initial_comment`). The message ts comes from
  the file's `shares` (polled with `files.info` up to 3 times); if it never appears, the externalId is
  `"<channel>:file:<file id>"`.
- **moderate**: `like` = `reactions.add` `thumbsup`, `unlike` = `reactions.remove` (`already_reacted` /
  `no_reaction` count as done); `delete` = `chat.delete` (bot tokens delete only the app's own messages;
  `cant_delete_message` → `rejected`). No hide.
- **fetchMetrics**: `reactions.get` on the app's messages → `likes` (sum of reactions) and `replies` (`reply_count`).
- **fetchAccountMetrics**: `followers_total` = `conversations.info include_num_members=true` → `num_members` of the
  default channel.
- **Errors**: Slack answers HTTP 200 + `ok:false`. `invalid_auth`, `token_revoked`, `account_inactive`,
  `missing_scope` (with the needed scope in the message) … → `auth`; HTTP 429 / `ratelimited` → `rate_limit`
  (retryable, `retryAfter` from the header); `internal_error`, `fatal_error`, 5xx, transport errors → retryable
  `network`; other codes → `rejected`. Messages never contain the token.

## What Starsign can and cannot see
- **Can see**: messages in the public and private channels the app was invited to, direct messages people send to
  the app, group DMs that include the app, and mentions of the app. Reaction counts and reply counts on the app's own
  posts. Files show as `[file: name]`, not their contents.
- **Cannot see**: channels the app is not in, anyone's private DMs with other people, messages from before the app
  joined (except through history polling of channels it is in), edits and deletions (ignored), and other apps' bot
  messages (skipped on purpose). Slack Connect channels shared from another org behave like channels the app is in
  only if the app was added there.

## Setup
1. <https://api.slack.com/apps> → **Create New App** → From scratch → pick the workspace.
2. **OAuth & Permissions → Bot Token Scopes**: `channels:read`, `groups:read`, `channels:history`, `groups:history`,
   `im:history`, `mpim:history`, `chat:write`, `reactions:read`, `reactions:write`, `files:write`, `files:read`,
   `users:read`, `app_mentions:read`. Then **Install to Workspace** and copy the **Bot User OAuth Token** (`xoxb-…`).
3. **Basic Information → App Credentials** → copy the **Signing Secret**.
4. In Starsign, connect Slack with the token, the signing secret and optionally channel ids. Starsign shows the
   Request URL (`${STARSIGN_PUBLIC_URL}/webhooks/slack?team=<team id>`).
5. **Event Subscriptions** → On → Request URL = that URL (Slack sends `url_verification`; it must show "Verified").
   **Subscribe to bot events**: `message.channels`, `message.groups`, `message.im`, `message.mpim`, `app_mention`.
   Save, and reinstall the app if Slack asks.
6. In each channel to watch: `/invite @<app name>`. To accept DMs, **App Home → Messages Tab** on.
- Redirect URI: none (not OAuth in Starsign; the app is installed from its own settings page).
- Webhook URL: `${STARSIGN_PUBLIC_URL}/webhooks/slack?team=<team id>`.
- Env vars: `STARSIGN_PUBLIC_URL` (to show the Request URL), optional `SLACK_API_BASE` (tests or a proxy).

## Review and access requirements
None for an internal app installed to its own workspace. Workspace admins may need to approve app installs (an
admin setting). Distributing the app to other workspaces (public distribution) would need OAuth and, for normal rate
limits on `conversations.history`, Slack Marketplace approval: not needed or used here.

## Limits and quotas
- Web API tiers: `conversations.history`, `conversations.list`, `users.info`: Tier 3 (≈50+ requests/minute) for
  internal apps; `chat.postMessage`: about 1 message per second per channel. 429 responses carry `Retry-After`.
- Since 2025, **non-Marketplace apps distributed to other workspaces** are limited to 1 `conversations.history`
  request per minute with at most 15 messages; **internal customer-built apps are exempt** (Slack's rate-limit
  FAQ). This connector assumes an internal app.
- Events API: respond within 3 seconds; Slack retries up to 3 times (`X-Slack-Retry-Num`) and may disable the
  subscription after sustained failures. More than 30,000 events per workspace per hour triggers `app_rate_limited`.
- `chat.postMessage` text is truncated after 40,000 characters (4,000 recommended). Up to 10 files per message.

## Unverified
- `// TODO(verify)` signing secrets are 32 hex characters (only a minimum length is enforced).
- `// TODO(verify)` the `upload_url` from `files.getUploadURLExternal` takes the raw bytes in a POST with no
  Authorization header (Slack documents raw or multipart). `files.completeUploadExternal` accepting `channel_id`,
  `initial_comment` and `thread_ts` comes from memory of the reference (docs.slack.dev was not reachable; search
  confirmed the two-step flow and the retirement of `files.upload`).
- Whether `shares` is present in the `files.completeUploadExternal` response or only later through `files.info`.
- Rate-limit numbers above (Tier 3 ≈ 50/min, 1 msg/s/channel, 30,000 events/hour) are from memory plus search
  summaries, not fetched pages.
- Enterprise Grid org-wide installs (team id vs enterprise id in `team_id`) were not considered.

## Questions for the owner
- **Core change for `url_verification`**: done (`WebhookHandler.respond`). The Request URL still needs `?team=`,
  because Slack's handshake body names no workspace.
- Should Starsign also poll thread replies (`conversations.replies`) for workspaces that cannot use events?
- Is posting as the app fine, or do you want a per-post username/icon (`chat:write.customize`)?
