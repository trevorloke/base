# Working on the Imagine Surrey site

These conventions keep the site consistent whoever (or whatever) is writing the code. Read this before adding a feature.

## Stack and layout

- Next.js 16 App Router, React 19, TypeScript, PostgreSQL via Drizzle ORM, Stripe Checkout, hosted on Vercel. **Next 16 differs from older Next.js**: read `node_modules/next/dist/docs/` when unsure.
- `src/app` pages and route handlers · `src/components` UI · `src/lib` shared logic (`src/lib/server/*` is server-only) · `src/content` seed/default copy · `drizzle/` migrations · `e2e/` end-to-end suites · `tests/` unit tests.

## Data

- The schema is `src/lib/db/schema.ts`. Change it, then run `npm run db:generate` (never `drizzle-kit push`). Every table ends with `.enableRLS()`; a test fails otherwise.
- Money is integer cents. Timestamps are `timestamp with time zone`; calendar dates (`date`) are plain `YYYY-MM-DD` strings handled in Pacific time (`src/lib/shifts.ts`, `src/lib/dates.ts`).
- One `people` row per email. Public forms may **create** a person and **fill blank fields**; they must never overwrite details an existing supporter gave earlier. Membership details are snapshotted on `memberships`.

## Server and client

- Components are server components unless they need state or events; then `"use client"` at the top. Server-only modules start with `import "server-only"`.
- Environment access goes through `src/lib/env.ts` (lazy getters, optional integrations). Never read `process.env` elsewhere except `NEXT_PUBLIC_*` in client code.

## Admin

- Every admin page and server action calls `requireAdmin(permission)` from `src/lib/server/admin-auth.ts`; every `/api/admin` route calls `adminOnly(permission)` from `src/lib/server/admin-api.ts`. The layout check and `src/proxy.ts` are extra gates, not the only ones.
- Permissions: `users`, `settings`, `integrations`, `content`, `tracker`, `people`, `shifts`, `comms`, `money`. Roles map to them in `ROLE_PERMISSIONS`.
- Forms submit to server actions built with `adminAction(permission, zodSchema, handler, auditAction)` from `src/lib/server/actions.ts`, used with `useActionState`. Show results with `<Notice state={state} />` and field errors with `fieldError(state, "name")`; submit with `<SubmitButton>` (pending state, optional `confirm`). Never `.parse()` raw FormData in an action; never leave an action that can throw on bad input.
- Use `checkbox()`, `multi()`, `optionalText()`, `httpUrl()` from `actions.ts` in action schemas. Numbers: `z.coerce.number()`.
- Destructive actions ask for confirmation. Prefer unpublish/deactivate over hard delete when other data points at the row.
- Record changes with `audit()` (the `auditAction` argument does it for you).

## Public pages and caching

- Public pages read data through loaders wrapped in `cached(key, tags, fn)` from `src/lib/server/cache.ts`. Loaders take request-specific values as arguments and never call `cookies()`, `headers()` or `connection()`.
- After any write that changes what the public site shows, call `invalidate(TAGS.x)` from the action or route handler.
- Public pages export `export const revalidate = 3600` so time-based content (upcoming events, countdowns) refreshes hourly.
- Site copy comes from `getSettings()` (`src/lib/server/settings.ts`); sections are defined in `src/lib/settings.ts`. Don't hardcode copy that an organizer would want to change.

## Public forms

- Route handlers under `src/app/api/*` use `parseBody(req, schema, bucket)` (honeypot, rate limit, zod). Schemas live in `src/lib/validation.ts` and must match the form exactly, including `maxLength`s.
- A public route that creates a record, sends an email or files a request for the desk passes `{ human: true }` to `parseBody` (the Cloudflare Turnstile check, when configured), and its form renders `<HumanCheck control={form.human} />` before the submit button. Stripe checkout routes don't.
- Forwarding to base ground (the campaign's database) goes through `src/lib/server/base-ground-forward.ts`, after the website has accepted the submission. RSVPs, paid orders and promise follows go as tags only, withdrawals go to the consent endpoint, and only the module listed for each forward may call it. Never forward money (donations, fees, order totals or items) or admin edits; `tests/base-ground-boundary.test.ts` checks the import graph.
- Client forms use `useApiForm` and the fields in `src/components/forms/Field.tsx`. Show field errors next to fields and the form error in an `Alert`; move focus to the first error or the success card after submit. Keep submit buttons enabled (use `aria-busy`), so focus never drops.
- Consent: email requires the person's own tick (`contactConsentAt`); texts require `smsConsentAt`. Newsletter sign-ups are double opt-in when email is configured. Never flip `unsubscribed` back without a confirmation click.

## Email, SMS, files

- `sendEmail(db, …)` sends now; `queueEmails` then `drainQueue` (in `after()`) sends in bulk, and the daily `/api/cron/email` job sweeps up anything left. Build HTML with `src/lib/email/templates.ts`; put feature-specific builders in your own file. Every bulk email carries an unsubscribe link.
- `sendSms` only to people with `smsConsentAt`; end texts with "Reply STOP to opt out".
- Uploads go through `storeFile` in `src/lib/server/storage.ts` and are recorded in `media`.
- Staff-written text is Markdown rendered with `renderMarkdown` (sanitized). Never render raw HTML from the database.

## Styling and accessibility

- Design tokens and shared classes are in `src/app/globals.css` (`.btn`, `.card`, `.field`, `.input`, `.alert`, `.display`, `.pop`, sections). Put feature-specific styles in a `*.css` file next to the page and import it there; don't grow `globals.css` without reason.
- Brand: navy `#003979`, red `#EF2023` (decorative) / `#D81B1E` (fills with white text), yellow `#FFF100`, Montserrat. Text contrast ≥ 4.5:1 (3:1 for ≥24px). Keyboard: visible focus everywhere, no keyboard traps, every drag-and-drop has a tap/keyboard path. Labels for every input; `role="alert"` for errors; `prefers-reduced-motion` respected; anything that moves for more than 5 seconds can be paused.
- Phone first: no horizontal scroll at 360px wide.

## Tests

- Unit: `npm test` (vitest, `tests/`). Add tests for pure logic you write.
- End to end: `npm run e2e` (needs a Postgres database whose name ends in `_e2e` or `_test`, Playwright's Chromium, and nothing on ports 3100, 3101 and 12111; see `e2e/run.mjs`). Add a suite `e2e/<feature>.e2e.mjs` for user-facing flows and register it in `run.mjs`.
- Before pushing: `npm run typecheck && npm test && npm run build`, and the relevant e2e suite.

## Commits

One feature per commit with a message that says what changed and why. No model names or tool names in commit messages, code or comments.
