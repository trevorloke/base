# Going live

The order to do things in, once per client, before the team signs in. Each
step says where it happens and how to tell it worked. The longer
explanations are in [TESTING.md](TESTING.md) (deploying, what to test by
role) and [README.md](README.md) (how each part works).

## 0 · Two environments, one branch each

Every client has a **staging** and a **production** environment, each its
own Render web service and Postgres database:

| Environment | Deploys | Address | Who uses it |
|---|---|---|---|
| staging | every push to `main`, by itself | `https://starbase-staging.onrender.com` (or a `staging.` host) | you, to try a change before anyone else sees it; it says *Staging* on every screen |
| production | the `production` branch | the campaign's address | the campaign |

**Pushing staging to production.** GitHub → **Actions** → *Promote to
production* → **Run workflow**. It fast-forwards `production` to what `main`
is now (or to a commit you name), refuses while CI is red on that commit,
and never rewrites production; Render then deploys it. Staging and
production share nothing: test on staging with sample data or a copy, then
promote the code — the production database is the campaign's alone.

## 1 · Deploy

1. Render → **New → Blueprint** → this repo, `main`. `render.yaml` creates
   `starbase-staging` (from `main`) and `starbase` (from `production`), each
   with its own database.
2. Wait for the first deploy, then open
   `https://<service>.onrender.com/api/health`. It answers
   `{"ok":true,"service":"starbase","env":"staging","organization":"Imagine Surrey","tzdataCurrent":true}`.
   `tzdataCurrent: false` means the server's time-zone rules predate B.C.'s
   permanent UTC-7 (every time after 1 Nov 2026 would show an hour off):
   redeploy on a newer Node image before going further.

## 2 · Domains

| Host | What it serves | Where |
|---|---|---|
| `starbase.imaginesurrey.ca` (and `base.win/imaginesurrey` through the door, apps/door/README.md) | the staff and volunteer app, and the public forms | Render → Settings → Custom Domains |
| `imaginesurrey.ca`, `www.imaginesurrey.ca`, once the campaign moves its website onto base.win | the website made under **Website** in the admin, at `/`; nothing of the app answers there | Render → Settings → Custom Domains, then `SITE_HOSTS` (below) |

Add the DNS records Render shows; it issues the certificates.

The website made under **Website** is live from the first deploy at the
app's own address, under `/site/` (`base.win/imaginesurrey/site/` through
the door), so it can be checked before any DNS moves (SITE.md). To put it
on the campaign's own domain, in this order:

1. Add the domain, and its `www.` name, to the service in Render.
2. Set `SITE_HOSTS=imaginesurrey.ca,www.imaginesurrey.ca` (or a manager
   adds both under Website → Settings → *Your own domain*).
3. Only then point their DNS at Render. Done the other way round, the app
   answers there until step 2, and an address someone signed in at can't
   be made the website's from the screen (SITE.md).

Until then the campaign's present site keeps `imaginesurrey.ca`; its
server can send sign-ups in with a website key from Settings → Services
(INTEGRATIONS.md, *The campaign's website*: the fields, the answers, an
example).

## 3 · Settings (Render → the service → Environment)

Set these on both environments before the first sign-in; the rest can wait.
Every outside service, its settings and where each key comes from is in
[INTEGRATIONS.md](INTEGRATIONS.md). The campaign's own values
(`STARBASE_ORG_NAME`, `_JURISDICTION`, `_TZ`, `_CITY`, `_SLATES`) are in
`render.yaml` already; change them there for another client. So is the
look: staging is `STARBASE_BRAND=base` with the name *Demo Campaign*, so it
can be shown to anyone; production is `imagine-surrey`. A campaign already
set up keeps the name it was given: a manager renames it in **Settings →
Campaign**.
`STARBASE_CANDIDATES` is not: until it's set, a new rating scale starts with
the candidates the code ships with (`shared/scale.js`).

| Variable | Set it to | Needed for |
|---|---|---|
| `STARBASE_ENV` | `staging` on the staging service, `production` on production (set by `render.yaml`) | the *Staging* badge; `/api/health` |
| `STARBASE_ORG_NAME`, `STARBASE_JURISDICTION`, `STARBASE_TZ`, `STARBASE_CITY`, `STARBASE_SLATES`, `STARBASE_CANDIDATES` | the campaign (README → *One deployment per client*) | the name the first sign-up sets up, the contribution rules, the campaign's day, addresses, the slates a gift can go to, the rating scale's first candidates |
| `STARBASE_PUBLIC_URL` | `https://starbase.imaginesurrey.ca` (staging: its own address) | every link in an email: invites, unsubscribe, receipts |
| `RESEND_API_KEY`, `MAIL_FROM` | from Resend; `Imagine Surrey <team@imaginesurrey.ca>` on a domain verified there | email; without it invites are shown to copy and sends wait as *queued* |
| `STARBASE_TWO_STEP_KEY` | 32 or more random characters (`openssl rand -base64 32`), a different one per environment | two-step sign-in's keys sealed with a key the database doesn't hold (INTEGRATIONS.md) |

