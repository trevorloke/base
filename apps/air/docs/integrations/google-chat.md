# Google Chat

Connector `google_chat` · networks `["google_chat"]` · `packages/connectors/src/google-chat.ts` · factory
`createGoogleChatConnectors(env)`

Post-only through a space's **incoming webhook**: the simplest official route, with no Chat app, no OAuth and no
admin review. One Base Air account = one webhook (externalId = `spaces/<space id>`).

## What works
- **Connect** (`connectMethod: "webhook_url"`): input `webhookUrl` (secret). The URL must be
  `https://chat.googleapis.com/v1/spaces/<space>/messages?key=…&token=…`; other query parameters are dropped. A webhook
  has no read endpoint, and connecting must not post into the space, so **only the URL's shape is checked**: a wrong
  or revoked URL shows up on the first publish (as an `auth` error).
- **publish**: `POST <webhook URL>&messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD` with
  `{ text, thread: { threadKey }, cardsV2? }`.
  - text converted from markdown-lite to Chat formatting (`**bold**` → `*bold*`, `~~x~~` → `~x~`, `[text](url)` →
    `<url|text>`).
  - `options.link` adds a **cardsV2** card: header (title = `options.title` or the host, subtitle = host), an image
    widget when `options.thumbnailUrl` is set, and an "Open" button with `openLink`.
  - every post gets a `threadKey` derived from the idempotency key. Thread segments are posted as replies in the
    root's thread (by `thread.name` from the response). A publish with `replyToExternalId` = a message posted by this
    process (since the last restart) or a `spaces/…/threads/…` name replies in that thread.
  - externalId = the message `name` (`spaces/…/messages/…`); `url` null; `raw` = the Message. Idempotent per key
    in-process.
- **validate**: no media (webhooks cannot upload files; link instead), not empty, each message ≤ ~30,000 bytes.
- No inbox, reply-to-people, moderation or metrics: `fetchActivity` / `fetchMetrics` return `[]`.
- **Errors**: 429 `RESOURCE_EXHAUSTED` → `rate_limit` (retryable); 401/403/404 → `auth` (webhook removed or URL
  changed); 400 → `rejected`; 5xx and transport errors → retryable `network`. The key and token (raw or URL-encoded)
  are scrubbed from error messages.

## What Base Air can and cannot see
- **Can see**: nothing. The webhook only posts.
- **Cannot see**: any message in the space, replies to Base Air's posts, members, reactions. Reading spaces needs a
  Google Chat app using the Chat API with Google Workspace admin approval (a later step).

## Setup
1. In Google Chat, open the space → space name → **Apps & integrations** → **Webhooks** → **Add webhook**
   (name "Base Air", optional avatar URL) → copy the URL. Workspace admins can disable webhooks for the domain.
2. In Base Air, connect Google Chat with that URL.
- Redirect URI: none. Webhook URL (inbound to Base Air): none.
- Env vars: none.

## Review and access requirements
None for incoming webhooks. They are available in Google Workspace spaces (not in personal Gmail accounts' 1:1
chats) unless the admin turned them off. Reading messages later needs a Chat app (Google Cloud project, Chat API
enabled, app configuration) and, for user-data scopes, Workspace admin approval or Google's OAuth verification.

## Limits and quotas
- Messages up to 32,000 bytes including text and cards.
- Chat applies per-space write quotas; bursts of parallel webhook posts get HTTP 429 `RESOURCE_EXHAUSTED`. Plan on
  about one message per second per space.
- No files through webhooks.

## Unverified
- `// TODO(verify)` Google Chat now renders some Markdown natively; the classic `*bold*` / `<url|text>` syntax is
  what the connector sends.
- That incoming webhooks accept `cardsV2` and a `thread.name` (not only `threadKey`) — believed true, not fetched.
- The per-space write quota number (about 1/second) is from memory; the official quota page was not reachable.
- The `threadKey` field is marked deprecated in the API reference in favor of `thread.threadKey`; the connector uses
  `thread.threadKey` in the body, which is the current form.

## Questions for the owner
- Do you want to set up a Chat app later (to read spaces and reply), and do you have a Workspace admin who can
  approve it?
- Should each publish start its own thread (current behaviour) or should all Base Air posts go into one thread?
