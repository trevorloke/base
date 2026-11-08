# Connector builder brief (shared by every platform builder)

base air is a social media command center (publishing, inbox, analytics, trend radar, agents inside red lines).
Repo: apps/air (base suite), pnpm TypeScript monorepo, ESM, strict, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`.
Relative imports include `.ts`. zod v4. Node 22 `fetch`. Never run `pnpm install` (no new dependencies) or `git`.

## Read first
- `packages/connectors/src/types.ts` — the Connector contract (publish, reply, moderate, fetchActivity, fetchMetrics,
  fetchAccountMetrics, refreshAuth, webhook, oauthAuthorizeUrl/oauthConnect/oauthPrepare/oauthInputs, describeAccount,
  validate, capabilities, `media` fetcher), `ConnectorError` kinds (auth | rate_limit | rejected | network | unknown) with `retryable`.
- `packages/connectors/src/oauth.ts` — `OAuth2Client` and `clientFromEnv`. Use it; do not hand-roll token exchange.
- `packages/connectors/src/x.ts` and `bluesky.ts` — reference adapters (error mapping, idempotency cache, thread progress).
- `packages/connectors/src/http.ts`, `idempotency.ts`, `validate.ts`.
- `packages/schema/src/networks.ts` (Network enum, NETWORK_LIMITS, `VariantOptions`: kind, title, link, privacy, boardId,
  subreddit, flairId, firstComment, tags, thumbnailUrl, contentWarning, brandedContent, callToAction, allow*, visibility, poll),
  `packages/schema/src/common.ts` (Media: kind, url, mime, bytes, width, height, durationSeconds, assetId, alt),
  `packages/schema/src/listening.ts` (ActivityInput), `measurement.ts` (MetricName canonical names).
- `packages/core/test/framework.test.ts` shows a connector using every optional capability.

## What "done" means for each network you own
1. **Connect**: OAuth via `OAuth2Client` (or the network's real method). `oauthConnect` returns EVERY account the login can
   manage (e.g. all Facebook Pages + linked Instagram accounts; LinkedIn member + organizations the member administers).
   `connectConfigured` false when the client id/secret env is missing. `describeAccount` works from an auth blob.
   Auth blobs include refresh tokens and expiry; `refreshAuth` renews them (long-lived token exchanges where the network
   uses those instead of refresh tokens).
2. **Publish** every post kind the network supports through its official API: text, link, single image, multi-image/carousel,
   video (and reels/shorts/stories where offered), threads/first comment where offered, the relevant `VariantOptions`.
   Pull-style networks get `media.url` (public URLs from base air's media library); upload-style networks read bytes with
   `this.media.fetch(media)` (set by core; fall back to fetching `media.url` if unset). Use resumable/chunked upload where
   the network requires it for large files. Poll asynchronous processing (containers, upload status) with bounded waits and
   return a clear retryable error if processing is still running. Idempotency: `IdempotencyCache` like x.ts.
3. **Inbox**: `fetchActivity(account, since)` returns comments, mentions, replies, DMs where the API allows, as ActivityInput
   with `raw` set. `reply` answers a post or comment. `moderate` hides/unhides/deletes/likes where allowed.
4. **Measure**: `fetchMetrics` maps per-post insights to canonical metric names (impressions, reach, likes, replies, reposts,
   saves, shares, video_views, watch_time_seconds, link_clicks, profile_visits, engagements). `fetchAccountMetrics` returns
   followers_total and any account reach the API offers.
5. **Webhooks** where the network pushes events: `webhook.challenge`, constant-time `webhook.verify`, `webhook.parse`.
6. **Validate**: network-specific pre-flight (aspect ratios, durations, required media, title required, etc.) as ValidationIssues.
7. Capabilities declare honestly what works (`reply`, `moderate`, `accountMetrics`, `webhooks`, `video`, `kinds`).
8. Map HTTP errors to ConnectorError kinds; 429 → rate_limit retryable with reset info; 5xx/network → retryable.

## Research
Use WebSearch (and WebFetch where it works) to confirm CURRENT endpoint paths, API versions, scopes, request/response shapes,
rate limits and review requirements as of November 2026. The sandbox cannot reach the platforms, so tests must mock `fetch`.
Anything you could not confirm from a current source: implement your best understanding, mark it `// TODO(verify): <what>`
in code, and list it under "Unverified" in your doc. Never invent certainty.

## Deliverables (only these files; do NOT edit factory.ts, index.ts, types.ts or any other package)
- `packages/connectors/src/<network>.ts` (one or more files you own) exporting a factory
  `export function create<Name>Connectors(env: NodeJS.ProcessEnv): Connector[]`.
- `packages/connectors/test/<network>.test.ts` — network-free tests covering connect (incl. multi-account), every publish kind,
  async processing waits, reply, moderate, activity mapping, metrics mapping, refresh, webhook verify/parse, error mapping.
- `docs/integrations/<network>.md` with these sections: What works · Setup (developer app steps, exact scopes/permissions,
  redirect URI = `${BASE_AIR_PUBLIC_URL}/oauth/<connector name>/callback`, webhook URL = `${BASE_AIR_PUBLIC_URL}/webhooks/<connector name>`,
  env vars) · Review and access requirements (what the platform must approve, typical timeline, what happens before approval) ·
  Limits and quotas · Unverified (every TODO(verify)) · Questions for the owner (decisions or facts only the account owner can supply).
- Gates before finishing (from repo root): `pnpm vitest run packages/connectors` and `pnpm tsc -p tsconfig.json --noEmit` both pass.
  Other builders are editing other files concurrently; if typecheck fails only in files you do not own, note it and move on.

Reply with: files, connector names and env vars, what each network can do, what you verified vs left TODO(verify), test/typecheck results.