Then, as each one is ready:

| Variable | Set it to | Needed for |
|---|---|---|
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | from Twilio | texting and calling through the campaign's number, SMS shift alerts; without them the phone's own apps are used |
| `GEOCODER` | leave unset (`bc`, the free BC Address Geocoder); `GEOCODER_FALLBACK=google` to ask Google only for addresses BC can't place | placing people on the map |
| `GOOGLE_MAPS_SERVER_KEY` | a Google Cloud key restricted to the server's IP with only the APIs used enabled (Geocoding; Map Tiles for `GOOGLE_MAPS_TILES=1`) | Google geocoding and Google Maps tiles |
| `GOOGLE_MAPS_TILES` | `1` to draw the field map on Google's tiles (`GOOGLE_MAPS_TILE_TYPE` roadmap, satellite or terrain); otherwise OpenStreetMap, which is not for a large team in election week | the map's background |
| `STARBASE_TRUSTED_PROXIES` | leave unset on Render (one proxy). Set to the number of proxies in front if there is a CDN before Render | rate limits reading the right address |
| `BASE_DOOR_KEY` | behind the base.win door only: the same 32 or more random characters (`openssl rand -base64 32`) as the door's `BASE_DOOR_KEY` (apps/door/README.md) | each visitor through base.win keeping their own address for the sign-in and form limits — without it, everyone who comes through the door counts as one |
| `SITE_HOSTS` | the campaign's own domains, once the website moves onto base.win (`imaginesurrey.ca,www.imaginesurrey.ca`; §2) | the website at `/` there, nothing of the app (SITE.md) |
| `APP_HOSTS` | the app's other addresses on this server, comma-separated: once `STARBASE_PUBLIC_URL` is base.win, the one people used before (`starbase.imaginesurrey.ca`); never the website's own domain | the app keeps answering there: none of them can be made the website's domain |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | from Stripe: **test** keys on staging first; **live** keys on production only once a test gift has gone all the way through | gifts and membership dues paid online on the website (INTEGRATIONS.md, *Online payments — Stripe*) |

Twilio: set the number's incoming-message webhook to
`https://starbase.imaginesurrey.ca/api/public/twilio/sms` (HTTP POST). The
other addresses Twilio calls back (delivery reports, calls) are sent with
each text and call, built from `STARBASE_PUBLIC_URL`; nothing else to set.
They answer at every address of the server, the website's own domain
included, so no domain setting can lose a STOP.

Stripe: Developers → **Webhooks** → add an endpoint at
`https://starbase.imaginesurrey.ca/stripe/webhook` (Settings → Services
shows the exact address and the ten events to tick) and put its signing
secret in `STRIPE_WEBHOOK_SECRET`. The keys go in the host's environment
only — never in the repo, a chat or an email. Test mode first: on staging,
test keys and Stripe's test card; the desk says *Test mode* until live keys
are in.

**Check them.** After the first sign-in (below): **Settings → Services** in
the admin lists every service, says which settings are missing, and
**Check** calls each one for real — Resend's key and domain, the Twilio
number and where its replies go, the address service, Google's tiles, the
public address and the database.

## 4 · First sign-in

The first sign-in lands in the **admin** (`/admin/`); the field app at `/` is
what volunteers get, and what you see under *Field app ↗* in your account menu.

1. Open `https://starbase.imaginesurrey.ca/login` → **Set up base.win for
   Imagine Surrey** (the name `STARBASE_ORG_NAME` gives; a deployment that
   gives none asks for it here). The first account is the manager; this
   creates the campaign's workspace (its jurisdiction's rules, the
   contribution limit seeded, its time zone) and closes sign-up. Everyone
   else joins by invite. Do this on staging first, then on production.
2. **Today** shows a banner if the server's time-zone data is stale (step 1)
   so a manager can't miss it.
