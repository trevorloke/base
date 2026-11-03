# Integrations

Every outside service Starbase talks to, what it is for, the settings it
reads, where each key comes from, and how to check it works. Keys and tokens
go in the hosting's environment (Render → the service → **Environment**),
never in the code, the repo or a chat. Once they are set, a manager opens
**Settings → Services** in the admin: each service says whether it's set up,
and **Check** makes one real call to it (nothing is sent to anyone, nothing
is written) and says exactly what is wrong if anything is.

| Service | For | Needed to launch? | Settings |
|---|---|---|---|
| [Database](#database) | everything the campaign records | yes | `DATABASE_URL` |
| [Public address](#public-address) | links in email, texting's callbacks | yes | `STARBASE_PUBLIC_URL` |
| [Email — Resend](#email--resend) | invites, newsletters, press, ladders, shift alerts, receipts | yes | `RESEND_API_KEY`, `MAIL_FROM` |
| [Texting and calls — Twilio](#texting-and-calls--twilio) | the campaign's number: texts, text blasts, calls, SMS shift alerts | no (phones' own apps until then) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` |
| [Address lookup](#address-lookup) | suggestions as you type, placing people on the map | yes (free default, no key) | `GEOCODER`, `GEOCODER_FALLBACK`, `BC_GEOCODER_KEY`, `GOOGLE_MAPS_SERVER_KEY` |
| [Map background](#map-background) | the map volunteers walk | no (free default; change before election week) | `GOOGLE_MAPS_TILES`, `GOOGLE_MAPS_SERVER_KEY`, or `STARBASE_TILE_URL` |
| [Hosting — Render](#hosting--render) | the two environments | yes | `render.yaml` |
| [GitHub Actions](#github-actions) | tests, and promoting staging to production | yes | none |

The campaign's website is its own thing; how its forms will come in is
[below](#the-campaigns-website).

## Database

Postgres. On Render, `render.yaml` creates one per environment and fills
`DATABASE_URL` from it. Without `DATABASE_URL` Starbase keeps everything in a
built-in database on the server's disk (`STARBASE_DATA`, default
`./data/starbase`) — fine on a laptop, not for the team.

| Setting | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | `postgres://…`; `sslmode=require` in it turns TLS on |
| `PGSSL` / `PGSSL_STRICT` | off | `1` to force TLS / to verify the certificate |
| `PG_POOL_MAX` | `10` | connections per server |

**Check:** Services → Database answers with how many people are on file.

## Public address

`STARBASE_PUBLIC_URL` — this environment's own `https://` address
(`https://starbase.imaginesurrey.ca`; staging its own). Every link in an
email (invites, unsubscribe, receipts, pictures) is built from it, and so are
the addresses Twilio is told to call back (delivery reports, calls). Without
it, links use whatever address the page was opened at, background sends
(receipts) carry no link, and calls through the campaign's number are off.

**Check:** Services → Public address fetches `<address>/api/health` and
makes sure it's this Starbase.

## Email — Resend

[resend.com](https://resend.com). Sends with a plain HTTPS call
(`POST https://api.resend.com/emails`), one idempotency key per email so a
retry is never a second copy.

1. Resend → **Domains** → add the campaign's domain (e.g. `imaginesurrey.ca`)
   and add the DNS records it shows (SPF, DKIM) at the domain's DNS host.
   Wait for **Verified**.
2. Resend → **API Keys** → create one with **Sending access** for that
   domain.
3. Set `RESEND_API_KEY` to it and `MAIL_FROM` to a sender on the domain:
   `Imagine Surrey <team@imaginesurrey.ca>`. Staging: a separate key, or none.

| Setting | Default | Notes |
|---|---|---|
| `RESEND_API_KEY` | — | without it nothing is emailed: sends are recorded as *queued*, invites show their link to copy, receipts wait |
| `MAIL_FROM` | `onboarding@resend.dev` | Resend's test sender reaches only the account's owner — set it |
| `STARBASE_EMAIL_TIMEOUT_MS` | `15000` | one email's time limit |

There is nothing to point back at Starbase: opens and clicks are counted by
Starbase itself (`/o`, `/c`), and unsubscribes are Starbase's own pages.

**Check:** Services → Email asks Resend for the account's domains: the key
works, and `MAIL_FROM`'s domain is there and verified (a sending-only key
can't list domains; the check says so and the key is fine).

## Texting and calls — Twilio

[twilio.com](https://www.twilio.com). One-to-one texts from the Inbox, the
Calls card and the door card; text blasts to a list; STOP/START; calls
placed through the campaign's number (Twilio rings the caller, they press 1,
then it dials the person); SMS shift alerts. Without it, Call and Text open
the phone's own dialer and messages, and nothing is lost.

1. Twilio → buy a Canadian number with SMS and voice. Register it for
   messaging as Twilio requires (A2P/10DLC or toll-free verification).
2. Account SID and Auth Token from the Twilio console → `TWILIO_ACCOUNT_SID`,
   `TWILIO_AUTH_TOKEN`; the number in `+1…` form → `TWILIO_FROM`.
3. Twilio → **Phone Numbers** → the number → **Messaging** → *A message comes
   in*: **Webhook**, `https://<public address>/api/public/twilio/sms`,
   **HTTP POST**. That is the only one set by hand.

Starbase tells Twilio where to call back with each text and call, all built
from `STARBASE_PUBLIC_URL`, and checks Twilio's signature
(`X-Twilio-Signature`, with the auth token) on every one:

| Address | When |
|---|---|
| `/api/public/twilio/sms` | a text comes in (set by hand, above) |
| `/api/public/twilio/sms-status/:id` | a text's delivery report |
| `/api/public/twilio/voice/:token` | a call: "press 1" |
| `/api/public/twilio/voice/:token/connect` | the caller pressed 1 |
| `/api/public/twilio/voice-dial/:id` | the person's line is dialled |
| `/api/public/twilio/voice-status/:id` | the call's status |

| Setting | Default | Notes |
|---|---|---|
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | — | all three, or texting and calling are off |
| `TWILIO_VOICE` | on | `off` keeps texting and turns calls through the campaign's number off |
| `TWILIO_WORKSPACE` | — | the workspace slug a text from an unknown number is filed under, when several campaigns share one server and number |

Election texting has rules of its own; confirm bulk texting with counsel
first (TESTING.md, *Texting and calls — confirm with counsel*).

**Check:** Services → Texting asks Twilio for the number on this account:
the SID and token work, the number is on the account, and its incoming
messages come to this Starbase (if they go elsewhere, it names both).

## Address lookup

Suggests addresses as someone types (the map's *+ Door*, Add person, a
profile's Edit, Add a sign), places a person saved with an address and no
pin, and runs the desk's background *Place on map* over a whole list.

| `GEOCODER` | Service | Key |
|---|---|---|
| `bc` (default) | [BC Address Geocoder](https://www2.gov.bc.ca/gov/content/data/geographic-data-services/location-services/geocoder) — the B.C. government's, built for B.C. civic addresses | none; `BC_GEOCODER_KEY` (from the BC API gateway) for higher limits |
| `google` | Google Geocoding API | `GOOGLE_MAPS_SERVER_KEY` |
| `nominatim` | OpenStreetMap's Nominatim — light use only | none |
| `off` | no lookups; pins by hand | — |

`GEOCODER_FALLBACK=google` keeps the free BC service first and asks Google
only for what BC can't place. A Google key: Google Cloud → **APIs &
Services** → enable the **Geocoding API** (and the **Map Tiles API** for
Google tiles) → **Credentials** → an API key **restricted** to those APIs
and to the server's outgoing IP. It is the server's key; the browser never
sees it.

| Setting | Default | Notes |
|---|---|---|
| `STARBASE_GEO_BOUNDS` | a box around Surrey | `lat,lng\|lat,lng` — suggestions and lookups stay in it |
| `STARBASE_PROVINCE` | `BC` | |
| `GEOCODE_MIN_SCORE` | `75` | BC's match score a pin needs |
| `GEOCODE_ON_SAVE` | on | `off`: no lookup when a person is saved (the background run still places them) |
| `GEOCODE_CONCURRENCY`, `GEOCODE_BACKOFF_MS` | `6`, `30000` | the background run's pace |
| `BC_GEOCODER_URL` | the official service | a self-hosted mirror |

**Check:** Services → Address lookup asks for a few addresses in the
campaign's box.

## Map background

OpenStreetMap's free tiles by default, straight to each phone. Their servers
are run by volunteers and are not for a large team in election week; before
then, either:

- **Google Maps:** `GOOGLE_MAPS_TILES=1` with `GOOGLE_MAPS_SERVER_KEY` (Map
  Tiles API enabled, above); `GOOGLE_MAPS_TILE_TYPE` roadmap | satellite |
  terrain. Starbase fetches them for signed-in phones (`/tiles/…`), so the
  key stays on the server.
- **Another provider:** `STARBASE_TILE_URL` (`https://…/{z}/{x}/{y}.png`, a
  key may ride in the query string — the phones see it),
  `STARBASE_TILE_ATTRIBUTION`, `STARBASE_TILE_MAX_ZOOM`.

**Check:** Services → Map background opens a Google tiles session when
Google is on.

## Hosting — Render

`render.yaml` is a Render Blueprint: `starbase-staging` (deploys every push to
`main`) and `starbase` (deploys the `production` branch), each with its own
Postgres. Settings marked `sync: false` are asked for when the Blueprint is
created and are set per service afterwards. GOING-LIVE.md is the order to do
it in.

## GitHub Actions

- **CI** (`.github/workflows/ci.yml`) — the server suite (in-memory and over
  the Postgres wire protocol) and the web build, on every push to `main` and
  `production`. No secrets.
- **Promote to production** (`.github/workflows/promote.yml`) — GitHub →
  Actions → *Promote to production* → Run workflow: fast-forwards
  `production` to `main` once CI is green there, never rewrites it. Render
  then deploys production. Uses only the workflow's own token.

## The campaign's website

The website is hosted apart, and its forms (petitions, newsletter and
volunteer signups, RSVPs, donations) are to feed Starbase when it is
integrated; until then nothing on the website writes to Starbase. What
exists today:

- **Files in:** People → Import takes a CSV or spreadsheet (a dry run first);
  a `voted` column (1/0, yes/no or a date) marks who voted and never
  un-marks anyone.
- **Pages out:** the website can link to Starbase's public pages — `/learn/…`
  (public lessons), and the unsubscribe pages every email carries (`/u`,
  `/bu`, `/lu`) and receipts (`/r`).
- **No API key yet:** every `/api` route needs a signed-in person. A website
  feed will need its own key and an endpoint built for it; that is the next
  piece of work for the integration, not a setting.
