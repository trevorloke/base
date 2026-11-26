# The website inside base.win — how it fits together

The contract the website work is built against. Read with ROADMAP.md.

## Shape

| Where | What | Owner |
|---|---|---|
| `shared/site/catalogue.js` | the module catalogue: kinds, fields, defaults, `checkProps`, `checkModules` | shared |
| `shared/site/theme.js` | the Base look, fonts, contrast checks, `themeCss`; a campaign's own look is added at run time (`presetLooks`) | shared |
| `server/ext/site/from-preset.js` | what one campaign's set-up brings to its own website and no other: its look, `look.css`, pictures, first site, words and starting sections (`server/presets/`) | site server |
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
  A host with a final dot is the same host (`imaginesurrey.ca.` is
  `imaginesurrey.ca`): in a request, in these lists, and where the app's
  own addresses are noted (`store.js hostOfRequest`).
- Everywhere else (the app's own address, `<client>.base.win`), the site is
  at `/site/…` (so `https://imaginesurrey.base.win/site/` works before DNS
  moves). Not in use today: the front door (`apps/door`), which would send
  `base.win/<client>` itself to `/<client>/site/`, and an old
  `base.win/<client>/web…` link to `/<client>/desk/website` — the admin's
  Website area is at `/website`.
- App routes (`/api`, `/field`, `/desk`, `/admin`, `/media`, `/u`, `/r/…` receipts …) are
  never shadowed on the app host. On a site host, only the site's routes and
  `/media/:id`, `/site-assets/*` are answered, and what services and emails
  already sent call back, each only in its own shape, case and method: `POST
  /stripe/webhook`, Twilio's `POST /api/public/twilio/…`, the email sender's
  `POST /hooks/mail/<sender>`, Mailchimp's `/hooks/mailchimp/<key>`, CallHub's
  `POST /hooks/callhub/<key>` and the unsubscribe
  links `/u/<id>`, `/bu/<id>`, `/lu/<id>` (the id in either case; `/U/…` is
  the site's) — so no domain setting can drop a payment, a STOP, a bounce, a
  call's result or an unsubscribe. (`/r/…` there is the referral link.)

Site routes (relative to the site root):
`/` (the page with slug `home`) · `/:slug` (any published page) ·
`/news`, `/news/:slug` · `/act/:slug` (a petition or pledge) · `/r/:code`
(referral link: remembers the code for 30 days, then home — any code of the
right shape, known or not, so a code that is nobody's looks the same; a form
credits only a code that is someone's; with `?k=<kit>`,
a share kit's link, it also remembers the post as `site_src` = `kit-<kit>`
and opens the post's page, `?source=kit-<kit>`) ·
`/preferences?t=…` and `/unsubscribe?t=…` (email/text consent, signed token) ·
`/__preview/:pageId?t=…` (a draft, signed short-lived token, `noindex`) ·
`/sitemap.xml` · `/robots.txt` · `/site-assets/*` (css, fonts, island script) ·
`POST /api/forms/:kind` · `/events.ics` (the Events list's upcoming public
shifts, as a calendar) · `/events/<id>.ics` (one public upcoming shift from
either list). The two calendar routes answer only where a published page of
that site has an Events or Volunteer openings section that isn't hidden
(a microsite without one answers its 404); each entry has the title, times
(UTC), place words, its pin and the page — never instructions, links, counts
or people — and ends with the campaign's name, the site's address and the
authorization line when one is set (`server/ext/site/calendar.js`). The
app's own calendar links (`/cal/…`) never answer on a site's domain.

## Other websites (`server/ext/site/microsites.js`)

A campaign may have up to five other websites (`microsites`): a petition or
a contrast site on a domain of its own (dougdidnt.ca), with its own name,
look (`theme`) and pages (`site_pages.site_id`, at most 50), built in the
same page builder. It stores nothing else: the organization, the privacy
policy, the social accounts and "Authorized by …" are always the main
site's — the same elector organization sponsors every site and keeps what
every form collects.

- **Where**: its domain (at most two: the bare domain and its `www.`, which
  making it with an address saves together) at `/`,
  and `/site/sites/<key>/…` on the app's address (`noindex` there once it has
  a domain). A draft or offline site answers every route with "Coming soon"
  (`noindex`, `no-store`), but `/site-assets/*` and a page's preview.
- **Routes there**: `/`, `/:slug` (its own pages), `/act/:slug` (any open
  petition or pledge; canonical on the main site's address), `/r/:code`,
  `POST /api/forms/:kind`, `/sitemap.xml` (its pages), `/robots.txt`,
  `/site-assets/*`. `/news…`, `/act`, `/preferences` and `/unsubscribe` are its
  404: emails link to the main site's.
- **What the renderer gets** (`store.js siteOf`): its theme; a menu of its
  pages marked "In the menu" (no title-bar button); search and sharing from
  its home page; the main site's `org` (privacy link absolute on the main
  site's address), social accounts and consent words; `site: { name, key }`
  (the header and `<title>`); `parent: { name, url }` — the footer's "A
  website by …" link. Its footer is the main site's bottom lines and logo.
- **Addresses** (`hostProblem`): never the app's own, one people used the
  app at, `SITE_HOSTS`, any campaign's main domains or another website's.
  An address a website stops using (dropped, or the site deleted) is
  **closed**: every route there, any method, answers `410` "This website has
  closed" with who it was by, the main site's link and "Authorized by …" —
  never the app — until a manager releases it (remove it from Render first;
  after release it would reach the app). A closed address of this campaign
  may be given to another of its websites; another campaign's may not.
- **Who**: anyone with the Website area edits its pages and look; only a
  manager creates, renames, sets addresses, takes it live or offline,
  deletes, restores or releases. Going live needs its home page published,
  Settings → Organization → Authorized by (the agent and how to reach them)
  and the privacy policy link — refused with the first one missing.
- **Forms**: `site_actions.site_id` (and the `site_action` event) say which
  website; the source is `?source=`, else `?utm_source=` (the island's, and a
  plain post's own address or the page it came from). One people database:
  the same email is the same person on every site. People: `web=site:<id>`
  (never the money forms); History adds "on <its domain>".
- **"Authorized by …"** (`shared/site/wording.js authorizedBy`): "Authorized
  by <agentName>, <agentContact>", else the old `authorizationLine` — in the
  footer of every page of every site and on the plain pages. Every form's
  small print ends "<org> keeps what you send to stay in touch about our
  work and elections." and the "Privacy policy" link (`PRIVACY_LINE`).

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
(`lib/hooks.js` `events`): follow-ups (speed to lead), ladders, and People's
filter ("did on the website: …") — so a list, a send, a phone bank, a pass
and Calls can say it too. The map has no such filter yet.

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
cookie), `page_id`, `module_id`, `source` (e.g. `share-whatsapp`; when the
form sends none, the share kit the visitor came through, from `site_src`). An email
or a phone is required for every kind; the newsletter, `join` and `donate`
need an email (money is only ever the same email's record, or someone
new's). An email is checked as Stripe's page checks it — no `..`, no dot
at either end of the name or the domain, no hyphen at either end of a
part of the domain — by one pattern for the browser and the server
(`EMAIL_RE`, `shared/site/components/util.js`).

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

Answers: `200 { ok: true, ref_code }` · `200 { ok: true, checkout_url }` (join, donate) ·
`400 { error, field }` (every refusal, the payments' own too — Stripe
refusing the email typed is a 400 on `email`) · `429 { error }` ·
`503 { error }` when online payments aren't set up or Stripe didn't answer
(the same form sent again with its `client_key` finishes it). Never a
person id or anything about who was on file: `ref_code` is the person's
own referral code only when this form added them (the thank-you's share
links carry it as `ref=`, so a friend who signs counts as theirs); for
anyone matched it is a code of the same shape that is nobody's, and
`/r/` follows it exactly as it follows a real one.
A plain form post (no JavaScript) gets a `303` back to the page with
`?sent=<kind>#m-<module_id>` (or `?error=<field>&module=<module_id>#m-<module_id>`,
so the page says it on the form that was sent), or to the checkout. A sign-up
adds `&shift=<id>`, so the page offers that event for a calendar under its
*You’re signed up*.

### What the loaders give the renderer (`data`)

```
{
  posts:     [{ slug, title, excerpt, image, published_at }],          // newest first, published only
  events:    [{ id, title, starts_at, ends_at, location, spots_left, lat, lng }],  // upcoming public shifts that are events (the Event kind)
  shifts:    [{ …the same… }],                                         // upcoming public shifts of every other kind: the volunteer openings
  counts:    { members, signatures: { [campaignId]: n } },
  campaigns: { [id]: { id, slug, kind, title, excerpt, statement, goal, count, status } },
  payments:  { ready, limit_cents, monthly_max_cents },               // limit from server/lib/cap.js for this year
  roles:     [string],                                                  // the volunteer roles base.win offers
}
```
`site` = `{ theme (checked), nav, footer, announcement, seo, org, social, icon }`.
`icon`: the campaign's mark as app icons (`{ icon, touch }`, its own
`/media/<id>.png` files; Settings → Brand) — the page's `<link rel="icon">`
and touch icon, on the app's address and the campaign's domain alike.

**Following the campaign's brand.** `theme.follow` (true for a new generic
website; a website made before it existed, Imagine Surrey's among them, has
no such key and keeps its own look): the site wears the campaign's brand
(`server/lib/brand.js`, Settings → Brand) in place of the stored colours —
`store.js themeFromBrand`: the brand colour and the text on it, the second
colour as the accent, the brand as words for links, the brand on the
action buttons, the app's neutral page and panels, the heading face and
corners, the logo in the title bar and the logo for dark backgrounds in the
footer — worked out by the app's rule, so every `PAIRS` pair reads. The
stored colours stay for when it stops following. `GET /api/site` answers
`brand_theme` (what the brand makes, where "Give the website its own look"
starts); `site.settings.save` changes `follow` only when its theme says so.
A brand save clears the kept pages. A website that had its own look when it
began to follow says so (`theme.kept`, set by the server, never by the
save's own word). On Website → Theme a following site says so and shows
the sample, with **Give the website its own look** — or, when its own look
is kept, **Go back to the look it had** beside **Start from the campaign's
brand** (which replaces it); one with its own look has **Use the
campaign's brand** (asked once: it is live at once, and the look is kept).

A public shift is listed by its kind (`shared/shiftkinds.js`): an Event
under `events` only, any other kind under `shifts` only — a 6:30 am Burma
Shave is not the home page's "Next event". A shift made before kinds has
none and is in both, as it always was. Each list is its own two dozen.
`lat`/`lng` are the pin of the shift's saved place (a point picked on the
map), null for words alone: a card with a pin links to a map. A point
nobody has named has no words (`location` is `''`, never its
coordinates): its card's link says "See the map".

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
site.org          { name, short_name?, email, phone, address, agentName?, agentContact?,
                  authorization (the old "Authorized by …" line), privacy_url, time_zone?, platformUrl?,
                  platformLabel? (a link after the footer's links) }
site.social       [{ name, handle, url, cta? }]   (or { accounts: [...] })
page              { id, slug, title, description, modules }  — the published (or draft)
                  content with the row's id and slug; a site_pages row as it is
                  ({ …, draft, published }) works too, the draft when ctx.preview
post              { slug, title, excerpt, body (Markdown), image: { url, alt }, published_at }
campaign          { id, slug, kind, title, excerpt, body (Markdown), statement, goal,
                  count?, status }  — count, else data.campaigns[id].count, else
                  data.counts.signatures[id]
data.shifts       the Volunteer openings module lists these (the loaders always give
                  them); left out by another caller, it lists data.events
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
- `sent` — the `?sent=<kind>` value (or `{ kind, module_id }`, and `shift` for
  a sign-up): that kind's form shows its thank-you instead.
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
  `America/Vancouver` — written on the clock the app keeps
  (`shared/dayparts.js`: B.C. on UTC−7 by rule), so a server with old
  time-zone data still says a 6:30 shift starts at 6:30.

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

## Languages (`server/ext/site/translate.js`, `shared/site/languages.js`)

Every page of every website can be read in **English · ਪੰਜਾਬੀ · 简体 · 繁體**:
a switch at the very top (after the skip link) links the same page in each
offered language. A language lives under its own prefix — `/pa/…`, `/zh/…`,
`/zh-hant/…` on a site's domain, `/site/pa/…` and `/site/sites/<key>/pa/…`
on the app's address — and every link and form on its pages stays under it.
`robots.txt`, `sitemap.xml`, `/preferences`, `/unsubscribe` and previews
answer the 404 under a prefix.

- **Offered** when all hold: `languages.on` has it (a manager's choice;
  Chinese turns on both scripts); the agent's name is set; its
  "Authorized by" is approved by a manager and still the code's English;
  its first essential translation is done (`site_language_state.ready_at`).
  A language not offered sends its pages to English (302, no-store) and
  refuses its form posts.
- **Made ahead of time.** A publish (or a settings, post, petition, website,
  shift or candidate write) queues one sweep per 30 seconds; one sweep runs
  per campaign at a time, sends only new English segments (a heading, a
  paragraph, a Markdown block — `shared/site/segments.js`) to Google Cloud
  Translation in batches outside any transaction, and writes each answer by
  an action (`site.translations.machine`, one event per batch). Traditional
  is converted from Simplified on the server (opencc, Taiwan character
  forms; its dictionary loads the first time Traditional is made, never
  at start-up). A segment that won't come back whole is tried again after an hour
  and six hours, then not again. The month's characters are reserved before
  each call (`site_translate_usage`, default 450,000).
- **Drawn like English.** A page looks its words up in a per-language memo
  (reloaded only when the language's `rev` moves); a missing segment shows
  in English with `lang="en"` on its element. Fixed words are
  `shared/site/ui-words.js` keys (`rc.w`); islands get theirs in their
  props. Names are drawn as written, with a manager's approved rendering
  beside them. A page (`site.page.save` `check_first`) or another website
  (`site.microsite.save` `check_first`) set to "Show translated only after
  a person checks it" shows every unchecked sentence in English; petition
  statements, the donate notes and quotes always do. Another website's read
  (`GET /api/site/microsites/:id`) counts its sentences still `waiting`
  per language.
- **The words the law needs** (`LEGAL_ENGLISH` in `shared/site/wording.js`)
  are never machine words: a manager approves them per language
  (`site.legal.approve`, `site_legal_words`). The footer carries
  "Authorized by" in English and, under it, in the page's language. A key
  whose English changed since its approval shows in English (and is kept
  in English) until approved again; `server/test/legal-english.test.js`
  holds the English's hash and `docs/RELEASE-CHECKLIST.md` names changes.
- **Forms keep what was shown.** A form on a translated page carries
  `legal_v` (the approval and the release's legal English) and a petition
  `statement_v` (the statement's version); the server keeps those exact
  words with their language — `consent_events.lang` and `wording_en`,
  `site_actions.lang`, a signature's `statement_shown`, a declaration as
  `{ text, lang, english }` — or answers "This page changed — please
  reload it and send again". The language comes from the address, never the
  body.
- **Remembered.** A language page sets `site_lang` (never on a prefetch);
  only the home page `/` redirects to it (not with a query: a translated
  home page's "Read it in English" carries `?en=1`); English's `?lang=en`
  forgets it. A language not offered sends its addresses to the English
  page on the same site (`//other.host` after the prefix is a path there).
  `/preferences` and `/unsubscribe` follow `?lang=` or the cookie.
- Search engines see a language only when a manager turns on its listing
  (`languages.index`): until then its pages say `noindex` and the
  alternates and sitemap leave it out.
- Ladders: a website trigger may name a language (`trigger_lang`).
- **Website → Languages** (the desk; `language-reads.js`,
  `language-actions.js`, `web/src/pages/WebsiteLanguages.jsx`). One row
  per language with its chip (On · Getting ready · Off · Needs approval ·
  English changed) and counts, and the month's characters. A language:
  **Turn on** (a manager; with the estimate of what its first translation
  sends), the checklist while it gets ready, the sentences (To check ·
  Suggested · Couldn't translate · Edited · All; To check also holds a
  person's words whose Simplified changed or that now hold a kept name),
  Recent edits with Undo, the names kept as written (with possible names
  to keep), and **Preview** (before the language is offered, a half-hour
  link to the home page's draft in it; for someone with only Website
  translations, the published home page, never the draft). **Words the
  law needs** shows each key's English and the approved words or a
  labelled draft; a manager approves them all at once. Reads:
  `GET /api/site/languages` and `/api/site/languages/:code/{estimate,
  sentences,edits,legal,preview}`. History says a gift declared on a
  translated page ("Declared in ਪੰਜਾਬੀ: … · English: …") and a signature's
  statement as signed. Writes: `site.translation.save` (live at once,
  unchecked, for someone with the Website; a suggestion for someone with
  only **Website translations**, `site_words`), `site.translation.approve`,
  `.decline`, `.check` (never one's own words; a petition's statement
  needs a manager, wherever else its words also appear), `.undo` (the
  Website's: exactly the version the undone one replaced,
  `site_translation_versions.replaced_id`; Traditional back to a
  conversion is converted again from today's Simplified),
  `site.names.keep`, `site.translate.now` (on the event log). Turning a
  language on or off, search listing, the limit and older posts are
  `site.settings.save`, a manager's; a languages save changes only the
  keys it names.

## Fonts (`shared/site/fonts.js`, `server/ext/site/fonts.js`)

A theme's `fonts.heading` / `fonts.body` is a face base.win ships (`inter`,
`montserrat`, `barlow-condensed`, `system`, `serif`, and the twelve
pairings' faces: `space-grotesk`, `oswald`, `source-sans-3`,
`archivo-black`, `archivo`, `dm-serif-display`, `dm-sans`, `fraunces`,
`playfair-display`, `merriweather`, `lato`, `nunito`, `nunito-sans`) or a
Google font the campaign added, `g:<slug>`.

- **Adding one**: `site.font.add { family }` (managers, the `site` area)
  fetches it first, outside the write (`before`; `server/lib/outside.js`
  refuses any outside call inside a write), keeps latin and latin-ext only
  (≤ 8 files, ≤ 300 KB each, ≤ 900 KB in all, woff2, from
  fonts.gstatic.com only), then one write: `site_fonts` (the row, faces with
  their SHA-256) and `site_font_files` (the bytes, as Google served them).
  Six added fonts at most, counted again inside the write. Adding one twice
  answers the same row.
- **Removing**: `site.font.remove { slug }` is refused (409) while the main
  site, another website or the campaign's brand uses it, naming where;
  `site.font.restore` is its Undo. `GET /api/site/fonts` lists the added
  fonts with `used`, `notUsed` and, for a font whose files are missing (an
  export brought back), `refetch` (`waiting`, `failed`).
- **The rules** (`checkTheme` with the campaign's `added` fonts): body text
  only in a face checked for long reading (`scripts/google-fonts-body-safe.txt`,
  65 families; the built-in heading faces Archivo Black, Oswald, DM Serif
  Display, Playfair Display, Barlow Condensed and Fraunces are for headings
  only); a first visit's fonts (the body's regular file and the heading's
  file, the two the page preloads; on `/pa` the body's and Gurmukhi) over
  150 KB are refused, over 100 KB saved with a note. Each pairing is at most
  100 KB (unit test from the files).
- **Drawing**: the head carries `@font-face` rules for added fonts at
  `{site root}site-assets/fonts/g/<sha256>.woff2` (no language prefix; the
  route answers under `/pa`, `/zh`, `/zh-hant` too, only for the site's own
  campaign, `immutable`). Every stack carries `'Noto Sans Gurmukhi'` and
  TR's `var(--cjk, …)`. Headings are drawn through `--heading-weight`,
  `--heading-tracking`, `--heading-leading`, `--heading-case` (and the
  wordmark's, a petition title's and the rail's), written from the heading
  face's profile; the built-in faces keep exactly their old values.
- **Licences**: `{site root}site-assets/fonts/licences` (linked from
  nowhere) lists the site's fonts with their licence and repository link,
  and the bundled licence texts (`shared/site/fonts/LICENCES/`).
- **The desk** loads faces with the FontFace API from the site's files and
  `GET /api/site/fonts/file/<sha>.woff2` (signed in); a font not added yet
  is previewed through `GET /api/site/fonts/sample` (the server asks Google
  for just those letters; 120 a minute per person). Settings → Brand's
  heading face may be an added font (`brand.save` keeps its files' hashes,
  `headingFace`).

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
org           { name, shortName, email, phone, address, platformUrl, platformLabel, privacyUrl,
                agentName, agentContact, authorizationLine (drawn only while no agent is named) }
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
`shared/site/*.css` and fonts, and — only on the server of a campaign whose
set-up brings its own (Imagine Surrey's pictures and `look.css` under
`imagine-surrey/`, from `server/presets/imagine-surrey/assets/site/`; 404
on every other server) — that campaign's pictures; and the islands' build —
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
`donate` with what is being paid and who after it
(`<kind>:<key>:<amount>-<cadence>-<slate>:<who>`,
`<kind>:<key>:<amount>-<term>:<who>`; `<who>` a short hash of the details
typed — email, phone digits, first and last name, postal code, address,
city, and for a join the birth date and citizenship — case and spaces
aside), so the same key with another amount (back from Stripe's page, a
new choice), or with other details (a typo put right after a failed send,
the next person at a shared tablet), is a fresh action and checkout, never
the old one; sent again as it was (a double tap, a lost answer), it is the
same. The browser also makes a new key once a form is answered, when a
field changes after a send that didn't get through (no answer, or a 5xx),
and when a page comes back from the back/forward cache.

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
gave. So one donor can be two records; the year's limit still adds them up
when the money lands ("Payments readiness" below). A join keeps its birth
date and citizenship only where the profile has none.

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
answer. Stripe refusing the email they typed: a 400 on `email`, in plain
words. A retry — the same `client_key`, amount and details — finds that
action, makes its checkout ready again (`retryCheckout`: the same request
and key while Stripe may have made the page, else a fresh expiry under a
new key) and does steps 2 and 3 for it — one action, one checkout, never a
second; two at once (a double tap) get the same page. Once answered, a
retry hears the answer kept. The same key with other details is a new
form: its own person, action and checkout.

Before checkout the site refuses only what no one may give (over the
year's limit once, or over the monthly maximum): a person's own total is
checked when the money lands (and refunded if over), so the form never
says what someone gave before. Under the limit on its own, the payment is
also added to what the records that may be the same donor gave this year
on that slate — the same first and last name, and the same postal code,
phone or street address (another email, a cheque at the desk on their
voter record), never a pair the desk marked Not the same — and never two
records marked Not the same as each other (the donor is one of them at
most; the most they can be together counts): over together,
the gift is logged and flagged for the treasurer ("Possibly the same donor
as …", Donations → Needs you), never refunded — the other record may be
someone else. Every gift logged under the limit is added up the same way
(lib/gifts.js, the `underLimit` hook), so a cheque at the desk on the voter
record after the gift online is flagged too. A postal code is compared by
its letters and digits (V3T-2C3 is V3T 2C3), and one typed with a hyphen
is kept as V3T 2C3. People → Duplicates lists a donor and the same first
and last name in one postal code as a pair too, to merge or keep apart.
*Not the same person* on the flagged gift — one choice for each record it
names ("Not Aman Gill (same phone)"; two that still read the same get
*Compare in Duplicates* instead, which opens the pairs with that donor's
record and with the records its flag names) — or *Not the same* there
keeps that one pair apart and adds
the gift up again without it: the flag goes, or names what is left (over
on its own record, the plain over-limit reason).
A gift that leaves the books (voided, refunded, a dispute lost) is taken
out of every maybe that added it up the same way, and one restored (the
desk's Undo) counts in them again — a maybe its void cleared comes back,
as things stand (over on its own record now, the plain reason, as every
gift of a donor's year over the limit is flagged). A new gift adds up the
maybes on its donor, or naming them, again too (that year and slate's); a
maybe that names neither keeps its total until something it names changes
(its row then may show less over than the new gift's, which is right). A
maybe that reads over on its donor's own record keeps the
records it named (`attrs.maybe_same_donor_was`): if the gift that took it
over is undone, voided or refunded, it is a maybe again, never stuck over.
A merge keeps the dropped record's Not the same rulings, and says so when
it clears a maybe with a record only the dropped one matched, naming it by
what it shared (its phone, address or postal code) with a link to it.

## Admin API

Signed in, the `site` area ("Website": managers by default; a manager may
grant it under Admin → Permissions); everyone else gets 403 on every read
and write. Reads (the first one makes the campaign's first site: the
generic one in `seeds/base.js`, or its own where its set-up brings one).
`GET /api/site` also sends `skins` (the looks Theme offers: Base, and the
campaign's own if it has one), `moduleDefaults` (its own starting words for
a new section) and `fieldLabels`; for most campaigns these are Base alone
and two empty objects. The *Become a member* section and its `join` form
are only for a campaign with a membership: for any other the section is
not offered and draws nothing, and the form answers 404:

| | |
|---|---|
| `GET /api/site` | `{ settings, pages: [page without draft/published], counts: { pages, published, posts, posts_published, campaigns, campaigns_open, actions, actions_week }, urls: { site, domains } }` |
| `GET /api/site/pages/:id` | `{ page: { id, slug, title, description, status, version, show_in_nav, nav_order, published_at, created_at, updated_at, changed, modules (count), draft, published } }` |
| `GET /api/site/posts` · `/:id` | `{ posts: [{ id, slug, title, excerpt, image, status, published_at, … }] }` · `{ post: { …, body } }` |
| `GET /api/site/campaigns` · `/:id` | `{ campaigns: [{ id, slug, kind, title, excerpt, statement, goal, status, signatures, … }] }` · `{ campaign: { …, body } }` |
| `GET /api/site/pictures` | `{ pictures: [{ id, url, name, width, height, bytes, created_at, sizes? }] }` (Outreach's store too; not the brand's pictures, not a picture's copies) |
| `POST /api/site/preview-token` | `{ pageId }` → `{ url, expires_at }`: the draft for 30 minutes, `noindex`, frameable by the app only |

Writes are actions (`POST /api/actions/:name`):

| action | input → answer |
|---|---|
| `site.settings.save` | `{ theme?, nav?, footer?, announcement?, seo?, org?, social?, domains? }` — each section sent replaces it (a theme without `follow` keeps following as it was) → `{ saved, updated_at }` |
| `site.page.create` | `{ title, slug?, description?, modules?, show_in_nav? }` → `{ page }` (a draft; slug from the title when not given) |
| `site.page.save` | `{ id, title?, slug?, description?, image?, modules?, show_in_nav?, nav_order?, updated_at? }` → `{ page }` (the draft, `checkModules` loose; `image`: the share picture, below; `updated_at` as opened: someone else's save since → 409) |
| `site.page.publish` | `{ id }` → `{ page }` (`checkModules` strict, and the petitions it shows must exist; the error names the module) |
| `site.page.unpublish` · `delete` · `duplicate` | `{ id }` (home stays) · → `{ page }` for duplicate |
| `site.page.reorder` | `{ ids }` — the menu order |
| `site.post.save` · `publish` · `delete` | `{ id?, title, slug?, excerpt?, body?, image? }` → `{ post }` · `{ id, published? = true }` · `{ id }` |
| `site.campaign.save` · `close` · `delete` | `{ id?, kind, title, slug?, excerpt?, body?, statement?, goal? }` → `{ campaign }` · `{ id, open? }` · `{ id }` |
| `site.picture` | `{ data (base64 or data: URL), name?, width?, height?, sizes?: [{ data, width, height }] }` → `{ media: { id, url: '/media/:id', sizes?: [{ url, w }] } }` (JPG/PNG/WebP, 2 MB; up to 3 smaller copies, JPG or WebP, 600 KB each) |
| `shift.public` | `{ id, public }` — the desk (Shifts area): the shift on the site — with the events or the volunteer openings, by its kind |

Slugs: lowercase a–z, 0–9 and dashes; never `news`, `act`, `r`,
`preferences`, `unsubscribe`, `api`, `site-assets`, `__preview`,
`sitemap.xml`, `robots.txt`, `media`, `stripe`, `site` (and `home` is the
home page's). Every Website write clears the campaign's cached pages —
and what a request reads before the cache answers (the campaign, the
website settings, a live page by its address), so a kept page costs the
database nothing; a page drawn across a Website write is never kept, and
visitors after the write wait for a fresh draw, not the older one.

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
- Other websites (`microsite-reads.js`; counts, never people — the money
  forms counted only for someone who can open Donations):
  `GET /api/site/microsites` → `{ microsites: [{ …, signups_7, signups_30,
  home }], closed, limit }`; `GET /api/site/microsites/:id` → `{ microsite,
  deleted, pages, home, checklist, signups_7, signups_30, sources: [{ source,
  n }] (top 8, 30 days, none → "direct"), render_host, urls, brand_theme }`;
  `GET /api/site/microsites/host?host=&id=` → `{ host, why }`, the domain
  save's own refusal. `GET /api/site` adds `counts.microsites` and
  `counts.microsites_live`; a page carries `site_id`.

## The Website screens (`web/src/pages/Website*.jsx`)

The `site` area; the desk's menu has **Website** (App.jsx guards
`/website…` by the area; a volunteer without it is told the admin isn't
theirs, and the server refuses its data anyway).

| Address | Screen |
|---|---|
| `/website` | Overview: live or not, where it lives, "View site", this week's sign-ups by kind, pages ("Edit the home page"), news, petitions, online giving |
| `/website/pages` | Pages in the menu's order: New page ("What's this page for?": a starter, a name and its address), In the menu, ⋯ Move up/down · Duplicate · Delete (Undo); drag by the handle or tap it and "Move here" |
| `/website/pages/:id` | The builder (below) |
| `/website/theme` | A skin, the colours (every `PAIRS` pair's contrast as it changes; under 4.5:1 blocks saving; "Fix it" picks the nearest readable text colour), fonts, corners, logo, a live sample |
| `/website/settings` | Menu and title bar, announcement bar, footer, organization, social accounts, search and sharing, your own domain |
| `/website/news` · `/:id` | Posts: list, editor (picture, the words beside the post as it will look, short summary), publish/unpublish, delete (Undo) |
| `/website/petitions` · `/:id` | Petitions and pledges: signatures and a bar to the goal, "See who signed" (People by `signers_tag`), editor, close/open again, delete (Undo) |
| `/website/sites` | Other websites: each one's name, Live / Draft, domain and sign-ups this week; New website (a manager: a name and, optionally, the address — checked as it's typed in the save's words); deleted ones whose address still says it has closed |
| `/website/sites/:siteId` | One of them: Go live (a draft; a manager) or View site; while a draft, the checklist (home published, Authorized by, privacy link, address), each a tick or a link to fix it; sign-ups for 7 or 30 days and where they came from (30 days), "See everyone from this site" (`/people?web=site:<id>`); Pages · Look · Domain; ⋯ (a manager) Rename, Take offline, Delete (Undo), Release old address |
| `/website/sites/:siteId/pages` · `/look` | Today's Pages and Theme with the site passed in (its own pages; its own look, saved with `site.microsite.save`, "Start from the campaign's brand" copies the brand's once); the builder says "On <site>" and previews and views it at the site's address |
| `/website/sites/:siteId/domain` | The address (the `www.` is added), then — only once it's saved — the three steps in the safe order (buy it; add it in Render; the registrar's DNS records, pointing `www` at `RENDER_EXTERNAL_HOSTNAME`), each with Copy, and "Open https://…" |

### The builder (WA stage 2a, `web/src/components/site/builder/`)

- **Starters** (`shared/site/starters.js`): An issue, An event, A
  petition, About us, Contact (Follow along only when Settings has social
  accounts), Get involved, Blank. Every word a starter adds beyond the
  catalogue's defaults is in `PLACEHOLDERS` (`shared/site/placeholders.js`),
  with the catalogue's own hero sample. A draft may hold them; the
  catalogue's strict check (Publish) refuses a box still holding one —
  "still has the sample words" — and the builder opens that box. A seed's
  placeholders go live as made (`checkModules(…, { samples: false })`); its
  next Publish asks for real words. A new page opens on its first sample box.
- **The page itself**: a top bar (← Pages, the title edited in place — a
  page never published takes its address from it — Draft · Published ·
  Published, with changes, "Saved 2:14 pm", Undo, Redo, Phone / Computer,
  Preview in a new tab, ⋯ Page settings · View on the site · Duplicate ·
  Take it off the site · Delete, and Publish); a 440 px column with the
  sections as cards (handle, drawing, name, first words, ⋯ Hide ·
  Duplicate · Move up · Move down · Delete; a + between every two) or the
  open section's form; the live preview filling the rest at 1,100 px and
  wider (Show preview at 720–1,099 px; under 720 px Preview opens it full
  screen). Add a section is a gallery of drawings (`thumbs.jsx`) with a
  search box, Most used first; the voter guide shows "Already on this
  page" once there is one.
- **Undo and Redo** (`history.js`): this visit's changes, 100 steps,
  typing in one box one step a second; Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z,
  Ctrl+Y. An undo is a change: it autosaves.
- **The live preview**: the builder frames `/__preview/:id?…&edit=1`. A
  draft's English preview carries the renderer's inputs as
  `<script type="application/json" id="wa-rc">` and loads
  `site-assets/site-preview.js` (`web/src/site-preview.js`, built as its
  own file like the islands). The builder posts `{ type: 'wa:modules' }`
  at most every 100 ms; the script calls the same `renderContext` and
  components (`shared/site/components/preview.js drawBody`) and swaps only
  the sections whose markup changed — before the autosave. A section
  pointing at a petition the frame's data doesn't hold (`needsReload`,
  `context.js`) shows "Updating preview…" and the frame is drawn again once
  the autosave lands. Messages go only between the builder and its frame,
  on one origin.
- **Tap to edit**: with `edit=1` each section carries
  `data-wa-section="<id>"` (the server marks them) and the script marks
  each headline, paragraph, button and picture with `data-wa-field`
  (`items.2.title`) by matching the section's own words; a tap posts
  `{ type: 'wa:pick', section, field }` and the builder opens that box with
  the cursor in it (on a phone, in a sheet with Done). Links and forms in
  the frame do nothing. Never on a public page or a translated preview.

### Pictures and posts (WA stage 2b)

- **Sizes.** The desk uploads a section's or a post's picture with copies
  480, 960 and 1,600 px wide (never wider than the picture), made on a
  canvas (`brand-pictures.js pictureCopies`): WebP at 0.82, or JPEG at 0.82
  when the browser hands back something else (Safari gives a PNG). The
  copies are `media` rows of their own (`size_of` names the picture; the
  picture list leaves them out and lists them with their picture). The
  image field's value is `{ url, alt, width?, height?, sizes?: [{ url, w }],
  focus?: { x, y }, decorative? }`; `sizes` are only `/media/:id`, at most 3;
  `focus` whole numbers 0–100 (the middle is left out).
- **Drawing.** `Img` writes a `srcset` from the copies and the picture
  itself, with each place's `sizes` (hero `(min-width: 900px) 50vw, 100vw`,
  news card `(min-width: 720px) 33vw, 100vw`, post `min(100vw, 760px)`),
  `object-position` from `focus`, `alt=""` when decorative. The first
  section's picture (and a post's) is fetched first (`fetchpriority`); the
  rest are lazy. A picture without copies draws as before.
- **Descriptions** (`shared/site/pictures.js`). Publish refuses a picture
  added or replaced since the last publish — its address is nowhere in
  what was published — that has no description and isn't ticked
  *Decorative*: image fields and Markdown `![words](url)` (empty words, or
  the toolbar's own "picture", count as none) in pages and posts. The
  builder finds it before sending and opens its box. One already on the
  site without words doesn't block: `site.page.publish` answers
  `undescribed: <n>` and the toast says "1 older picture has no
  description. **Describe them**". A post is checked as it goes on the
  site, and a published post as it's saved (a save changes it live).
- **The post editor**: the words in the body font at 17 px beside the post
  as it will look (≥ 1,100 px; *Write · See it* below that), drawn by
  `shared/markdown.js`. The short summary follows the first 160 characters
  of the words (`summaryFrom`) until someone types in it.

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
whoever runs the server adds it to `SITE_HOSTS`. `GET /api/site` lists
those as `urls.used_hosts` (`{ host, why }`, the newest 200; none if the
read fails), and the screen refuses them as they're typed, in the save's
own words. So the screen says to add the domain first (and its `www.`
name, if that will point here too), then point its DNS here: the site
answers there from the first request, and nobody signs in there before it
does.


## The voter guide (`server/ext/voteguide`, VG)

One guide per campaign for the next vote, kept under Website → Voter guide
and shown by the **Voter guide** module (`voterguide`, at most one per
page). It ships empty: no dates, places, rules or names of its own.

- **Tables:** `vote_guide` (state, the office's link, the campaign's rules
  and ballot note, the checks, `rev`), `vote_days` (`'HH:MM'` hours),
  `vote_place_info` beside a `places` row with `kind = 'voting'` (the same
  list as Shifts and GOTV; `closed_on` closes a place for that one day),
  `vote_contests`.
- **Actions:** `site.guide.*` are Website actions; publish, unpublish, clear
  and the embed addresses are a manager's. Publish is refused for the first
  missing item of the checklist (days, election day, a day still ahead,
  places, "vote anywhere?", the office's link, the two checks, the
  authorization line, and the ballot and rules checks when there are any).
  "Also use these days for GOTV mode" writes `voted_settings` through
  `saveVotingDays` (ext/voted). In a published guide, Shifts can't rename
  or remove a guide place (409).
- **Import:** `POST /api/site/guide/import/preview { text }` reads a pasted
  sheet, a CSV or "name, address" lines, looks new addresses up outside any
  transaction (4 at a time, inside the campaign's box + 10 km) and signs the
  rows; `site.guide.places.import` saves them as signed (30 minutes). A
  place typed by hand is looked up the same way before its save
  (`POST /api/site/guide/place/lookup { address, city }` → `{ lat, lng }`
  or `{ none }`; the save carries `looked_up: true`), and the Places card
  counts the places still not on the map.
- **States** by the server's clock (`server/lib/clock.js`) and B.C.'s rule
  (`server/lib/tzrule.js`): not out (also a draft outside a preview: a
  "Tell me when it's out" sign-up with source `voter-guide`, People
  `web=guide`), before, open, between, over. The island corrects its clock
  from `<root>/api/guide/clock` and re-draws at each boundary.
- **Banner:** on every page from a week before the first day until the last
  close, after the language switch and before the announcement; not on the
  guide's page, the embed or plain pages.
- **Cache:** a page drawn while the guide is published expires at the
  guide's next boundary; `?area=`/`?day=` are part of the key only when
  they are the guide's own values; `?q=` is never kept; `?near=` is the
  island's alone. Pages holding the module send `geolocation=(self)`.
- **Words for days and hours** are drawn on the server (full ICU) and sent
  in the island's props (`dateWords`), so a browser without, say, Punjabi
  dates hydrates to the same text. A guide that is a page's first module
  is the page's title (no page banner above it).
- **Address lookup:** `POST <root>/api/guide/find { address }` → a pin to 3
  decimals; nothing is stored or logged; 30 a minute per address, 300 a
  minute per campaign.
- **Embed:** `<root>/embed/voter-guide`, framed only by the saved addresses
  (`frame-ancestors`, no `X-Frame-Options`), never cached, with the
  authorization line; `site-assets/embed.js` sets the frame's height.
- **Field read:** `GET /api/guide?rev=&tag=` (every role; `{ same: true }`
  when neither the guide nor its links changed — `tag` names the links, so
  a guide page published or a language approved since reaches the phone;
  `?draft=1` for the Website area, `draft: true` only when it served one).
- **The desk:** Website → Voter guide (`/website/guide`): the checklist,
  then cards for days, places (typed, or pasted and previewed, "Closed
  today" with its note, a pin put by hand), the ballot (the slate's names
  ticked Ours by themselves), what to bring and the office's link; More
  holds the mail and ride lines, the banner switch, the guide page (Add
  the guide page while no page holds the module; then a link to it in the
  builder, draft or not), the
  embed snippet, "See it as a canvasser", Unpublish and Clear. One primary
  button: Publish (a manager) or View guide (live).
- **The field:** "Where to vote" (`/vote-info`) from Today (while the guide
  is out and GOTV is on or the first day is two weeks off), a door card's
  and a walk-list door's More. The door travels in router state only and
  leaves the history entry once read; the screen opens at the top. Nearest
  three with Directions (without a door, Show the voter first and every
  place under All voting places); Our names on the ballot lists only ours;
  within 150 m of an open place a warning, no QR and no names; "Show the
  voter" draws a QR code on the phone (`shared/qr.js`) with `?near=` at 2
  decimals, in the person's language when their Language field says
  Punjabi, Mandarin or Cantonese (the walk list's row carries it as
  `guide_lang`, only where volunteers may see the field — nothing about the
  person is asked for on the way). The read is kept on the phone for every
  role.
