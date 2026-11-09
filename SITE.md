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
  The front door (`apps/door`) sends `base.win/<client>` itself to
  `/<client>/site/`, and an old `base.win/<client>/web…` link to
  `/<client>/desk/website` — the admin's Website area is at `/website`.
- App routes (`/api`, `/field`, `/desk`, `/admin`, `/media`, `/u`, `/r/…` receipts …) are
  never shadowed on the app host. On a site host, only the site's routes and
  `/media/:id`, `/site-assets/*` are answered, and what services and emails
  already sent call back, each only in its own shape and method: `POST
  /stripe/webhook`, Twilio's `POST /api/public/twilio/…` and the unsubscribe
  links `/u/<id>`, `/bu/<id>`, `/lu/<id>` — so no domain setting can drop a
  payment, a STOP or an unsubscribe. (`/r/…` there is the referral link.)

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
app_hosts      (host pk, first_seen, last_seen)
                -- the server's, not a campaign's: every address people used
                -- the app at, signed in; never a website domain
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
petition, `Signed: <campaign title>`; `join` and `donate` leave no tag —
who gave or joined is the desk's to see, never a volunteer's: People's
"did on the website" filter finds them), and "Brought in by" for a
referral. `join` and `donate` return `{ checkout_url }` from
`server/ext/payments` (or say online payments aren't set up) — Stripe is
asked only after that write has committed ("Payments readiness" below).

The `site_action` event is the hook for the rest of base.win
(`lib/hooks.js` `events`): follow-ups (speed to lead), ladders, People and
Map filters ("did on the website: …").

### What reacts to a site action (added with speed to lead and ladders)

Each reads the site server's tables only when they exist (`to_regclass`),
so nothing breaks before they are in.

- `site_actions.payload` holds the form's own fields under their form
  names (the table above: `roles`, `availability`, `note`; `topic`,
  `message`; `shift_id`; `comment`; …), as checked — the follow-up's card
  reads them from there by the event's `entity_id`.
- **Follow-ups** (`server/ext/followups`): `volunteer` → a follow-up,
  `contact` → one, `rsvp` → one when the person is new (made by the same
  write, or never contacted and on no other shift). One organizer each:
  the `referrer_id`'s teammate, else who knows them (My people), else the
  turf their pin is in, else a manager. Due 24 hours later; a logged
  contact closes it.
- **Ladders** (`server/ext/ladders`): trigger `web`, ref a kind
  (`petition`) or one campaign (`campaign:<campaign_id>`).
- **People filter** (`server/ext/webdid`, `lib/audience.js` FILTER_KEYS):
  `web=<kind>` · `web=campaign:<id>` · `web=any`, on `site_actions
  (workspace_id, person_id, kind, campaign_id)` — an index on `(workspace_id,
  person_id)` keeps it quick on the full voter file. `webWhere(ctx, value,
  w)` is exported for the Map's filter. A volunteer never sorts by `join` or
  `donate`. Words for each kind: `server/ext/webdid/words.js` (and
  `web/src/components/WebDid.js`).
- **Texts**: a ladder's text step skips anyone whose latest `consent_events`
  row for `sms` has `granted = false` — and, as for STOP, a number that
  asked to stop in a reply (`asks_stop`) since it last texted START.

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
| `donate` | `address`, `city`, `amount_cents` (required), `cadence` (`once`\|`monthly`), `slate` (optional), `declaration` (true, required) |

The declarations' words — what the join and donate boxes say, and what is
kept with the checkout and its gift — are `JOIN_DECLARATION` and
`DONATE_DECLARATION` in `shared/site/wording.js`, one place for both: a
Canadian citizen or permanent resident, living in BC, giving their own
money that no one pays back (membership dues count as a contribution; the
join box also says what they wrote is true and they're eligible).

A `contact` message is a request for the desk (`door_requests`, kind
`other`: "From the website (<topic>): <message>"), beside the action that
keeps it in its payload — never written into the person's note.

Answers: `200 { ok: true }` · `200 { ok: true, checkout_url }` (join, donate) ·
`400 { error, field }` (every refusal, the payments' own too) · `429 { error }` ·
`503 { error }` when online payments aren't set up or Stripe didn't answer
(the same `client_key` sent again finishes it). Never a person id or
anything about who was on file.
A plain form post (no JavaScript) gets a `303` back to the page with
`?sent=<kind>#m-<module_id>` (or `?error=<field>&module=<module_id>#m-<module_id>`,
so the page says it on the form that was sent), or to the checkout.

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
hydrated by `web/src/site-islands.js` (built by Vite — a second,
self-contained bundle with its own React, so it shares no chunk with the
app — to `web/dist/site-islands.js`, served at
`{root}site-assets/site-islands.js`). Without that build (tests), pages
still work: forms post normally.

### The renderer in detail (additive to the above)

`kind` other than the four, or a page, post or campaign that is `null`,
renders not found (404). Shapes the renderer reads — the first is the one to
write; the others are accepted too:

```
site.nav          { items: [{ label, href }], bar?: [{ label, href }] (≤3, in the title
                  bar on wide screens), cta?: { label, href } | null }  — a bare array is
                  items; cta left out → "Donate" → /donate; null → no button
site.footer       { acknowledgement (Markdown), links: [{ label, href }], text? (Markdown),
                  logo?: { url, alt } (drawn in place of the name) }
site.announcement { enabled, text, link: { label, href } }   (or linkLabel / linkHref)
site.seo          { title, description, image: { url, alt }, noindex? }   (or shareImage)
site.org          { name, short_name?, email, phone, address, authorization (the
                  "Authorized by …" line), privacy_url, time_zone?, platformUrl?,
                  platformLabel? (a link after the footer's links) }
site.social       [{ name, handle, url, cta? }]   (or { accounts: [...] })
page              { id, slug, title, description, modules }  — the published (or draft)
                  content with the row's id and slug; a site_pages row as it is
                  ({ …, draft, published }) works too, the draft when ctx.preview
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
  the message on that field (with `module_id`, only in that module's form,
  when it is on the page; a bare field marks every form on the page that has
  it — the server sends the posted `module_id` back as `&module=<id>`).
  `busy`, `payments`, `campaign` and `shift_id` are about the whole form:
  they show as its alert (bare: `busy` on every form, `payments` on join and
  donate, `campaign` on petitions and pledges, `shift_id` on the openings and
  events).
- `referral` — the code for the `ref` field. Leave it out of a page that is
  cached for everyone (the server reads the cookie when `ref` is missing).
- `source` *(added)* — the `?source=` tag, carried in the forms.
- `origin` *(added)* — the public address in front of `root`, e.g.
  `https://imaginesurrey.ca`, or `https://base.win/imaginesurrey` under
  `BASE_PATH`: absolute canonical, `og:url`, `og:image` and share links
  (without it the browser completes share links from the page's address,
  keeping the client's path).
- `media` *(added)* — where uploaded pictures (`/media/…`) are, default
  `/media/`; the server gives it the client's path under `BASE_PATH`, so an
  absolute `og:image` of an upload is right past `lib/mount.js` too.
- `timeZone` *(added)* — for dates; default `site.org.time_zone`, else
  `America/Vancouver`.

Forms as drawn: `<form method="post" action="{root}api/forms/<kind>">` with
SITE.md's names and nothing else. Tick boxes send `true`. The newsletter
sends `consent_email=true` as a hidden field, with the words beside the
button. The donate form always sends `cadence` (`once` when monthly is off).
Nothing per visitor is in the HTML except `ref`/`source` from `ctx`: there is
**no `client_key` in the HTML** (pages may be cached) — the browser makes one
per form and reuses it for retries; a plain post has none. With JavaScript,
`?ref=` and `?source=` in the address are carried when the page didn't —
only as the server takes them (a code of 6–16 letters and numbers; a tag
cut to 60 of a–z, 0–9 and `:_.-`; anything else left out, `util.js
trackFrom`), so a long tracking link never stops a form — a
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
`--ink-soft`, `--accent-on-ink`, `--action-row`, `--pop` and `--pop-alt`.
The catalogue exports `isSafeUrl`.

Every colour pair the site draws text in is covered: what an admin picks
is a checked pair (`PAIRS` — links and headings on soft panels among them),
and every other text colour is worked out from those and kept readable on
what it is drawn on (soft text on the brand, the deep brand and the Dark
background; the highlight on each; the events' rows; "Broken" on the error
colour). A box with its own background (a petition's) has its own text
colours; nothing tints the background under text (an alert, "signed up",
a hover). `e2e-site-render.mjs` sweeps themes at the check's edge — every
module in every background, form errors, thank-yous, the campaign page —
and reads every piece of text.

A page's `<head>` has an inline `<style>` (the theme's variables) and a
`<script type="application/ld+json">` (data, never run). A Content Security
Policy for the site needs `style-src 'self' 'unsafe-inline'` and, for the
video module, `frame-src https://www.youtube-nocookie.com https://player.vimeo.com`.

## Payments (`server/ext/payments`)

Keys only in the host's environment: `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET` (`STRIPE_API_BASE` for tests). Stripe over plain
`fetch` (no SDK). A checkout is two steps, so no write ever waits on
Stripe (a write holds the campaign's lock from start to commit: a slow
Stripe inside one would hold up every door knock, desk edit and form
behind it):

- `prepareCheckout(tx, ctx, { personId, kind: 'donation' | 'membership',
  amountCents, cadence: 'once' | 'monthly', slate, declaration, successUrl,
  cancelUrl, metadata, email }, emit?)` → `{ id, mode }` — inside the
  form's own write: the checks, then the checkout kept (`stripe_checkouts`,
  status `open`, no session yet, with the request Stripe will be sent) and
  on the event log (`payment_checkout` create). Database only; a refusal
  leaves nothing behind.
- `openCheckout(db, ctx, id, { action, also })` → `{ url, id, session_id,
  mode, result }` — after that write has committed, outside any
  transaction: Stripe is asked for its page once (10 s at most) under the
  idempotency key `base-checkout-<id>` with the request as kept, so asked
  again it answers with the same page; then a short write (`action` on the
  event log) keeps the session id (`payment_checkout` update) and runs
  `also(tx, emit, { url, session_id })` in that same write — the site
  keeps its answer there (`result`). Stripe saying no marks the checkout
  `failed`; no, or no answer: a 503.
- `retryCheckout(tx, ctx, id, emit?)` → `{ id }` | `null` — a checkout kept
  but never opened, ready to be asked again: as it was while Stripe may
  still answer with its page; after Stripe said no, or once it waited too
  long to be sent (Stripe wants the expiry 30 minutes ahead), with a fresh
  expiry under a new key (`base-checkout-<id>-<try>`, `tries` on the row).
  One checkout per form sent, however many tries.

Webhook `POST /stripe/webhook` (signature checked; each event id handled
once): a completed payment logs the gift through the normal gift path
(limit checked, receipt issued) or the membership; over the limit →
refunded through Stripe and flagged for the treasurer. It finds the
checkout by our id on the session's metadata, whether or not the session
id was kept yet.

What the payments branch adds to this (additive; INTEGRATIONS.md has the
Stripe setup):

- `ctx` needs only `workspaceId` (or `workspace.id`). Pass the form's
  `emit` and the checkout is on the event log beside the form's action.
- `email`: the address Stripe's page starts with — the one the visitor
  typed, never one on file (a record a form matched is not the visitor's
  to read).
- `declaration`: `true` (kept with the website's own words for the kind,
  `shared/site/wording.js`: `DONATE_DECLARATION` — exported here as
  `DECLARATION` — or, for membership, `JOIN_DECLARATION`) or the exact
  words the visitor ticked (a string).
- Membership also takes `term` (1 | 4), `birthDate` (YYYY-MM-DD) and
  `citizenship` (`citizen` | `pr`): dues are at least $10 a year ($5 for
  ages 14 to 30, from the birth date — the paper form's rule, `DUES`);
  members are 14 or older. When paid: the membership as the membership form
  makes one (source `website`, a renewal starting when the current term
  ends, the `member` tag) and the dues logged as a gift.
- `successUrl` may hold `{CHECKOUT_SESSION_ID}`; both URLs are absolute.
  `metadata` (flat, small) is kept with the checkout for the record.
- A refusal throws an Error with `.status` (400, or 503 when payments
  aren't set up or Stripe didn't answer), `.field` (`declaration`,
  `amount_cents`, `cadence`, `slate`, `term`, `birth_date`, `citizenship`,
  `person`) and a sentence a visitor reads. Over the limit it names the
  year's limit and the slate — never what the person has given. A visitor
  (no `ctx.user`) is refused only what no one may give: more than the
  year's limit at once, or a monthly gift over a twelfth of it. What this
  person may still give (their gifts this year and monthly gifts running)
  is checked before checkout only for someone signed in; for a visitor it
  is checked when the money lands, and refunded if over — so the answer
  never depends on what someone gave before.
- `paymentsReady()` → boolean (both keys set). `paymentsData(db, workspace)`
  → `{ ready, mode, year, limit_cents, monthly_max_cents }`: the loaders'
  `data.payments`.
- The webhook's events: `checkout.session.completed`,
  `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `checkout.session.expired`,
  `invoice.paid`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `charge.refunded`,
  `charge.dispute.created`, `charge.dispute.closed`.
- Tables `stripe_checkouts`, `stripe_payments`, `stripe_events`,
  `stripe_held` (a refund or dispute that came before its payment); the desk
  reads `GET /api/payments` (money roles) and writes `payment.ack`
  (area *money*).

## Settings (`site_settings`, `server/ext/site/shape.js`)

What each section holds (the renderer gets them as `site.*`; every `href`
is the site's own path — `/donate`, `/#m-join` — or http(s), mailto:, tel:;
the renderer puts `ctx.root` in front of the site's own):

```
nav           { menu: [{ label, href }],      // the Menu, in order; the renderer gets it with every
                                              // published page marked show_in_nav that isn't in it already, after it
                links: [{ label, href }],     // up to 3 in the title bar
                cta: { label, href } }        // the title bar's button (Donate)
                // store.js siteOf hands the renderer nav in its own words ("Rendering"):
                // { items: menu + those pages, bar: links, cta }
footer        { acknowledgement, links: [{ label, href }], logo: { url, alt } }
announcement  { enabled, text, linkLabel, linkHref }
seo           { title, description, shareImage: { url, alt } }
org           { name, shortName, email, phone, address, platformUrl, platformLabel, privacyUrl, authorizationLine }
social        { accounts: [{ name, short, handle, url }] }
theme         shared/site/theme.js (checkTheme: a pair under 4.5:1 is refused)
domains       ['imaginesurrey.ca', …]       // the site answers at / on these too
```

Additions to the renderer's input (additive to "Rendering" above):
`site.consent` = `{ email, sms, newsletter }` — the exact words next to the
consent boxes, and beside the newsletter's button (sending it is the yes
to email); the server stores them with each consent event, and the
renderer shows them as they are (without them it makes the same words the
same way, `shared/site/wording.js`). `ctx.error` (after a plain post: the
field to fix, or `busy` — too many from one address — or `payments` —
online payments aren't set up or didn't answer; with `&module=` from the
address, `{ field, module_id }`)
and `ctx.cancelled` (`join`/`donate`, back from the checkout without
paying). `ctx.root` ('' on the campaign's own domain, '/site' elsewhere)
and `ctx.assets` ('/site-assets') already carry a client's path
(BASE_PATH), so links in island props are right as they are; `ctx.islands`
is the islands script's address (`{assets}/site-islands.js`), or null when
the web build hasn't made it; `ctx.referral` is the code a referral link
remembered (the server reads it again on a form post — forms needn't send it).
`ctx.origin` is then the public address *without* the client's path (root
has it): the request's own (`https://imaginesurrey.ca`), or under a client's
path the origin of `STARBASE_PUBLIC_URL` (`https://base.win`) — the sitemap,
robots.txt and a supporter's own share link use the same. A page is cached
per address, so www and the bare domain never get each other's canonical.
Module anchors are `#m-<module id>`: the seeds link `/#m-join`.

Routes added to "Where the site is served": `/act` (every open petition and
pledge, each a `petition` module, as a page); `/news` is the page with slug
`news` when there is one (else the posts). `news` and `home` are the
site's own pages: their addresses never change. `/site-assets/*` serves
`shared/site/assets/*` (pictures — Imagine Surrey's under
`imagine-surrey/`), `shared/site/*.css` and fonts, and the islands' build —
`web/dist/site-assets/*`, then `web/dist/*` (`site-islands.js`) — by file
type; on the app's own address it is at `/site-assets/*` too. On the
campaign's own domain nothing else of `web/dist` answers (not `/assets/*`):
the islands' pieces belong under `site-assets/`. Pages carry a CSP with no
`'unsafe-inline'` for scripts: an inline `<script>` is allowed by its hash
(computed when the page is drawn), inline event handlers never are.

Tables, additive: `consent_events.address` (the email or number the yes or
no was about); `site_actions.answer` (what the visitor was told — a retry
gets it again; for `join` and `donate` empty until Stripe has made the
page); `site_actions.checkout_id` (`join`, `donate`: their checkout);
`site_actions.client_key` is stored as `<kind>:<key>` — for `join` and
`donate` with what is being paid after it (`<kind>:<key>:<amount>-<cadence>-<slate>`,
`<kind>:<key>:<amount>-<term>`), so the same key with another amount (back
from Stripe's page, a new choice) is a fresh checkout, never the old one.
The browser also makes a new key once a form is answered, and when a page
comes back from the back/forward cache.

## Who a form is (matching)

The same email (the intake API's matcher, `ext/intake matchWebsitePerson`)
fills what the record is missing (phone, address, city, postal code; a
name for a record that only had its email's first part). Else the same
name and phone, else the same name and postal code: those matches get the
action, the tags and the consent and nothing else (an email typed there is
kept beside the record, `attrs.typed_email`). Else someone new. Nothing on
file is overwritten; the answer never says whether they were on file.

Money (`join`, `donate`) is only ever the same email's, or someone new's: a
name and phone, or a name and postal code, is no proof of who is paying —
the gift, its receipt and the year's limit would land on a voter who never
gave. A join keeps its birth date and citizenship only where the profile
has none.

Consent: a ticked box joins base.win's newsletter list and records the
consent with its words — but never puts back an address that left the list
or a person who is do-not-email / do-not-text / do-not-contact (the
person's own signed link does). An unticked box changes nothing.
`await personToken(workspaceId, personId)` (ext/site; outside a write —
it may read the server's secret) makes the token for
`{site}/preferences?t=…` and `{site}/unsubscribe?t=…` in an email (good
for 400 days; their own page also shows their link to share, `/r/<code>`).

## Payments readiness

The site asks `server/ext/payments` (imported lazily) for `paymentsReady()`
→ boolean (it also takes `ready`, `isReady` or `stripeReady`, a function or
a boolean; with none, `STRIPE_SECRET_KEY` decides). A `join` or `donate`
then goes in three steps — no write ever waits on Stripe:

1. **The form's write** (`runAction('site.form.<kind>')`): the person, the
   consent, the action, and `prepareCheckout(tx, ctx, args, emit)` — the
   checkout kept — with `ctx = { workspaceId, workspace, user: null }`,
   `email` = the email they typed (or none), `declaration` = the words of
   the box they ticked, `successUrl` = the page `?sent=<kind>#m-<module>`,
   `cancelUrl` = the page `?cancelled=<kind>#m-<module>`, `metadata = {
   site_action_id, kind }` (and `term`, `youth`, `birth_date`,
   `citizenship` for a join). The action keeps `checkout_id`, and no
   answer yet. A refusal here leaves nothing behind. Committed.
2. **Stripe**, outside any transaction: `openCheckout` asks for the page
   (one call, 10 s at most, idempotency key `base-checkout-<id>`).
3. **A short second write** (the same action name) keeps the session on
   the checkout and the answer on the action, `{ ok: true, checkout_url }`.

Stripe failing or silent: the visitor hears 503 "We couldn't reach the
payment service"; the person and the action stay (they did ask), with no
answer. A retry with the same `client_key` finds that action, makes its
checkout ready again (`retryCheckout`: the same request and key while
Stripe may have made the page, else a fresh expiry under a new key) and
does steps 2 and 3 for it — one action, one checkout, never a second; two
at once (a double tap) get the same page. Once answered, a retry hears the
answer kept.

Before checkout the site refuses only what no one may give (over the
year's limit once, or over the monthly maximum): a person's own total is
checked when the money lands (and refunded if over), so the form never
says what someone gave before.

## Admin API

Signed in, the `site` area ("Website": managers by default; a manager may
grant it under Admin → Permissions); everyone else gets 403 on every read
and write. Reads (the first one makes the campaign's site from its brand's
seed):

| | |
|---|---|
| `GET /api/site` | `{ settings, pages: [page without draft/published], counts: { pages, published, posts, posts_published, campaigns, campaigns_open, actions, actions_week }, urls: { site, domains } }` |
| `GET /api/site/pages/:id` | `{ page: { id, slug, title, description, status, version, show_in_nav, nav_order, published_at, created_at, updated_at, changed, modules (count), draft, published } }` |
| `GET /api/site/posts` · `/:id` | `{ posts: [{ id, slug, title, excerpt, image, status, published_at, … }] }` · `{ post: { …, body } }` |
| `GET /api/site/campaigns` · `/:id` | `{ campaigns: [{ id, slug, kind, title, excerpt, statement, goal, status, signatures, … }] }` · `{ campaign: { …, body } }` |
| `GET /api/site/pictures` | `{ pictures: [{ id, url, name, width, height, bytes, created_at }] }` (Outreach's store too) |
| `POST /api/site/preview-token` | `{ pageId }` → `{ url, expires_at }`: the draft for 30 minutes, `noindex`, frameable by the app only |

Writes are actions (`POST /api/actions/:name`):

| action | input → answer |
|---|---|
| `site.settings.save` | `{ theme?, nav?, footer?, announcement?, seo?, org?, social?, domains? }` — each section sent replaces it → `{ saved, updated_at }` |
| `site.page.create` | `{ title, slug?, description?, modules?, show_in_nav? }` → `{ page }` (a draft; slug from the title when not given) |
| `site.page.save` | `{ id, title?, slug?, description?, image?, modules?, show_in_nav?, nav_order?, updated_at? }` → `{ page }` (the draft, `checkModules` loose; `image`: the share picture, below; `updated_at` as opened: someone else's save since → 409) |
| `site.page.publish` | `{ id }` → `{ page }` (`checkModules` strict, and the petitions it shows must exist; the error names the module) |
| `site.page.unpublish` · `delete` · `duplicate` | `{ id }` (home stays) · → `{ page }` for duplicate |
| `site.page.reorder` | `{ ids }` — the menu order |
| `site.post.save` · `publish` · `delete` | `{ id?, title, slug?, excerpt?, body?, image? }` → `{ post }` · `{ id, published? = true }` · `{ id }` |
| `site.campaign.save` · `close` · `delete` | `{ id?, kind, title, slug?, excerpt?, body?, statement?, goal? }` → `{ campaign }` · `{ id, open? }` · `{ id }` |
| `site.picture` | `{ data (base64 or data: URL), name?, width?, height? }` → `{ media: { id, url: '/media/:id' } }` (JPG/PNG/WebP, 2 MB) |
| `shift.public` | `{ id, public }` — the desk (Shifts area): the shift on the site's events |

Slugs: lowercase a–z, 0–9 and dashes; never `news`, `act`, `r`,
`preferences`, `unsubscribe`, `api`, `site-assets`, `__preview`,
`sitemap.xml`, `robots.txt`, `media`, `stripe`, `site` (and `home` is the
home page's). Every Website write clears the campaign's cached pages.

Environment: `SITE_HOSTS` (the campaign's own domains), `APP_HOSTS` (the
app's other addresses on this server, never a website domain: one people
used before base.win, say), `SITE_WORKSPACE`
(which campaign the site is, by slug; default the first set up),
`SITE_SECRET` (signs preview and preference links; unset, one is made and
kept in the database), `SITE_CACHE_SECONDS` (60; 0 turns the page cache
off), `SITE_FORMS_PER_MINUTE` (20 per address).

### Additions for the Website screens (additive)

- `GET /api/site` also answers `payments: { ready }` (online giving set up:
  `paymentsReady()`), `counts.actions_week_by_kind` (`{ petition: 12,
  newsletter: 3 }`, the last 7 days) and `urls.hosts` (`SITE_HOSTS` as
  `https://<host>/`, when this campaign is the site's — none already in
  `urls.domains`).
- Every campaign the API answers carries `signers_tag`: the tag a signature
  puts on the person (`tagOf('Signed: ', title)`, forms.js) — People lists
  them with `/people?tag=<signers_tag>`.
- `site.page.save` takes `image: { url, alt }` (or `null`): the page's own
  share picture. It lives in the draft and, once published, in what went
  live — `{ title, description, image?, modules }`, the key only when there
  is a picture. The renderer gets it as `page.image` (`{ url, alt }` or
  null) on a live page and a preview, and uses it for the page's share
  picture (og:image) before `seo.shareImage` and the hero's picture.
- Undo: `site.page.restore` · `site.post.restore` · `site.campaign.restore`
  `{ id }` → `{ page }` · `{ post }` · `{ campaign }` — a deleted one back as
  it was (live if it was live). If its address went to another meanwhile, it
  comes back at a free one like it (`-2`, `-3`…; the event's payload says
  `was`). The 'restore' op on the event log.

## The Website screens (`web/src/pages/Website*.jsx`)

The `site` area; the desk's menu has **Website** (App.jsx guards
`/website…` by the area; a volunteer without it is told the admin isn't
theirs, and the server refuses its data anyway).

| Address | Screen |
|---|---|
| `/website` | Overview: live or not, where it lives, "View site", this week's sign-ups by kind, pages, news, petitions, online giving |
| `/website/pages` | Pages in the menu's order: New page, In the menu, ⋯ Move up/down · Duplicate · Delete (Undo); drag by the handle or tap it and "Move here" |
| `/website/pages/:id` | The builder: sections (drag, tap or ⋯ to move; hide/show, duplicate, add below, delete with Undo), each a form made from its catalogue fields (`components/site/Fields.jsx`); page details (title, address, description, share picture, in the menu); the draft saves itself; Preview (a new tab, and beside the editor on a wide screen); Publish names the section and box that needs a look (`components/site/builder.js problemsOf`, the catalogue's own check) |
| `/website/theme` | A skin, the colours (every `PAIRS` pair's contrast as it changes; under 4.5:1 blocks saving; "Fix it" picks the nearest readable text colour), fonts, corners, logo, a live sample |
| `/website/settings` | Menu and title bar, announcement bar, footer, organization, social accounts, search and sharing, your own domain |
| `/website/news` · `/:id` | Posts: list, editor (picture, excerpt, Markdown), publish/unpublish, delete (Undo) |
| `/website/petitions` · `/:id` | Petitions and pledges: signatures and a bar to the goal, "See who signed" (People by `signers_tag`), editor, close/open again, delete (Undo) |

Careful with "your own domain": on a host in `domains` only the site answers
(no sign-in, no app). So `site.settings.save` refuses (400, in plain words)
every host the app itself answers at: the host the save came in on,
`STARBASE_PUBLIC_URL`'s, `RENDER_EXTERNAL_HOSTNAME`, the app's other
addresses in `APP_HOSTS`, and base.win and its subdomains (`store.js
appHosts`; `GET /api/site` lists them as `urls.app_hosts`, and the screen
refuses them as they're typed). One saved before this check is ignored where
the site looks domains up, so the app is never locked out of its own address
— the screen marks it, to be taken off. It also refuses any address people
used the app at, signed in (`app_hosts`, noted by the API at most once an
hour per address; a write that fails is tried again by the next request
there, never left for the hour), unless it is the site's already (saved
before, or in `SITE_HOSTS`): to make such an address only the website,
whoever runs the server adds it to `SITE_HOSTS`.

