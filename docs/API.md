# Starsign HTTP API v1 (contract)

Base URL in dev: `http://localhost:4000`. All bodies and responses are JSON. Times are ISO-8601 strings.

## Authentication

`Authorization: Bearer star_...` — an API key minted per workspace. The key carries the actor it acts as:
a human user with a role (`owner | approver | editor | viewer`), or an agent (`mcp` / `operator` actor types) governed by
the workspace's autonomy dial. Every write is attributed to that actor in the ledger.

Dev convenience: when the server runs with `STARSIGN_DEV_WORKSPACE=<slug>` and a request has no bearer, it acts as the
human owner `dev` of that workspace. Never set in production.

Errors: `{ "error": { "code": "not_found|forbidden|invalid|conflict|policy_blocked|unavailable|unauthorized", "message": "...", "details": ... } }`
with statuses 404 / 403 / 400 / 409 / 422 / 503 / 401.

## Health
- `GET /api/health` → `{ ok: true, version: "0.1.0", db: "pglite" | "postgres" }` (no auth)

## Identity & workspace
- `GET /v1/me` → `{ workspace: Workspace, actor: { type, id }, role: string | null }`
- `GET /v1/workspace` → `Workspace` = `{ id, slug, name, profile: object, settings: object, createdAt }`
- `PATCH /v1/workspace/profile` body `{ profile: object }` → `Workspace`
  - `profile` holds brand context: `{ description, audience, topics: string[], voice: { do: string[], dont: string[], examples: string[] }, competitors: string[] }` (free-form, these keys are conventional)

## Social accounts
- `GET /v1/accounts` → `Account[]` = `{ id, network, externalId, handle, displayName, connector, status: "active|reauth_required|disabled", hasCredentials, lastIngestAt, config }[]`
- `POST /v1/accounts` body `{ network, externalId, handle, displayName?, connector, auth?: object, config?: object }` → `Account` (owner/approver)
- `DELETE /v1/accounts/:id` → `204`

## Policy (red lines, autonomy)
- `GET /v1/policy` → `Policy` (see `@starsign/schema` `Policy`)
- `PUT /v1/policy` body `Policy` without `version` → new `Policy` (owner only; version increments)
- `GET /v1/policy/history` → `{ version, document, active, createdBy, createdAt }[]`
- `POST /v1/policy/check` body `{ variants: { network, text }[], scheduledAt?, actionClass?, disclosure? }` → `PolicyDecision` dry run, nothing stored.
  `PolicyDecision = { verdict: "allow|require_approval|block", violations: { redLineId, kind, severity, message, matches }[], autonomy?, policyVersion }`

## Posts
`PostDetail = { post: Post, variants: Variant[], approvals: Approval[] }`
- `Post`: `{ id, workspaceId, status, title, body, media, scheduledAt, publishedAt, actionClass, createdBy: {type,id}, trendTopicId, trendStageAtCreation, trendForecastId, experimentId, experimentArm, disclosure, evidence, policyDecision, createdAt, updatedAt }`
- `status ∈ draft | pending_approval | approved | scheduled | publishing | published | partially_published | failed | cancelled | blocked`
- `Variant`: `{ id, postId, socialAccountId, network, text, media, thread: string[], status, externalId, externalUrl, publishedAt, error, attemptCount }`
- `Approval`: `{ id, postId, state: "requested|approved|rejected|changes_requested", requestedBy, decidedBy, decidedAt, note, createdAt }`

- `GET /v1/posts?status=scheduled,published&limit=50` → `{ post, variants }[]` newest first
- `GET /v1/posts/queue` → `{ post, variants }[]` pending approval, oldest first
- `POST /v1/posts` body `CreatePostInput` → `201 PostDetail`. The gate decides the status. A red-line **block** still returns 201 with `post.status = "blocked"` and `post.policyDecision.violations` populated. A refused action (autonomy says the actor may not create) returns 403.
  `CreatePostInput = { title?, body, media?: Media[], variants: { socialAccountId, text, media?, thread?: string[] }[], scheduledAt?, actionClass?: "new_post|reply|dm|repost|campaign", trendTopicId?, trendStageAtCreation?, trendForecastId?, experimentId?, experimentArm?, disclosure?: { aiAssisted, aiContributions?: string[], humanReviewed, reviewedBy?, model?, promptVersion? }, evidence?: { kind, ref, note? }[], flags?: { paid? } }`
- `GET /v1/posts/:id` → `PostDetail & { history: LedgerEvent[] }`
- `POST /v1/posts/:id/schedule` body `{ at }` → `PostDetail`
- `POST /v1/posts/:id/publish-now` → `PostDetail`
- `POST /v1/posts/:id/cancel` → `PostDetail`
- `PATCH /v1/posts/:id/variants` body `{ edits: { [variantId]: text } }` → `PostDetail` (drafts only)
- `POST /v1/posts/:id/decide` body `{ decision: "approve|reject|request_changes", note?, edits?: { [variantId]: text } }` → `PostDetail` (human owner/approver only; edits are recorded as diffs; approving re-runs red lines → 422 `policy_blocked` if the edit crosses one)

