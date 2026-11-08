# Chat connector addendum (read after BRIEF.md)

These connectors bring **conversations** into Base Air's live feed: group chats, server channels and messages sent to a
business account. Monitoring is the main job; replying is second; publishing only where the platform has a real
broadcast surface. Everything goes through the platform's **official** API. Never automate a personal account, never
scrape a web client, never use unofficial libraries (whatsapp-web.js, Baileys, itchat, wechaty puppets, self-bots):
they break the platforms' terms and get numbers and accounts banned.

## Contract pieces made for chat (already in the repo)
- `ActivityKind` `"message"`: a message in a group, channel or server channel. Use `"dm"` for a 1:1 message to the
  business, `"mention"` when the message mentions the bot/business, `"reply"` when it replies to one of the business's
  messages, `"follow"` for joins/subscribes where that is the only signal.
- `ActivityInput.conversation?: { id, name?, type: "group" | "channel" | "direct" }`: always set it for chat items.
- `ActivityInput.lang?`: set only when the platform tells you the language. Base Air detects it otherwise.
- External ids must be unique per network and let `reply`/`moderate` find the message again: use
  `"<conversation id>:<message id>"` where the message id alone is not globally unique.
- `WebhookHandler` (packages/connectors/src/types.ts):
  - `verify(headers, rawBody, query)` for one app-wide secret (WhatsApp: the Meta app secret).
  - `decode(rawBody, query)` when the body is not JSON (WeChat XML). `ack` when the platform needs a specific
    response body (WeChat: the plain text `success`).
  - **Per-account secrets** (LINE channel secret, a WeChat Official Account's token/EncodingAESKey): implement
    `route(rawBody, query, headers)` → `{ network, accountExternalId }` read from the unverified delivery (or from the
    webhook URL's query, e.g. `/webhooks/wechat?account=<id>`), plus `verifyAccount(account, headers, rawBody, query)`,
    optionally `decodeAccount(account, rawBody, query)` and `challengeAccount(account, query)`. Core loads that
    account's decrypted auth, verifies, decodes, and ingests only into accounts that verified.
  See `packages/core/test/webhook-routing.test.ts` for a working example.
- Accounts connect with typed credentials: `connectMethod: "bot_token"` or `"api_key"`, `credentialInputs`
  (key, label, placeholder, secret?) and `connectWithInputs(inputs)` returning `ConnectedAccount[]`. Look at how
  `telegram.ts` and `discord.ts` do it (and `bluesky.ts` `credentialInputs`).
- Polling connectors keep a per-conversation cursor; `fetchActivity(account, since)` must not return duplicates in a
  way that floods (core dedupes on (network, externalId) anyway).

## Privacy
Only conversations the business's bot/number is a member of, or that people sent to the business. Do not store phone
numbers in `authorHandle` in clear when the platform gives a stable opaque id instead; when only a phone number
exists (WhatsApp), keep it (it is how the business replies) but never put it in `authorName`.

## Your doc
`docs/integrations/<network>.md` also needs a short "What Base Air can and cannot see" section in plain words.