3. **Admin** (from the account menu, your initials): under **Members**
   invite the staff and treasurer first, volunteers later once the lists
   are in; under **Teams** group them (a crew per neighbourhood, the phone
   bank); under **Permissions** decide which areas each role, or one person,
   may use.
4. **Outreach → Connections**: the campaign's website address, which the
   public pages (unsubscribe, public lessons) link back to.

## 5 · The lists and the map

1. **People → Import**: a CSV or spreadsheet, up to 300 MB in the browser.
   Map the columns, run a dry run first (it reports matches, new people and
   anything it couldn't read), then import. The list's own columns map by
   themselves (house number and street, latitude and longitude, the 1/0
   flags, and the standard fields named after them); social handles
   (Instagram, X, TikTok, Reddit) fill blank ones only.
2. **Place on map** starts a background run; the import page and the map
   show progress and the time left, and it carries on with the page closed.
   Addresses the geocoder can't place are set aside for a pin by hand (drag
   on the map).
3. Open the map on a phone as a volunteer: tap a house, rate the door, see
   it save; turn on airplane mode, do it again, turn it off, watch it send.
4. Tell volunteers about **Show → Share my location while I'm out** on the
   map: it's off until they turn it on, and while it's on the managers'
   dashboard (Today) shows where they are. Location needs the site on
   `https` (every host in section 2 is). A position is kept only while they
   share it, a trail for the day; neither is in the export.

## 6 · A new client

Each client is its own pair of services and its own databases; nothing is
shared, and the code names no client.

1. Copy the two services and two databases in `render.yaml` under new
   names (`starbase-<client>-staging`, `starbase-<client>`, and their
   databases — names are unique per Render account), and set their
   `STARBASE_*` values: the campaign's name, jurisdiction, time zone, city,
   slates and first candidates, and `STARBASE_BRAND=base` on both (base.win's
   generic look: `imagine-surrey` is Imagine Surrey's alone). Commit that
   on `main`.
2. Render → **New → Blueprint** → this repo: Render makes the new pair.
   Put the secrets in (section 3), the domains (section 2), and run the
   first sign-in on staging, then production (section 4).
3. One `main` serves every client: a change lands on every client's
   staging at once, and *Promote to production* moves it to every
   production at once. A client that must stay on an older version is a
   second `production-<client>` branch for its production service — avoid
   it unless they ask.

## 7 · Before the public link goes out

- `https://starbase.imaginesurrey.ca/` loads over https and signs in.
- A test newsletter reaches a real inbox with a working unsubscribe link.
- A test gift logged under **Donations** gets its receipt emailed.
- Online giving, on staging in test mode: a gift once, a monthly gift and a
  membership go through Stripe's page and show under **Donations** marked
  *online*, each with its receipt; a refund from Stripe's dashboard voids its
  gift. Then live keys on production, one small real gift, and refund it.
- Backups: Render's managed Postgres keeps daily backups; **Today → Export
  all data** (managers) downloads everything (message pictures are not in it).
- Two-step sign-in: on for you (**Your profile**, from the account menu)
  and **Require two-step sign-in for desk roles** ticked under **Settings →
  Members** (it covers volunteers given an area under Permissions too);
  **Settings → Services** shows the two-step key set up.
- Keys: every key above is in Render only, never in the repo or a chat.
  Anyone who leaves the campaign is removed under **Admin → Members**, which ends their
  sign-in everywhere at once.

## What base.win does on its own

- Sign-in: 30 tries per address and 10 failures per email in 15 minutes,
  then a wait. Sessions last 30 days and end at sign-out or removal.
  Two-step codes: 20 wrong in a row (across sign-ins and restarts) lock the
  account's app codes until a recovery code or a manager's reset; the
  person and the managers are emailed and the managers' Today says so.
- Public forms: rate-limited per address; a request's body is capped.
- Email: every newsletter carries the reader's own unsubscribe link and the
  headers mail apps use for their Unsubscribe button; an unsubscribed
  address cannot be added back by the desk.
- Donations: contributions are checked against the Elections BC limit per
  contributor (confirm the seeded figure with Elections BC before filing).
- Online payments: checked against the limit before Stripe's page opens and
  again when the payment lands — one that would go over is refunded through
  Stripe by itself, the donor is told, and the treasurer sees it (after a
  dispute lost for only part of it, Stripe won't refund the rest: Needs you
  says how much to return by hand); one over only with another record that
  may be the same donor (or a cheque logged after it) is flagged for the
  treasurer to decide — *Not the same person* clears it when they are two
  people. Stripe's webhook is refused without its signature, and each event
  is done once.