## Live feed (listening)
`Activity = { id, workspaceId, socialAccountId, network, kind, externalId, authorHandle, authorName, text, url, parentExternalId, occurredAt, ingestedAt, sentiment, matchedStreams: string[], rawEventId }`
`kind ∈ own_post | reply | mention | comment | dm | repost | quote | like | follow`
- `GET /v1/feed?stream=<id>&networks=x,bluesky&kinds=mention,reply&account=<id>&since=<iso>&before=<iso>&limit=100&q=<text>` → `Activity[]` newest first
- `GET /v1/feed/counts?since=<iso>` → `{ network, kind, n }[]`
- `GET /v1/feed/stream` → **SSE**. Events: `activity` `{ workspaceId, id, network, kind, matchedStreams }`, `post` `{ workspaceId, postId, status }`, `alert` `{ workspaceId, id, title, severity }`, `forecast` `{ topicId, stage, confidence }`. A `: ping` comment every 25s.
- `GET /v1/streams` → `Stream[]` = `{ id, name, query: { keywords, authors, networks, kinds }, createdAt }`
- `POST /v1/streams` body `{ name, query }` → `Stream`
- `DELETE /v1/streams/:id` → 204
- `POST /v1/ingest/:accountId` → `{ ingested, duplicates }` (pull now)
- `POST /v1/ingest/items` body `{ accountId: string | null, items: ActivityInput[] }` → `{ ingested, duplicates }` (import). `ActivityInput = Activity fields minus ids + { raw }`

## Measurement
- `GET /v1/metrics/summary?from=<iso>&to=<iso>` → `Summary`:
  `{ window, publishedByNetwork: {network, posts}[], measuredAt24h, totals: {impressions, engagements}, baselineEngagements24h, byNetwork: Group[], byHour: Group[], byTrendStage: Group[], byAuthor: Group[], byExperiment: Group[], top: { postId, variantId, network, text, impressions, engagements, lift }[] }`
  `Group = { key, posts, impressions, engagements, avgEngagements }`
- `GET /v1/metrics/lift-by-stage?from&to` → `{ stage, posts, avgEngagements, lift }[]`
- `GET /v1/metrics/series?entityType=post_variant&entityId=<externalId>&metric=impressions&from&to` → `{ value, observedAt, source }[]`
- `GET /v1/metrics/variant/:variantId` → `{ latest: { [metric]: number }, outcomes: { offsetLabel, dueAt, capturedAt, status, metrics }[] }`

## Trends (the radar)
- `GET /v1/trends/radar` → `RadarEntry[]` sorted by score desc:
  `{ topic: { id, workspaceId, name, keywords, relevance }, forecast: { id, stage, confidence, velocity, hoursToPeak, computedAt, sources, sourceAgreement, curve: { at, value, lo, hi }[] } | null, actedOn: number, score, window: string | null }`
- `GET /v1/trends/topics` → `Topic[]`
- `POST /v1/trends/topics` body `{ name, keywords: string[], relevance?, global?: boolean }` → `Topic`
- `PATCH /v1/trends/topics/:id` body `{ relevance }` → 204
- `GET /v1/trends/topics/:id` → `{ topic, forecast, series: { source, points: { t, v }[] }[], actions: { postId, stageAtAction, forecastId, createdAt, outcome24h: object | null }[] }`
- `POST /v1/trends/topics/:id/forecast` → recomputed forecast
- `POST /v1/trends/points` body `{ points: { topicId, source, value, observedAt, region? }[] }` → `{ recorded }`

## Operators' output
- `GET /v1/alerts?unacknowledged=1&limit=50` → `Alert[]` = `{ id, kind, severity: "info|attention|urgent", title, body, evidence, topicId, acknowledgedAt, createdAt }`
- `POST /v1/alerts/:id/ack` → 204
- `GET /v1/briefs?limit=12` → `Brief[]` = `{ id, periodStart, periodEnd, contentMd, evidence, runId, createdAt }`
- `GET /v1/briefs/latest` → `Brief | null`
- `GET /v1/runs?limit=50` → `OperatorRun[]` = `{ id, operator, startedAt, finishedAt, status, summary, inputTokens, outputTokens, costUsd, error }`

## Ledger & export
- `GET /v1/ledger?types=post.created,post.published&subjectType=post&subjectId=<id>&afterSeq=<n>&limit=100` → `LedgerEvent[]` newest first
  `LedgerEvent = { id, seq, workspaceId, type, subjectType, subjectId, actor: {type,id}, data, occurredAt }`
- `GET /v1/export` → the whole workspace as one JSON document (`Content-Disposition: attachment`)

## Brand context (for agents)
- `GET /v1/context` → `{ workspace: { name, profile }, policy: { autonomy, redLines: { id, kind, description, severity }[], timezone }, accounts: Account[], recentTop: Summary.top, voiceExamples: { before, after }[] (last 20 approval diffs), activeTopics: RadarEntry[] (top 10) }`
