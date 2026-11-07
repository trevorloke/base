# Review record, 2026-11-02

An adversarial review ran over the whole codebase: nine finders (tenancy/auth, gate and approvals, publishing,
ledger and data, forecast math, API contract, operators and model gateway, connectors, web) and two skeptics per
finding (does it reproduce, does it matter). Sixty-seven agents completed; eighty failed mid-run when the account's
usage credits ran out, so a third of the findings were judged by hand instead of by two independent verifiers.

## Fixed

Tenancy and authorization
- Role gates (`requireRole`) now fail closed for agent keys. An MCP or operator key could connect/disconnect
  accounts, rewrite the brand profile and create global topics. Keys can be listed and revoked (`/v1/keys`).
- Topics are workspace-scoped on every read and write; global topics are written only by the system.
- `GET /v1/metrics/series` resolves the entity inside the caller's workspace first (the metrics table has no
  workspace column). Feed imports check the account belongs to the caller.
- Cancelling, editing and scheduling existing posts check roles and autonomy; agents may only touch their own.
- The SSE stream no longer accepts the API key in a URL. The web app mints a 60-second single-use stream token.
- The MCP HTTP server requires a bearer on every request; no process-wide fallback key.

The gate and approvals
- Approval edits are validated and re-gated in memory before anything is persisted, so a blocked edit never
  becomes stored text or a voice example. The 422 carries `details: { violations }`.
- `POST /v1/posts/:id/schedule` requires a time (a missing `at` used to mean "now"). Malformed JSON is a 400.
- `max_posts_per_day` without a network list counted the total twice.

Publishing
- Status transitions are conditional: a cancel that lands while publishing is in flight wins and is never
  overwritten. A thread that fails after its root went out keeps the root's ids on the variant.
- X tokens refresh proactively near expiry and reactively on 401, and the refreshed blob is persisted.
- Connector resolution is strict (no silent fallback to another adapter); the mock connector is not registered
  in production unless `BASE_AIR_ENABLE_MOCK=1`.
- The in-process timer scheduler re-arms instead of firing early for delays beyond ~24.8 days.

Measurement and ledger
- Metered X reads are priced on every path (ingest and outcome capture) and paused at the workspace cap.
- Exports include metrics (they were filtered by the wrong id). Raw-event hashes include the workspace.
- Forward paging of the ledger (`afterSeq`) walks oldest-first.
- A post's 24h outcome on a topic sums its variants instead of picking one.

Forecast honesty
- Confidence counts real observations, not interpolated grid buckets; two points can never look like a day.
- The grid ends at the last observation instead of being carried forward to now (which manufactured plateaus);
  staleness is reported and discounts confidence. Future-dated and non-finite points are ignored.
- Sparse count sources normalize by their mean, not a near-zero median.

Web room
- The post history reads the ledger's real keys (`outcome`, `metrics`); approvals no longer all read as
  "changes requested" and outcome lines show their numbers.
- Topic charts show what their labels say (first 24 hours of forecast, last 48 hours of each source).
- Approve is disabled while an edited variant exceeds its network's limit (the server validates too).
- Feed refreshes merge by id and ignore late responses from a previous filter.

Operators and gateway
- The weekly brief is not retried every minute after a failure (six-hour backoff).
- The per-workspace model spend cap is enforced before each run. Unknown model ids are flagged once.

## Deliberately left as is
- Semantic red lines (the Steward) fire on the second evaluation unless primed; the Watch primes its own drafts.
  Humans' and agents' first submissions are caught at approval or re-gate. Documented in code.
- Idempotency for Bluesky and X is process-local; a restart may re-post a half-finished thread. The root id is
  now persisted, which bounds the damage; durable progress belongs with the first real credentials.
- Zernio is an unverified scaffold (its docs were unreachable from the build sandbox).
- `xWeightedLength` approximates X's weighting (emoji and symbols count 2; bare domains without a scheme do not
  count as links).

## Not yet verified by a second reader
The unverified findings that were not fixed are in the workflow output and are mostly duplicates of fixed items or
judgment calls listed above. Re-run the review once credits allow: `docs/REVIEW.md` is the place to extend.
