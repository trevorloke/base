# Nostr

Connector `nostr` · networks `["nostr"]` · `packages/connectors/src/nostr.ts` (+ `nostr-crypto.ts`) · factory `createNostrConnectors(env)`

## What works
- **Connect (typed credentials, `connectMethod: "api_key"`)**: the person pastes their secret key (`nsec1…` or 64 hex characters, `secret: true`) and, optionally, a comma-separated list of `wss://` relays (`optional: true`; default `wss://relay.damus.io, wss://nos.lol, wss://relay.primal.net`). The public key is derived locally; identity: externalId = public key (hex), handle = `npub1…`, display name from the newest kind-0 profile found on the relays (best effort, `null` when none answer). Auth blob `{ secretKey, pubkey }` (hex); config `{ relays, npub }`. `connectConfigured` is always true: no OAuth, no app approval, no deployment secret.
- **Crypto without dependencies** (`nostr-crypto.ts`): secp256k1 in Jacobian coordinates over BigInt, BIP-340 Schnorr sign/verify with tagged SHA-256 hashes (checked against all 19 official BIP-340 test vectors during development; a representative set is in the test), bech32 (BIP-173) and NIP-19 `npub`/`nsec`/`note`/`nevent` encode/decode, NIP-01 serialization (exact escaping rules) and event id, `finalizeEvent`, `verifyEvent`.
- **Publish**: kind-1 text notes. Media is pull-style: base air's public media URLs are appended to the content and described with NIP-92 `imeta` tags (`url`, `m`, `dim`, `alt`). `options.contentWarning` → NIP-36 `content-warning` tag; `options.tags` → `t` tags. Threads are NIP-10 replies (`["e", root, relay, "root", pubkey]`, then root + `reply` markers). `replyToExternalId` (hex, `note1` or `nevent1`) fetches the parent so the reply carries its root and every participant as `p` tags.
- **Relays**: each event is sent as `["EVENT", ev]` to every configured relay over WebSocket (Node 22 global `WebSocket`; a factory is injectable). The connector waits for `["OK", id, true|false, msg]` with a timeout (8 s). Success = at least one relay accepted (a `duplicate:` OK counts). The per-relay results go in `raw.relays`. If every relay fails: any `rate-limited:` → `rate_limit` (retryable); any timeout, connection failure or `error:` → `network` (retryable); all `auth-required:` → `auth`; otherwise (`blocked:`, `invalid:`, `pow:`, `restricted:`) → `rejected`.
- **Idempotency**: in-process cache by key. The signed events of a thread are kept per key, so a retry resends the *same* event (same id; relays answer `duplicate:`) instead of a new one, and a part-posted thread resumes and reports `partial`.
- **Inbox**: `fetchActivity` opens one REQ with two filters: kind 1/6/7 events tagging the account (`#p`) and kind 1/6/7 events referencing its 50 most recent notes (`#e`), `since` the last poll, and closes the subscription on EOSE or after 8 s. Events are deduplicated across relays, and any event whose id hash or Schnorr signature does not check out is dropped. Mapping: a reply to one of our notes → `reply`; a note tagging us → `mention`; a reply to someone else inside our thread → `comment`; kind 7 → `like` (the emoji in `text` when it is not `+`; `-` downvotes are ignored); kind 6 → `repost`. externalId = event id (hex), authorHandle = `npub`, authorName from kind-0 profiles fetched in one batch, url = `https://njump.me/<nevent>`.
- **reply**: a kind-1 reply with NIP-10 tags (fetches the parent for root and participants).
- **moderate**: `like` = kind-7 `+` reaction (NIP-25, with `e`, `p`, `k` tags); `unlike` = kind-5 deletion of our reactions to that note; `delete` = kind-5 deletion (NIP-09) of our own event (refused when the event on the relays belongs to someone else). `hide`/`unhide` are refused.
- **Metrics**: replies, likes (kind 7 except `-`), reposts and engagements counted from what the configured relays hold. This is a lower bound: Nostr has no global counter, and other people's interactions may sit on relays we do not read. No impressions exist.
- **Account metrics: none.** Followers are kind-3 contact lists published by *other* people to *their* relays. Counting them needs a network-wide index; a count from a few relays would be an arbitrary undercount, so `accountMetrics` is false.
- `refreshAuth` returns `null` (keys do not expire). No webhooks (relays push over the open subscription only while connected; base air polls).

## Setup
- Nothing to register. The person needs a Nostr key pair (any client can create one, e.g. Primal, Damus, Amethyst, or a signer like Alby/nos2x) and pastes the `nsec`.
- Redirect URI: none (no OAuth). Webhook URL: none.
- Env vars: optional `NOSTR_DEFAULT_RELAYS` (comma-separated `wss://` URLs) to replace the default relay set for accounts that give none.
- Relays must be `wss://` public hosts (loopback, private ranges and IP literals are refused, since relays are dialed from the server).

## Review and access requirements
None. Nostr has no platform owner, no API keys and no review. Individual relays decide what they accept: some are paid or allow-listed (they answer `blocked:` or `restricted:`), some require NIP-42 AUTH for writes (answered `auth-required:`; not implemented).

## Limits and quotas
- No protocol-wide limits. Each relay sets its own maximum event size, maximum tags, rate limits and accepted kinds (published in its NIP-11 document). Popular free relays rate-limit bursts; a thread of many notes may hit `rate-limited:`.
- base air's generic limits for `nostr`: 10,000 characters, 4 media URLs, threads supported.
- Timeouts: connect 5 s, OK 8 s, REQ 8 s (constructor options).

## What base air can and cannot see
- **Can see**: public notes, reactions and reposts that tag the account or reference its recent notes, *on the relays the account lists*. Profile names (kind 0) of the people who interacted.
- **Cannot see**: anything on relays the account does not list, encrypted direct messages (NIP-04/NIP-17 are not read), follower counts, impressions or reach. Deletions are requests: relays may keep a note after a kind-5 deletion, and other clients may have copied it.
- **Holds**: the account's secret key (encrypted in the auth blob). Anyone with it can post as the account forever; there is no way to revoke a Nostr key, only to abandon it.

## Unverified
- `TODO(verify)`: the default relay set (`relay.damus.io`, `nos.lol`, `relay.primal.net`) is chosen from long-running free relays; availability and write policies as of November 2026 were not checked live.
- `TODO(verify)`: relays that require NIP-42 AUTH for writes answer `auth-required:`; the connector does not answer AUTH challenges, so such relays count as refusals.
- NIP-01, NIP-09, NIP-10, NIP-19, NIP-25 and NIP-92 were read from the nostr-protocol/nips repository during development; BIP-340 vectors from bitcoin/bips. Relay behavior was not tested against live relays (the sandbox has no network access to them): tests use a fake WebSocket relay.
- Events whose content contains control characters other than the seven NIP-01 escapes are hashed by most clients with `JSON.stringify`; `verifyEvent` accepts either serialization, base air signs with the exact NIP-01 one.

## Questions for the owner
- Are you comfortable storing a raw `nsec`? A NIP-46 remote signer ("bunker") would keep the key out of base air; it needs a long-lived relay connection and is a bigger build.
- Which relays should the default set be for your audience (e.g. regional or paid relays)?
- Should base air also publish a NIP-65 relay list (kind 10002) for the account so other clients find its notes?
- Do you want media uploaded to a Blossom/NIP-96 server instead of linking base air's media URLs?
