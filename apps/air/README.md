# base air

**Attention and social for a campaign or cause.** base air is one of the three apps of **base** (broad application for
social engagement, served at base.win; see `SUITE.md` at the repository root). It observes every surface where attention
forms, forecasts where it is going (with honest confidence bands), acts through operator agents inside the client's
declared red lines, and proves what moved the outcome. A few staff use it; volunteers live in base ground.

Each client gets its own base air deployment, with its own servers and database, at `https://base.win/<client>/air`.
Until November 2026 this was the standalone Starsign repository.

- `docs/product-thesis.md` — what this is and why it wins (the five systems, the moat, the 24-month arc)
- `docs/social-command-center-plan.md` — platform API constraints, costs, build-vs-buy, roadmap
- `docs/API.md` — the HTTP contract the web room, the MCP server and agents build against (the suite parts at the end)

![The room: Radar, Queue, Feed, Brief](docs/screenshots/room.png)

## In the base suite

- **Address.** Served under `BASE_PATH` (e.g. `/imaginesurrey/air`). The server strips the prefix, answers
  `/api/health` with or without it and sends anything else without it to the prefixed path (308). `index.html` gets
  `<base href>` and `window.__BASE_PATH__`; the web build uses relative assets; one helper (`apps/web/src/lib/base.ts`)
  builds every absolute path in the browser; cookies are scoped to the prefix. `BASE_AIR_PUBLIC_URL` includes the
  prefix, so links in posts, emails and webhook registrations do too. `BASE_PATH` empty: everything at the root.
- **Sign in with base.** base ground is the sign-in hub. With `BASE_GROUND_URL` and `BASE_SSO_SECRET` set, the sign-in
  screen offers "Sign in with base" (`/auth/base?next=…`): base ground says who the person is, and base air signs them
  in to their own account with the same email, or tells them to ask an owner for an invite. It never creates accounts.
  Email and password sign-in stays.
- **The base switcher** in the top bar links to base ground's field and ground, base air, and base web's admin when
  `BASE_WEB_URL` is set.
- **Look and brand.** The default look is **Air**: dark, sky blue and violet on deep navy, IBM Plex Mono for figures.
  Owners set the workspace's brand on the **Brand** page (user menu → Brand): a preset (Air, Daylight, Ember, Lagoon,
  Newsprint), name, logo, colours, font, corners and mode, with a live preview and a contrast check. The server writes
  the brand into the HTML as CSS custom properties, so there is no flash. `BASE_AIR_BRAND_*` settings pre-configure a
  deployment before anyone saves one. The presets, tokens and contrast check live in `packages/look`.

## Run it

```bash
pnpm install
pnpm seed            # demo workspace with a week of history; prints a sign-in (owner@acme.test + password) and two API keys
pnpm dev:api         # http://localhost:4000  (embedded PGlite at ./.pglite, in-process scheduler)
pnpm dev:web         # http://localhost:5173  sign in with the printed email and password
BASE_AIR_API_KEY=<agent key> pnpm dev:mcp     # stdio MCP server for Claude / ChatGPT
pnpm test            # 70+ tests, no network, embedded Postgres
pnpm typecheck
```

