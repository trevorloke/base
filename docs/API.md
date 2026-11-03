# Starsign HTTP API v1 (contract)

Base URL in dev: `http://localhost:4000`. All bodies and responses are JSON. Times are ISO-8601 strings.

## Authentication

`Authorization: Bearer star_...` — an API key minted per workspace. The key carries the actor it acts as:
a human user with a role (`owner | approver | editor | viewer`), or an agent (`mcp` / `operator` actor types) governed by
the workspace's autonomy dial. Every write is attributed to that actor in the ledger.

Dev convenience: when the server runs with `STARSIGN_DEV_WORKSPACE=<slug>` and a request has no bearer, it acts as the
human owner `dev` of that workspace. Never set in production.

Errors: `{ "error": { "code": "not_found|forbidden|invalid|conflict|policy_blocked|unavailable|unauthorized", "message": "...", "details": ... } }`
with statuses 404 / 403 / 400 / 409 / 422 / 503 / 401. A malformed JSON body is `400 invalid`. A `422 policy_blocked`
carries `details: { violations: Violation[] }`.

Role gates (`owner`, `approver`, `editor`) apply to humans only; agent keys (`mcp`, `operator`) never pass them.
Agents may create posts within the autonomy dial and may only schedule, edit or cancel posts they created.

## API keys
- `GET /v1/keys` → `{ id, name, actorType, actorId, role, lastUsedAt, revokedAt, createdAt }[]` (owner)
- `DELETE /v1/keys/:id` → 204, revokes the key immediately (owner; recorded in the ledger)

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
- `POST /v1/posts/:id/schedule` body `{ at }` (required ISO time; 400 when missing) → `PostDetail`
- `POST /v1/posts/:id/publish-now` → `PostDetail`
- `POST /v1/posts/:id/cancel` → `PostDetail`
- `PATCH /v1/posts/:id/variants` body `{ edits: { [variantId]: text } }` → `PostDetail` (drafts only)
- `POST /v1/posts/:id/decide` body `{ decision: "approve|reject|request_changes", note?, edits?: { [variantId]: text } }` → `PostDetail` (human owner/approver only; edits are recorded as diffs; approving re-runs red lines → 422 `policy_blocked` if the edit crosses one)

