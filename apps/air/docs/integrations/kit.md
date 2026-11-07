# Kit (formerly ConvertKit)

Connector `kit` · networks `["kit"]` · `packages/connectors/src/kit.ts` · factory `createKitConnectors(env)` · shared text→HTML helper `packages/connectors/src/html.ts`

## What works
- **Connect** (`connectMethod: "api_key"`): input `apiKey` (secret, a **v4** API key). Every request sends `X-Kit-Api-Key` to `https://api.kit.com/v4`. `connectWithInputs` calls `GET /v4/account`; externalId = account id, handle = account name (else primary email), displayName = account name. Auth blob `{ apiKey }`; config `{ accountId, plan }`.
- **Publish** = a broadcast sent now: `POST /v4/broadcasts { subject, content, public, published_at, send_at, thumbnail_url, thumbnail_alt }`.
  - `subject` = `options.title`, else the post's first line (plain text). Required.
  - `content` = the post text rendered to safe HTML, `options.link` appended when missing, images by their public Starsign media URLs. Kit wraps it in the account's default email template.
  - `public` = true when `options.visibility` is unset or `public` (the broadcast also appears on the creator's web newsletter feed, with `published_at` = now); `unlisted`/`private`/`direct` keep it email-only.
  - `send_at` = now (Starsign already scheduled it). No `subscriber_filter`, so it goes to all subscribers.
  - `thumbnail_url` = `options.thumbnailUrl` or the first image.
  - Returns `externalId` = broadcast id, `url` = `public_url` (null for email-only broadcasts). Idempotent in-process.
- **validate**: subject present; no video/document attachments; no polls.
- **Metrics**: `fetchMetrics` reads `GET /v4/broadcasts/<id>/stats` → `broadcast.stats`: `reach` = `recipients`, `impressions` = `emails_opened` (else `recipients × open_rate / 100`), `clicks` = `total_clicks`, `link_clicks` = `recipients × click_rate / 100` (unique clickers). 404 and 400 (outside Kit's 60-month stats window) are skipped. `fetchAccountMetrics`: `followers_total` = `pagination.total_count` of `GET /v4/subscribers?per_page=1&include_total_count=true&status=active`.
- **Inbox**: none (`fetchActivity` returns `[]`).
- **Errors**: Kit's `{ errors: [...] }` strings go into the message. 401/403 → auth; 404/422 → rejected; 429 → rate_limit with `Retry-After`; 5xx/transport → retryable. Messages never contain the key.

## Setup
1. Kit → **Settings → Developer → API keys → Add a new key** (v4). v3 API keys/secrets do not work.
2. Check the default email template and sender (Settings → Email) — broadcasts use them.
3. In Starsign, connect Kit with the key.
- Redirect URI: none today. Kit OAuth (apps in the Kit App Store, `https://app.kit.com/oauth/authorize`) is a **later step**; redirect URI would be `${STARSIGN_PUBLIC_URL}/oauth/kit/callback`.
- Webhook URL: none (Kit webhooks cover subscriber events, not needed yet).
- Env vars: optional `KIT_API_BASE` (default `https://api.kit.com/v4`).

## Review and access requirements
None for API keys; they work immediately on any plan with API access. Sending broadcasts requires a confirmed sender address and an account that has passed Kit's sending review (new accounts can be held for review before their first broadcast). OAuth apps listed in the App Store go through Kit's app review.

## Limits and quotas
- API keys: about 120 requests per rolling 60 seconds (OAuth tokens higher); 429 is handled as retryable.
- Email stats are kept for 60 months; older broadcasts return 400 from the stats endpoint.
- Sends count against the plan's subscriber limit (Newsletter/free plans have caps).

## Unverified
- `send_at` = the current time sends immediately (not refused as "in the past"), and omitting `subscriber_filter` targets all subscribers.
- `public_url` is filled in the create response for public broadcasts.
- The single-broadcast stats endpoint returns `emails_opened` and `total_clicks` (`total_clicks` may only be on the list-stats endpoint), and `open_rate`/`click_rate` are percentages (0–100).
- `include_total_count=true` on `GET /v4/subscribers` returns `pagination.total_count`.
- The rate limit figure (120 requests / 60 s for API keys).
- `developers.kit.com` was not reachable from the sandbox; the endpoints, the `X-Kit-Api-Key` header and the stats fields `recipients`, `open_rate`, `emails_opened`, `click_rate` were confirmed from search results of the official reference.

## Questions for the owner
- Should broadcasts be public (on the creator profile) by default, or email-only unless asked?
- Should Starsign target a segment or tag (`subscriber_filter`) instead of all subscribers?
- Which email template should broadcasts use (`email_template_id`), if not the account default?