People sign in with email and password (sessions, teams with owner/approver/editor/viewer roles, invites, password
reset, and workspace switching for agencies running several brands). Until someone on a deployment has a password, the
app opens on "Create your account" and the first person to sign up becomes an owner (signing up with the email of an
existing passwordless user, such as the seed's, claims that user and its workspaces); after that it is invite-only unless
`BASE_AIR_ALLOW_SIGNUP=1`. Set `RESEND_API_KEY` and `MAIL_FROM` to email invites and reset links. API keys remain, for
agents and automation (the MCP server, operators, scripts); people no longer paste them.

Locked out and no mail configured? From a shell on the server (Render: the web service's Shell tab, which starts in
`apps/api`):

```bash
node --import tsx src/admin.ts users                  # who is on this deployment and who can sign in
node --import tsx src/admin.ts reset-link you@example.com   # one-time link, valid for an hour
```

Locally the same is `pnpm --filter @base-air/api admin users`.

To try it under a prefix the way base.win serves it: `BASE_PATH=/imaginesurrey/air pnpm dev:api` after
`pnpm build:web`, then open `http://localhost:4000/imaginesurrey/air/`.

Set `BASE_AIR_DEV_WORKSPACE=acme` to skip signing in locally. Set `DATABASE_URL` (Postgres + pgvector) and `REDIS_URL`
for durable queues; then run `pnpm dev:workers` and `pnpm dev:operators` as separate processes. `ANTHROPIC_API_KEY`
turns the operators' model calls on (`BASE_AIR_FAKE_AI=1` runs them with a fake gateway).

## Shape

```
packages/look        brand presets (Air first), design tokens, the contrast check; shared by the server and the room
packages/schema      the open event schema v0: networks, policy (red lines, autonomy), content, listening, measurement, trends, events
packages/policy      red-line evaluator + autonomy resolution + the single gate every post passes through
packages/forecast    deterministic trend engine: resample → kinematics → stage → damped Holt with residual bands
packages/db          Drizzle schema, SQL migration (append-only triggers, pgvector, optional Timescale), PGlite/Postgres client
packages/ledger      event store (raw + ledger, hash-deduped), outcome snapshot schedule (1h…30d), approval diffs
packages/connectors  Connector interface, per-network validation, mock, Bluesky (AT Protocol), X (v2), Zernio
packages/core        the services: workspaces, accounts, policy, posts, approvals, publishing, listening, metrics, trends, ops, export
packages/ai          model gateway (Claude) with versioned prompts and a fake for tests
packages/sources     trend sources: Google Trends (trending-now RSS + official alpha API), Wikipedia pageviews,
                     Hacker News, Bluesky search, YouTube trending; the brand's own feed is sampled in core
apps/api             Hono HTTP API + SSE, serves the web build, seed script
apps/workers         BullMQ: durable publish queue, ingest / outcomes / forecast schedules, metered-read caps
apps/operators       Scout (trending terms → new topics scored against the brand), Watch (forecast → alert → draft into
                     the queue), Analyst (weekly brief), Steward (semantic red lines)
apps/mcp             MCP server: agents see the radar, feed, ledger and red lines; their posts land in the approval queue
apps/web             the room: Radar · Queue · Feed · Brief on one screen, drawers for detail
```

Two spines run through everything. The **data spine**: two append-only logs (`raw_events`, `ledger_events`) the
database refuses to update or delete, and every other table a rebuildable derivation. The **policy spine**: one
`Policy` document per workspace (red lines, autonomy dial, spend caps, disclosure) consulted by the UI, the API, the
operators and the MCP server alike, through one function: `gatePost`.

## Principles (binding)

Estimates with confidence bands, never false precision. Every recommendation shows its evidence. Policy over buttons:
humans set red lines and autonomy, operators do the work, the ledger holds everyone accountable. One room, no
page-flipping. Honest about platforms. Provenance by default. Portable by design (`GET /v1/export`). Model-agnostic,
data-loyal.

## Deploy

`Dockerfile` (build context `apps/air`) builds one image: the API with the built web room. The same image runs three
ways (web, workers, operators). The services themselves are defined in the suite's root `render.yaml`, per client and
per environment; base air needs:

| Service | Kind | Command | Notes |
|---|---|---|---|
| web | Render web service, Docker | the image's default (`node --import tsx src/main.ts` in `apps/api`) | health check `/api/health` |
| workers | Render background worker, Docker | `node --import tsx /app/apps/workers/src/main.ts` | BullMQ: publishing, ingest, outcomes, forecasts |
| operators | Render background worker, Docker | `node --import tsx /app/apps/operators/src/main.ts` | Scout, Watch, Analyst, Steward |

plus Postgres 16 with the `vector` extension (TimescaleDB is used when present and skipped when not) and Redis
(Render Key Value). Settings all three share: `DATABASE_URL`, `REDIS_URL`, `BASE_AIR_MASTER_KEY` (same value
everywhere), `BASE_AIR_PUBLIC_URL` (`https://base.win/<client>/air`), `NODE_ENV=production`. The web service also takes
`BASE_PATH`, `BASE_GROUND_URL`, `BASE_GROUND_INTERNAL_URL`, `BASE_SSO_SECRET`, `BASE_WEB_URL`,
`BASE_AIR_TRUSTED_PROXIES` and `BASE_AIR_BRAND_*`; the web service and operators take `ANTHROPIC_API_KEY` and
`BASE_AIR_MODEL`. Connector app keys go on the web service and the workers.

## Review

`docs/REVIEW.md` records the adversarial review that ran over the codebase, what it found, what was fixed and what
was deliberately left. Invariants worth defending are listed in `docs/ARCHITECTURE.md`.

## Status

Phase 0 scaffold, built 2026-11-02 as Starsign; renamed base air and brought into the base suite 2026-11-07. Native connectors post for real once credentials exist; platform reviews (Meta,
TikTok, LinkedIn pages) and the Google Trends alpha are external clocks — start them now.
