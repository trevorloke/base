# Architecture

Starsign is one TypeScript monorepo with two spines running through every package.

## The data spine

Two append-only logs. Postgres triggers refuse `UPDATE` and `DELETE` on both.

| Log | What goes in | Why it exists |
|---|---|---|
| `raw_events` | Every payload received from any source, verbatim, hash-deduplicated | Nothing observed is ever lost; derivations can be rebuilt with better models later |
| `ledger_events` | Every fact Starsign asserts (`post.created`, `policy.blocked`, `variant.published`, `outcome.captured`, `operator.alert`, …) with the actor who caused it | The ledger is the product's memory and its audit trail; the brief, the lift analysis and the voice model all read from it |

Everything else is a derivation. `posts`, `activities`, `metrics`, `trend_forecasts` and friends are indexed, queryable
projections that could be recomputed from the logs. Derived tables carry `model_version` / `prompt_version` where a model
produced them, so a recompute can be selective.

The **outcome ledger** sits on top: every published variant gets six snapshot rows (`post_outcomes` at 1h, 6h, 24h, 72h,
7d, 30d). Workers capture them when due. Because every snapshot is at a fixed offset, posts are comparable across
networks, authors (human / operator / mcp), trend stages (`trend_actions`) and experiment arms. `MetricsService.summary`
and `liftByStage` are the first consumers; the forecaster's relevance and the drafting prompts are next.

## The policy spine

One `Policy` document per workspace (versioned in `policies`, every change in the ledger):

- **Red lines** — declared constraints the brand never crosses: forbidden phrases/topics/claims, competitor mentions,
  quiet hours, required disclosure, cadence caps, network restrictions, custom regex. Each has a severity
  (`block`, `require_approval`, `warn`). Evaluated by `@starsign/policy` on every output from every actor.
- **Autonomy dial** — per action class (`new_post`, `reply`, `dm`, `repost`, `campaign`): `suggest`, `draft`,
  `schedule_with_approval`, `autopost`. Operators and MCP agents follow it; humans follow role rules.
- **Spend caps** and **disclosure** defaults.

`gatePost()` combines both and is the only way a post comes into existence. It returns where the post lands
(`draft`, `pending_approval`, `scheduled`, `blocked`) or refuses creation. The API, the operators, the MCP server
and the seed all go through `PostService.create`, which goes through the gate. Approvals re-run red lines on the
edited text, so an edit cannot sneak past them, and every edit is recorded in `approval_diffs` as voice training signal.

## How attention gets in

Every hour the workers' `sources` job samples every topic from every configured source (`packages/sources`):
keyword interest over time from Google Trends (official alpha API when a key exists), Wikipedia daily pageviews,
Hacker News mentions per hour, Bluesky posts per hour, and the brand's own feed (mentions, replies and comments
matching the topic, recomputed over the trailing day so late ingestion lands in the right hour). Sources that list
"trending now" terms (Google Trends RSS, Wikipedia top articles, the Hacker News front page, YouTube most-popular)
are stored raw. Every two hours the Scout clusters those terms with the brand's context and starts tracking the
relevant, new ones (relevance >= 0.6, at most three a run, each with a recorded reason). The forecasts job then
recomputes every topic. `GET /v1/sources` reports each source's health.

## Packages

```
schema      zod schemas = the open event schema v0 (types for everything, no runtime deps)
policy      pure: red-line evaluation, autonomy resolution, gatePost
forecast    pure: resample → EWMA kinematics → stage → damped Holt → band; always deterministic
db          drizzle schema + SQL migration + client (PGlite in dev/tests, Postgres in prod)
ledger      EventStore (raw + ledger), OutcomeScheduler, ApprovalDiffs, prefixed ids
connectors  Connector interface, per-network validation, registry, mock, bluesky, x, zernio
core        Starsign: workspaces/accounts/policy/posts/approvals/publishing/listening/metrics/trends/ops/export
ai          ModelGateway (Anthropic SDK) with versioned prompts, pricing, FakeGateway
```

Dependency direction is strictly downward: `schema` ← `policy`/`forecast`/`db` ← `ledger`/`connectors` ← `core` ← apps.

## Apps

- **api** (Hono): the HTTP contract in `docs/API.md`, SSE fan-out from `Starsign.emitter`, serves `apps/web/dist`.
  Boot: migrate → connectors → scheduler (BullMQ when `REDIS_URL`, else in-process timers re-armed from the database).
- **workers** (BullMQ): durable publish queue (one delayed job per post, idempotent per variant), repeatable jobs for
  ingest (with metered-read caps), outcome capture, forecast refresh.
- **operators**: Watch (forecast → alert → draft into the queue), Analyst (weekly brief), Steward (semantic red lines).
  Direct core access, same trust level as workers.
- **mcp**: agents' front door, over the HTTP API with an agent key; proposals land in the approval queue.
- **web**: the room.

## Adding a connector

Implement `Connector` from `@starsign/connectors` (publish / fetchActivity / fetchMetrics / capabilities), map errors to
`ConnectorError` kinds so publishing knows what to retry, declare `meteredReads` if reads cost money, register it in
`createDefaultRegistry`. Credentials arrive decrypted in `AccountRef.auth`; never log them.

## Adding an operator

An operator is a function `(m: Starsign, gateway: ModelGateway, workspaceId) => summary` wrapped in
`m.ops.startRun/finishRun`. It reads through core, writes through core (so the gate applies), and attaches evidence to
everything it proposes. If it needs a new prompt, add one to `packages/ai/src/prompts` with a version string.

## Invariants worth defending

1. No write to a social network happens outside `PublishingService.publishPost`.
2. No post exists that did not pass `gatePost`.
3. No raw payload is ever modified or deleted.
4. Every ledger event names an actor.
5. Every forecast carries a band and a confidence; thin data is visibly thin.
6. Everything a workspace owns comes out of `GET /v1/export`.
7. Role gates are for humans; agent keys never pass them. Agents act only through the autonomy dial, on their own posts.
8. Connector resolution is strict and the mock connector never runs in production: a "published" post always touched a network.
9. API keys never appear in URLs; the live stream uses single-use, sixty-second tokens.