## Live feed (listening)
`Activity = { id, workspaceId, socialAccountId, network, kind, externalId, authorHandle, authorName, text, url, parentExternalId, occurredAt, ingestedAt, sentiment, matchedStreams: string[], rawEventId }`
`kind ∈ own_post | reply | mention | comment | dm | repost | quote | like | follow`
- `GET /v1/feed?stream=<id>&networks=x,bluesky&kinds=mention,reply&account=<id>&since=<iso>&before=<iso>&limit=100&q=<text>` → `Activity[]` newest first
- `GET /v1/feed/counts?since=<iso>` → `{ network, kind, n }[]`
- `POST /v1/feed/stream-token` → `{ token, expiresInSeconds: 60 }`. Single use. The API key itself is never accepted in a URL.
- `GET /v1/feed/stream?token=<stream token>` → **SSE**. Events: `activity` `{ workspaceId, id, network, kind, matchedStreams }`, `post` `{ workspaceId, postId, status }`, `alert` `{ workspaceId, id, title, severity }`, `forecast` `{ topicId, stage, confidence }`. A `: ping` comment every 25s.
- `GET /v1/streams` → `Stream[]` = `{ id, name, query: { keywords, authors, networks, kinds }, createdAt }`
- `POST /v1/streams` body `{ name, query }` → `Stream`
- `DELETE /v1/streams/:id` → 204
- `POST /v1/ingest/:accountId` → `{ ingested, duplicates }` (pull now)
- `POST /v1/ingest/items` body `{ accountId: string | null, items: ActivityInput[] }` → `{ ingested, duplicates }` (import; editor+, account must be the caller's). `ActivityInput = Activity fields minus ids + { raw }`

## Measurement
- `GET /v1/metrics/summary?from=<iso>&to=<iso>` → `Summary`:
  `{ window, publishedByNetwork: {network, posts}[], measuredAt24h, totals: {impressions, engagements}, baselineEngagements24h, byNetwork: Group[], byHour: Group[], byTrendStage: Group[], byAuthor: Group[], byExperiment: Group[], top: { postId, variantId, network, text, impressions, engagements, lift }[] }`
  `Group = { key, posts, impressions, engagements, avgEngagements }`
- `GET /v1/metrics/lift-by-stage?from&to` → `{ stage, posts, avgEngagements, lift }[]`
- `GET /v1/metrics/series?entityType=post_variant&entityId=<externalId>&metric=impressions&from&to` → `{ value, observedAt, source }[]`. The entity must belong to the caller's workspace (404 otherwise).
- `GET /v1/metrics/variant/:variantId` → `{ latest: { [metric]: number }, outcomes: { offsetLabel, dueAt, capturedAt, status, metrics }[] }`

## Trends (the radar)
- `GET /v1/trends/radar` → `RadarEntry[]` sorted by score desc:
  `{ topic: { id, workspaceId, name, keywords, relevance }, forecast: { id, stage, confidence, velocity, hoursToPeak, computedAt, sources, sourceAgreement, curve: { at, value, lo, hi }[] } | null, actedOn: number, score, window: string | null }`
- `GET /v1/trends/topics` → `Topic[]`
- `POST /v1/trends/topics` body `{ name, keywords: string[], relevance?, global?: boolean }` → `Topic`
- `PATCH /v1/trends/topics/:id` body `{ relevance }` → 204 (workspace-owned topics only; global topics are maintained by the system)
- `GET /v1/trends/topics/:id` → `{ topic, forecast, series: { source, points: { t, v }[] }[], actions: { postId, stageAtAction, forecastId, createdAt, outcome24h: object | null }[] }`
- `POST /v1/trends/topics/:id/forecast` → recomputed forecast
- `POST /v1/trends/points` body `{ points: { topicId, source, value, observedAt, region? }[] }` → `{ recorded }` (topics must belong to the caller's workspace)

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

## Compose, calendar, connect (v1.1)

- `POST /v1/accounts/connect/bluesky` body `{ identifier, appPassword, service? }` → `201 Account` (owner/approver).
  The server logs in with the app password, reads the account's DID and handle, stores the credentials encrypted.
  `400 invalid` with `details: { reason }` when the login fails.
- `GET /v1/connectors` → `{ name, networks: string[], configured: boolean, connect: "app_password" | "oauth" | "api_key" | "none" }[]`
  (which networks this deployment can connect, and how).
- `POST /v1/compose/adapt` body `{ body, networks: string[], topicId? }` → `{ variants: { network, text, thread: string[] }[], notes, usage: { costUsd, model } }`.
  Uses the model gateway with the brand context and red lines. `503 unavailable` when no model is configured.
- `GET /v1/calendar?from=<iso>&to=<iso>` → `{ post, variants }[]` ordered by time, where time = `publishedAt ?? scheduledAt`,
  statuses `pending_approval | approved | scheduled | publishing | published | partially_published | failed`.
  Default window: start of this week (Monday 00:00 workspace time) to +14 days.
- `GET /v1/sources` → `{ name, kind: "sample" | "trending" | "both", configured: boolean, lastRunAt: string | null, lastError: string | null, pointsLast24h: number }[]`
  (the trend sources this deployment pulls from).
- `GET /v1/trends/discoveries?limit=50` → `{ term, source, value: number | null, url: string | null, observedAt, region }[]`
  newest first: raw "trending now" terms the scout saw, before they become topics.
- `POST /v1/accounts/connect/x/start` → `{ authorizeUrl, expiresAt }` (owner/approver). Send the person's browser to
  `authorizeUrl`. X returns them to `GET /oauth/x/callback`, which connects the account and redirects to
  `/?connected=x&handle=<handle>` or `/?connect_error=<reason>` (`expired`, `exchange_failed`, `access_denied`, …).
  Needs `X_CLIENT_ID` (and `X_CLIENT_SECRET` for confidential clients) and `STARSIGN_PUBLIC_URL`; otherwise `503`.
  `GET /v1/connectors` reports `configured: false` for X until those exist.

## Experiments (v1.1)
Any post can be an arm: create the experiment, then create posts with `experimentId` + `experimentArm`.
- `POST /v1/experiments` body `{ name, hypothesis, arms: { key, description }[] (2-6, keys a-z0-9_-), primaryMetric?: "engagements" | "impressions" | "likes" | "replies" | "reposts" | "link_clicks" | "conversions", offset?: "24h" | "72h" | "7d" }` → `201 Experiment`
- `GET /v1/experiments` → `Experiment[]` = `{ id, name, hypothesis, status: "running" | "concluded", arms, primaryMetric: "<metric>@<offset>", result, createdAt }`
- `GET /v1/experiments/:id` → `{ experiment, readout }`, `readout = { metric, offset, arms: { key, description, posts, measured, mean }[], comparisons: { arm, versus, lift, lo, hi, probabilityBetter }[], verdict: "not_enough_data" | "no_clear_winner" | "winner", winner, summary, minPerArm }`.
  Lift is the ratio of means at the offset with an 80% bootstrap interval; a winner is named only when every interval clears 1.
  A post's value is the sum over its variants. Concluded experiments return the frozen readout.
- `POST /v1/experiments/:id/conclude` → `Experiment` (a person, editor or above; freezes the readout, records it in the ledger)
- Creating a post with an `experimentId` from another workspace, a stopped experiment, or an unknown arm is refused.

## People, sign-in, teams (v1.2)
Two ways to authenticate every `/v1` route: `Authorization: Bearer star_...` (API keys, unchanged) or the `starsign_session`
cookie (HttpOnly, SameSite=Lax, Secure when STARSIGN_PUBLIC_URL is https). Cookie-authenticated requests that change state
(POST/PUT/PATCH/DELETE) must send `x-starsign-csrf: 1` or get `403 forbidden`. A session acts as the signed-in user in their
current workspace with their member role.
- `POST /v1/auth/signup` `{ email, password (>= 10 chars), name, workspaceName }` → `201 { user, workspaces, currentWorkspaceId }` + cookie.
  Allowed when no user exists yet (first owner) or `STARSIGN_ALLOW_SIGNUP=1`; otherwise `403`.
- `POST /v1/auth/login` `{ email, password }` → `{ user, workspaces, currentWorkspaceId }` + cookie. `401 unauthorized` on bad credentials
  (same message for unknown email and wrong password). Repeated failures → `429` for 15 minutes per email.
- `POST /v1/auth/logout` → 204, clears the cookie and revokes the session.
- `GET /v1/auth/session` → `{ user: { id, email, name }, workspaces: { id, slug, name, role }[], currentWorkspaceId }` or 401.
- `POST /v1/auth/switch` `{ workspaceId }` → same shape; must be a member.
- `POST /v1/auth/forgot` `{ email }` → 204 always (sends a reset link when email is configured: RESEND_API_KEY + MAIL_FROM).
- `POST /v1/auth/reset` `{ token, password }` → 204.
- `POST /v1/workspaces` `{ name, slug?, timezone? }` → `201 Workspace` (any signed-in user; creator is owner). For agencies adding a client.
- `GET /v1/members` → `{ id, userId, email, name, role, createdAt }[]`
- `POST /v1/invites` `{ email, role }` (owner) → `201 { inviteUrl, expiresAt }` (also emailed when configured). Invite links: `${STARSIGN_PUBLIC_URL}/?invite=<token>`.
- `GET /v1/invites/:token` → `{ workspaceName, email, role, expiresAt }` (no auth) or 404.
- `POST /v1/auth/accept-invite` `{ token, name?, password? }` → `{ user, workspaces, currentWorkspaceId }` + cookie (creates the user when new).
- `PATCH /v1/members/:id` `{ role }` (owner; cannot demote the last owner) → member. `DELETE /v1/members/:id` (owner; not the last owner) → 204.

## Integrations (v1.2)
- `GET /v1/connectors` → `{ name, networks, configured, connect: "oauth"|"app_password"|"api_key"|"webhook_url"|"bot_token"|"none", inputs: { key, label, placeholder? }[], capabilities: { [network]: { publish, reply, moderate, accountMetrics, webhooks, video, kinds: string[] } } }[]`
- `POST /v1/accounts/connect/:connector/start` `{ network?, inputs? }` → `{ authorizeUrl, expiresAt }`. Callback: `/oauth/:connector/callback`
  → redirects to `/?connected=<connector>&handle=<h1,h2>&count=<n>` or `/?connect_error=<reason>&connector=<connector>`. One login may connect several accounts.
- `POST /v1/accounts/connect/:connector/credentials` `{ network, inputs: { ... } }` → `201 Account[]` for non-OAuth connectors
  (Bluesky app password, Telegram bot token + channel, Discord webhook URL). `400` with `details.reason` on rejection.
- `POST /v1/media` multipart `file` (+ `alt`) → `201 { id, url, kind, mime, bytes, width, height, durationSeconds, media: Media }`; `GET /v1/media`; `DELETE /v1/media/:id`.
- `POST /v1/feed/:activityId/reply` `{ text, aiAssisted? }` → `201 PostDetail` (through the gate; may be pending approval).
- `POST /v1/feed/:activityId/moderate` `{ action: hide|unhide|delete|like|unlike }` → `{ ok, action }` (people only; delete needs owner/approver).
- `GET /v1/accounts/:id/metrics?metric=followers_total&from=` → `{ latest: {metric: value}, series: { value, observedAt }[] }`.
- Variants accept `options` (see VariantOptions in packages/schema/src/networks.ts) and `replyToExternalId`.
