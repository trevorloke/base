# The website inside base.win — how it fits together

The contract the website work is built against. Read with ROADMAP.md.

## Shape

| Where | What | Owner |
|---|---|---|
| `shared/site/catalogue.js` | the module catalogue: kinds, fields, defaults, `checkProps`, `checkModules` | shared |
| `shared/site/theme.js` | skins (`base`, `imagine-surrey`), fonts, contrast checks, `themeCss` | shared |
| `shared/site/components/` | the page components (React + `htm`, no JSX, no build needed on the server) — used by the server renderer and by the browser islands | renderer |
| `shared/site/site.css` | the public site's stylesheet (CSS variables from `themeCss`) | renderer |
| `shared/site/fonts/` | the site's faces, self-hosted: Montserrat, Inter (variable), Barlow Condensed | renderer |
| `server/ext/site/` | tables, actions, admin API, public routes, forms, seeds | site server |
| `server/ext/site/render/` | `renderSite(…)` → `{ status, html }` (React `renderToString`); `readSiteAsset(path)` for `/site-assets/*` | renderer |
| `web/src/site-islands.js` | the browser entry that hydrates interactive parts (forms, menus, share sheets) → `web/dist/site-islands.js` | renderer |
| `web/src/pages/Website*.jsx` | the Website area of the admin | admin |
| `server/ext/payments/` | Stripe: checkout, webhooks, refunds | payments |

## Where the site is served

- On the campaign's own domain(s): `SITE_HOSTS=imaginesurrey.ca,www.imaginesurrey.ca`
  (comma list; also `site_settings.domains`). On those hosts the site is at `/`.
