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
| staging | every push to `main`, by itself | `https://imaginesurrey.staging.base.win` | you, to try a change before anyone else sees it; it says *Staging* on every screen |
| production | the `production` branch | `https://imaginesurrey.base.win` | the campaign |

**Pushing staging to production.** GitHub → **Actions** → *Promote to
production* → **Run workflow**. It fast-forwards `production` to what `main`
is now (or to a commit you name), refuses while CI is red on that commit,
and never rewrites production; Render then deploys it. Staging and
production share nothing: test on staging with sample data or a copy, then
promote the code — the production database is the campaign's alone.

## 1 · Deploy

1. Render → **New → Blueprint** → this repo, `main`. `render.yaml` creates
   `base-ground-imaginesurrey-staging` (from `main`) and
   `base-ground-imaginesurrey` (from `production`), each with its own
   database.
2. Wait for the first deploy, then open
   `https://imaginesurrey.staging.base.win/api/health` (through the front
   door: Base Ground has no address of its own). It answers
   `{"ok":true,"service":"base-ground","env":"staging","commit":"…","tzdataCurrent":true}`
   — never the campaign's name; `commit` is the build that's live.
   `tzdataCurrent: false` means the server's time-zone rules predate B.C.'s
   permanent UTC-7 (every time after 1 Nov 2026 would show an hour off):
   redeploy on a newer Node image before going further.

## 2 · Domains

| Host | What it serves | Where |
|---|---|---|
| `imaginesurrey.base.win` (staging: `imaginesurrey.staging.base.win`) | the staff and volunteer app, and the public forms — Base Ground at the root, Base Air under `/air` | the front door (`apps/gateway`, SUITE.md *Addresses*) |

Base Ground is a Render private service: it has no public address, and
every request reaches it through the front door, which serves the client's
subdomain and passes the path on as it is. Nothing to add on Base Ground's
own service; the front door's domains are set on the front door. The
campaign's website (`imaginesurrey.ca`) is its own thing, hosted apart; it
links to Base Ground's public pages, and its server sends sign-ups in with a
website key from Settings → Services (INTEGRATIONS.md, *The campaign's
website*: the fields, the answers, an example).

## 3 · Settings (Render → the service → Environment)

Set these on both environments before the first sign-in; the rest can wait.
Every outside service, its settings and where each key comes from is in
[INTEGRATIONS.md](INTEGRATIONS.md). The campaign's own values
(`BASE_ORG_NAME`, `_JURISDICTION`, `_TZ`, `_CITY`, `_SLATES`) are in
`render.yaml` already; change them there for another client.
`BASE_CANDIDATES` is not: until it's set, a new rating scale starts with
the candidates the code ships with (`shared/scale.js`).

| Variable | Set it to | Needed for |
|---|---|---|
| `BASE_ENV` | `staging` on the staging service, `production` on production (set by `render.yaml`) | the *Staging* badge; `/api/health` |
| `BASE_ORG_NAME`, `BASE_JURISDICTION`, `BASE_TZ`, `BASE_CITY`, `BASE_SLATES`, `BASE_CANDIDATES` | the campaign (README → *One deployment per client*) | the name on sign-in, the contribution rules, the campaign's day, addresses, the slates a gift can go to, the rating scale's first candidates |
| `BASE_PATH` | leave unset on base.win: Base Ground runs at the root of the client's subdomain (SUITE.md). Only for a deployment that puts it under a path (`/ground`, say) | where the app lives under its address; the sign-in cookie's path follows it |
| `BASE_CLIENT` | `imaginesurrey` | the client's slug, given to Base Air and Base Web when they sign someone in; with no `BASE_PATH` to take it from, set it |
| `BASE_BRAND_PRESET`, `BASE_BRAND_PRIMARY`, … (optional) | the campaign's look before anyone saves one (README → *One deployment per client*, *The look*); a manager changes it under Settings → Brand | the colours, name and logo on every screen and public page |
| `BASE_PUBLIC_URL` | `https://imaginesurrey.base.win` (staging: `https://imaginesurrey.staging.base.win`) — no path on base.win; under a `BASE_PATH` it must end in it | every link in an email: invites, unsubscribe, receipts |
| `RESEND_API_KEY`, `MAIL_FROM` | from Resend; `Imagine Surrey <team@imaginesurrey.ca>` on a domain verified there | email; without it invites are shown to copy and sends wait as *queued* |

Then, as each one is ready:

| Variable | Set it to | Needed for |
|---|---|---|
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | from Twilio | texting and calling through the campaign's number, SMS shift alerts; without them the phone's own apps are used |
| `GEOCODER` | leave unset (`bc`, the free BC Address Geocoder); `GEOCODER_FALLBACK=google` to ask Google only for addresses BC can't place | placing people on the map |
| `GOOGLE_MAPS_SERVER_KEY` | a Google Cloud key restricted to the server's IP with only the APIs used enabled (Geocoding; Map Tiles for `GOOGLE_MAPS_TILES=1`) | Google geocoding and Google Maps tiles |
| `GOOGLE_MAPS_TILES` | `1` to draw the field map on Google's tiles (`GOOGLE_MAPS_TILE_TYPE` roadmap, satellite or terrain); otherwise OpenStreetMap, which is not for a large team in election week | the map's background |
| `BASE_TRUSTED_PROXIES` | `2` behind the base.win front door (Render's proxy, then the front door, each add to `X-Forwarded-For`); unset (one proxy) when Render is the only thing in front. Count every proxy in front, a CDN too | rate limits reading the right address |
| `BASE_AIR_URL`, `BASE_AIR_SSO_SECRET`, `BASE_WEB_URL`, `BASE_WEB_SSO_SECRET` | Base Air's and Base Web's addresses (`https://imaginesurrey.base.win/air`, `https://imaginesurrey.ca`), and long random secrets — each the same value as `BASE_SSO_SECRET` on that app (SUITE.md) | staff opening Base Air and Base Web's admin signed in with their Base Ground account |

Twilio: set the number's incoming-message webhook to
`https://imaginesurrey.base.win/api/public/twilio/sms` (HTTP POST). The
other addresses Twilio calls back (delivery reports, calls) are sent with
each text and call, built from `BASE_PUBLIC_URL`; nothing else to set.

**Check them.** After the first sign-in (below): **Settings → Services** in
the admin lists every service, says which settings are missing, and
**Check** calls each one for real — Resend's key and domain, the Twilio
number and where its replies go, the address service, Google's tiles, the
public address and the database.

## 4 · First sign-in

The first sign-in lands in the **admin** (`/ground/`); the field app at
`/field/` is what volunteers get, and what you see under *Field app ↗* in your
account menu (and in the **Base** switcher in the top bar). Both are on the
client's own subdomain: `https://imaginesurrey.base.win/ground/`.

1. Open `https://imaginesurrey.base.win/field/login` → **Set up Base Ground for
   Imagine Surrey** (the name `BASE_ORG_NAME` gives; a deployment that
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
   names (`base-ground-<client>-staging`, `base-ground-<client>`, and their
   databases — names are unique per Render account), and set their
   `BASE_*` values: the campaign's name, jurisdiction, time zone, city,
   slates and first candidates. Commit that on `main`.
2. Render → **New → Blueprint** → this repo: Render makes the new pair.
   Put the secrets in (section 3), the domains (section 2), and run the
   first sign-in on staging, then production (section 4).
3. One `main` serves every client: a change lands on every client's
   staging at once, and *Promote to production* moves it to every
   production at once. A client that must stay on an older version is a
   second `production-<client>` branch for its production service — avoid
   it unless they ask.

## 7 · Before the public link goes out

- `https://imaginesurrey.base.win/` loads over https and signs in.
- A test newsletter reaches a real inbox with a working unsubscribe link.
- A test gift logged under **Donations** gets its receipt emailed.
- Backups: Render's managed Postgres keeps daily backups; **Today → Export
  all data** (managers) downloads everything (message pictures are not in it).
- Keys: every key above is in Render only, never in the repo or a chat.
  Anyone who leaves the campaign is removed under **Admin → Members**, which ends their
  sign-in everywhere at once.

## What Base Ground does on its own

- Sign-in: 30 tries per address and 10 failures per email in 15 minutes,
  then a wait. Sessions last 30 days and end at sign-out or removal.
- Public forms: rate-limited per address; a request's body is capped.
- Email: every newsletter carries the reader's own unsubscribe link and the
  headers mail apps use for their Unsubscribe button; an unsubscribed
  address cannot be added back by the desk.
- Donations: contributions are checked against the Elections BC limit per
  contributor (confirm the seeded figure with Elections BC before filing).