- Everywhere else (the app's own address, base.win/<client>), the site is at
  `/site/…` (so `base.win/imaginesurrey/site/` works before DNS moves).
- App routes (`/api`, `/field`, `/desk`, `/admin`, `/media`, `/u`, `/r/…` receipts …) are
  never shadowed on the app host. On a site host, only the site's routes and
  `/media/:id`, `/stripe/webhook`, `/site-assets/*` are answered.

Site routes (relative to the site root):
`/` (the page with slug `home`) · `/:slug` (any published page) ·
`/news`, `/news/:slug` · `/act/:slug` (a petition or pledge) · `/r/:code`
(referral link: remembers the referrer for 30 days, then home) ·
`/preferences?t=…` and `/unsubscribe?t=…` (email/text consent, signed token) ·
`/__preview/:pageId?t=…` (a draft, signed short-lived token, `noindex`) ·
`/sitemap.xml` · `/robots.txt` · `/site-assets/*` (css, fonts, island script) ·
`POST /api/forms/:kind`.

## Tables (`server/ext/site/sql.js`)

```
site_settings  (workspace_id pk, theme jsonb, nav jsonb, footer jsonb,
                announcement jsonb, seo jsonb, org jsonb, social jsonb,
                domains jsonb, updated_at)
site_pages     (id, workspace_id, slug, title, description, draft jsonb,
                published jsonb, version int, status 'draft'|'published',
                show_in_nav bool, nav_order int, published_at,
                created_at, updated_at, deleted_at)
                -- draft/published: { title, description, modules: [{ id, kind, hidden, props }] }
                -- unique (workspace_id, slug) where deleted_at is null
site_posts     (id, workspace_id, slug, title, excerpt, body, image jsonb,
                status, published_at, created_at, updated_at, deleted_at)
site_campaigns (id, workspace_id, slug, kind 'petition'|'pledge', title,
                excerpt, body, statement, goal int, status 'open'|'closed',
                created_at, updated_at, deleted_at)
site_actions   (id, workspace_id, person_id, kind, campaign_id, page_id,
                module_id, payload jsonb, source, referrer_id, client_key
                unique per workspace, created_at)
consent_events (id, workspace_id, person_id, channel 'email'|'sms',
                granted bool, source, wording, created_at)
```

Every write goes through `runAction` (hash-chained event log). Admin actions:
`site.settings.save`, `site.page.create | save | publish | unpublish |
duplicate | delete | reorder`, `site.post.save | publish | delete`,
`site.campaign.save | close | delete`. A draft save checks modules with
`checkModules(list)`; publishing with `checkModules(list, { strict: true })`.
New permission area **`site`** ("Website"); managers by default.

## Public forms → people and actions

`POST {site}/api/forms/:kind`, JSON or form-encoded (works without JS: on a
form post it redirects back with `?sent=<kind>`). Kinds: `newsletter`,
`petition`, `pledge`, `volunteer`, `rsvp`, `contact`, `join`, `donate`.
Each: honeypot field `website` (must be empty), per-IP rate limit, an
idempotency key `client_key` (a retry never doubles), `consent_email` /
`consent_sms` boxes (wording stored with the consent event), `ref` (referral
code). The person is matched like the intake API (email, then phone, then
name + postal) or created; placed on the map by the existing address
lookup. One `runAction('site.form.<kind>')` records: the person (created or
updated), a `site_actions` row (emits entity `site_action`, op `create`,
payload `{ kind, person_id, campaign_id, page_id, module_id, source,
referrer_id }`), consent events, a tag (`Website: <kind>` and, for a
petition, `Signed: <campaign title>`), and "Brought in by" for a referral.
`join` and `donate` return `{ checkout_url }` from `server/ext/payments`
(or say online payments aren't set up).

The `site_action` event is the hook for the rest of base.win
(`lib/hooks.js` `events`): follow-ups (speed to lead), ladders, People and
Map filters ("did on the website: …").

### Form fields (the renderer's forms send exactly these; the server reads exactly these)

Every kind: `first_name`, `last_name`, `email`, `phone`, `postal_code`,
`consent_email` (bool), `consent_sms` (bool), `website` (honeypot, must be
empty), `client_key` (idempotency, ≤64), `ref` (referral code, else the
cookie), `page_id`, `module_id`, `source` (e.g. `share-whatsapp`). An email
or a phone is required for every kind.

| kind | also |
|---|---|
| `newsletter` | — (`consent_email` must be true) |
| `petition`, `pledge` | `campaign` (id, required), `comment` (≤1000) |
| `volunteer` | `roles` (list of strings), `availability` (≤300), `note` (≤1000) |
| `rsvp` | `shift_id` (required) |
| `contact` | `topic` (≤60), `message` (required, ≤4000) |
| `join` | `address`, `city`, `birth_date` (YYYY-MM-DD), `citizenship` (`citizen`\|`pr`), `declaration` (true, required), `term` (1\|4), `amount_cents` |
| `donate` | `address`, `city`, `amount_cents` (required), `cadence` (`once`\|`monthly`), `slate` (optional), `declaration` (true, required: a Canadian citizen or permanent resident living in BC, giving their own money) |

Answers: `200 { ok: true }` · `200 { ok: true, checkout_url }` (join, donate) ·
`400 { error, field }` · `429 { error }` · `503 { error }` when online
payments aren't set up. Never a person id or anything about who was on file.
A plain form post (no JavaScript) gets a `303` back to the page with
`?sent=<kind>#m-<module_id>` (or `?error=<field>#m-<module_id>`), or to the
checkout.

### What the loaders give the renderer (`data`)

```
{
  posts:     [{ slug, title, excerpt, image, published_at }],          // newest first, published only
  events:    [{ id, title, starts_at, ends_at, location, spots_left, lat, lng }],  // upcoming public shifts/events
  counts:    { members, signatures: { [campaignId]: n } },
  campaigns: { [id]: { id, slug, kind, title, excerpt, statement, goal, count, status } },
  payments:  { ready, limit_cents, monthly_max_cents },               // limit from server/lib/cap.js for this year
  roles:     [string],                                                  // the volunteer roles base.win offers
}
```
`site` = `{ theme (checked), nav, footer, announcement, seo, org, social }`.

## Rendering

`renderSite({ kind: 'page'|'post'|'campaign'|'notFound', site, page, post,
campaign, data, ctx })` → `{ status, html }`. `site` = settings with the
theme already checked; `data` = what the loaders read for the modules on
the page (news, events, open shifts, counts, campaigns); `ctx` =
`{ root, assets, islands, preview, path, sent, referral }`.
Every module's outer element carries `data-module="<kind>"` and
`id="m-<module id>"` (tests and anchors rely on it). Interactive parts are
islands: SSR'd HTML plus `<script type="application/json">` props,
hydrated by `web/src/site-islands.js` (built by Vite as a second input to
`web/dist/site-islands.js`). Without that build (tests), pages still work:
forms post normally.

### The renderer in detail (additive to the above)

`kind` other than the four, or a page, post or campaign that is `null`,
renders not found (404). Shapes the renderer reads — the first is the one to
write; the others are accepted too:

```
site.nav          { items: [{ label, href }], bar?: [{ label, href }] (≤3, in the title
                  bar on wide screens), cta?: { label, href } | null }  — a bare array is
                  items; cta left out → "Donate" → /donate; null → no button
site.footer       { acknowledgement (Markdown), links: [{ label, href }], text? (Markdown) }
site.announcement { enabled, text, link: { label, href } }   (or linkLabel / linkHref)
site.seo          { title, description, image: { url, alt }, noindex? }   (or shareImage)
site.org          { name, short_name?, email, phone, address, authorization (the
                  "Authorized by …" line), privacy_url, time_zone? }
site.social       [{ name, handle, url, cta? }]   (or { accounts: [...] })
page              { id, slug, title, description, modules }  — the published (or draft)
                  content with the row's id and slug
post              { slug, title, excerpt, body (Markdown), image: { url, alt }, published_at }
campaign          { id, slug, kind, title, excerpt, body (Markdown), statement, goal,
                  count?, status }  — count, else data.campaigns[id].count, else
                  data.counts.signatures[id]
data.shifts       optional: the Volunteer openings module lists these, else data.events
data.payments.membership_min_cents   optional: the join form's amounts start there
```

`ctx`, exactly:

- `root` — the site's root path with a trailing slash: `/` on the campaign's
  domain, `/site/` on the app's address. Every site link is drawn under it
  (`/donate` → `/site/donate`); `/media/…` stays as it is; `/site-assets/…`
  goes under `assets`. Under `BASE_PATH` give it without the base:
  `lib/mount.js` puts the base in front of `href`, `src` and `action`.
- `assets` — default `{root}site-assets/`.
- `islands` — the island script: `true` → `{assets}site-islands.js?v=<hash>`; a
  path or https URL → as given; `false` → none; left out → included when
  `web/dist/site-islands.js` exists. It is written only into pages with an
  island other than the Menu (which works without it), so a plain page loads
  no JavaScript.
- `preview` — the preview banner, `noindex`, no canonical.
- `path` — this page's path under the root (`/`, `/about`, `/news/a-post`; the
  root in front is taken off): canonical, share links, the current nav item.
- `sent` — the `?sent=<kind>` value (or `{ kind, module_id }`): that kind's
  form shows its thank-you instead.
- `error` — the `?error=<field>` value (or `{ field, module_id, kind, message }`):
  the message on that field (with `module_id`, only in that module's form;
  a bare field marks every form on the page that has it — the posted
  `module_id` can come back in the address for this, e.g. `&module=<id>`).
- `referral` — the code for the `ref` field. Leave it out of a page that is
  cached for everyone (the server reads the cookie when `ref` is missing).
- `source` *(added)* — the `?source=` tag, carried in the forms.
- `origin` *(added)* — the public address in front of `root`, e.g.
  `https://imaginesurrey.ca`, or `https://base.win/imaginesurrey` under
  `BASE_PATH`: absolute canonical, `og:url`, `og:image` and share links
  (without it the browser completes share links from the page's address,
  keeping the client's path).
- `timeZone` *(added)* — for dates; default `site.org.time_zone`, else
  `America/Vancouver`.

Forms as drawn: `<form method="post" action="{root}api/forms/<kind>">` with
SITE.md's names and nothing else. Tick boxes send `true`. The newsletter
sends `consent_email=true` as a hidden field, with the words beside the
button. The donate form always sends `cadence` (`once` when monthly is off).
Nothing per visitor is in the HTML except `ref`/`source` from `ctx`: there is
**no `client_key` in the HTML** (pages may be cached) — the browser makes one
per form and reuses it for retries; a plain post has none. With JavaScript,
`?ref=` and `?source=` in the address are carried when the page didn't, a
`checkout_url` is followed only when it is https (or this site), and a 400's
`{ field, error }` is shown on that field. Volunteer openings and events post
`rsvp` with `first_name`, `email` or `phone`, and `shift_id`, one small form
per opening.

The site's own files: `readSiteAsset(path)` (`server/ext/site/render`) →
`{ body, type, cache, etag }` or `null`, for `site.css`, `fonts/<name>.woff2`
and `site-islands.js`; the site's `GET /site-assets/*` sends it as it is. A
request carrying the file's current `?v=` may be cached for a year.

Theme additions (`shared/site/theme.js`, additive): colours `action` and
`actionInk` (the Donate and Sign buttons, the heading shadow; checked as a
pair; left out they follow the skin, or the brand when the brand was
changed), `pop` (the layered heading shadow; on for Imagine Surrey),
`COLOR_LABELS`, `themeColors(theme)` (the colours worked out from a theme,
each kept readable) and `mix`. `themeCss` also writes `--action`,
`--action-ink`, `--muted`, `--brand-soft`, `--field-line`, `--brand-deep`,
`--danger`, `--accent-on-brand`, `--accent-on-deep`, `--heading-on-accent`,
`--pop` and `--pop-alt`. The catalogue exports `isSafeUrl`.

A page's `<head>` has an inline `<style>` (the theme's variables) and a
`<script type="application/ld+json">` (data, never run). A Content Security
Policy for the site needs `style-src 'self' 'unsafe-inline'` and, for the
video module, `frame-src https://www.youtube-nocookie.com https://player.vimeo.com`.

## Payments (`server/ext/payments`)

Keys only in the host's environment: `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET` (`STRIPE_API_BASE` for tests). Stripe over plain
`fetch` (no SDK). `checkoutFor(tx, ctx, { personId, kind: 'donation' |
'membership', amountCents, cadence: 'once' | 'monthly', slate,
declaration, successUrl, cancelUrl, metadata })` → `{ url }`. Webhook
`POST /stripe/webhook` (signature checked; each event id handled once):
a completed payment logs the gift through the normal gift path (limit
checked, receipt issued) or the membership; over the limit → refunded
through Stripe and flagged for the treasurer.
