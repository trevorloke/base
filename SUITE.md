# base — how the apps fit together

**base** (broad application for social engagement) is a suite of three apps
for a campaign or cause, served at **base.win**. Every client has its own
copy of each app, with its own servers and databases: no client's voters,
donors or posts share a database with another's.

| App | Folder | What it is | Who uses it |
|---|---|---|---|
| **base ground** | `apps/ground` | The organizing app (was Starbase). Two faces from one build: **field** for volunteers, **ground** for the staff desk | field: most volunteers. ground: a few staff |
| **base web** | `apps/web` | The client's public website and its back office (was the Imagine Surrey website) | the public; a few staff in its admin |
| **base air** | `apps/air` | Attention and social: listen, forecast, post through operators inside red lines (was Starsign) | a few staff |
| **front door** | `apps/gateway` | base.win itself: sends `/<client>/…` to that client's apps | everyone, unseen |

base ground is the default app and the sign-in hub.

## Addresses

Production is `https://base.win`, staging `https://staging.base.win`. For a
client with the slug `imaginesurrey`:

| Address | Goes to |
|---|---|
| `base.win/imaginesurrey/` | redirects to `/imaginesurrey/field/` |
| `base.win/imaginesurrey/field/…` | base ground, field app (volunteers) |
| `base.win/imaginesurrey/ground/…` | base ground, the desk (was `/admin`) |
| `base.win/imaginesurrey/api/…` and ground's own public pages (`/u`, `/bu`, `/lu`, `/r`, `/o`, `/c`, `/join`, `/media`, `/learn`, `/learn-files`, `/tiles`, `/in/v1`, `/sw.js`, `/assets`, …) | base ground's server |
| `base.win/imaginesurrey/air/…` | base air (its web app and its `/api`) |
| `base.win/imaginesurrey/web` | sends a signed-in staffer to base web's admin, which lives on the client's own domain (`https://imaginesurrey.ca/admin`). The public website is only ever on the client's domain |
| `base.win/` | a plain landing page. It never lists clients (campaigns don't want to be enumerable) |
| `base.win/healthz` | the front door's health |

The front door keeps the path as it is when it passes a request on (no
stripping). Each app is told its own prefix and serves everything under it.

### `BASE_PATH`: each app knows where it lives

| App | `BASE_PATH` | Its public URL setting |
|---|---|---|
| base ground | `/imaginesurrey` | `BASE_PUBLIC_URL=https://base.win/imaginesurrey` |
| base air | `/imaginesurrey/air` | `BASE_AIR_PUBLIC_URL=https://base.win/imaginesurrey/air` |
| base web | *(none: it runs at the root of the client's domain)* | `NEXT_PUBLIC_SITE_URL=https://imaginesurrey.ca` |

Rules for an app with a `BASE_PATH`:

- The server takes a request whose path starts with `BASE_PATH` and handles
  the rest as if it were at the root. `BASE_PATH` empty (local development)
  means today's behaviour, unchanged.
- A request without the prefix: `/api/health` (and the app's other health
  path, if any) answers as usual so Render's health check works; anything
  else gets a `308` to the same path under the prefix.
- The browser app learns the prefix from the HTML the server sends (the
  server writes `<base href="${BASE_PATH}/">` and
  `window.__BASE_PATH__="${BASE_PATH}"` into `index.html`). Every absolute
  path the browser builds (fetch, links, router basename, the service
  worker's URL and scope, assets) goes through one helper. Vite builds use
  `base: './'` so assets resolve against `<base href>`.
- Cookies are set with `Path=${BASE_PATH}` (or `/` when empty), so two
  clients on base.win never see each other's cookies.
- Links the server puts in emails and texts come from the public URL setting,
  which already includes the prefix.

## Signing in once: base ground is the hub

A staffer signs in to base ground. base air and base web's admin don't make
their own accounts for that person: they ask base ground who it is, then sign
the person in to **their own existing account with the same email** (no
account is created this way; someone without one is told to ask that app's
owner for an invite). base web still asks owners and admins for their
authenticator code afterwards.

### Settings

On **base ground**:

| Setting | Example |
|---|---|
| `BASE_AIR_URL` | `https://base.win/imaginesurrey/air` |
| `BASE_AIR_SSO_SECRET` | long random string, the same value as `BASE_SSO_SECRET` on base air |
| `BASE_WEB_URL` | `https://imaginesurrey.ca` |
| `BASE_WEB_SSO_SECRET` | long random string, the same value as `BASE_SSO_SECRET` on base web |

On **base air** and **base web**:

| Setting | Example |
|---|---|
| `BASE_GROUND_URL` | `https://base.win/imaginesurrey` (public; the browser is sent here) |
| `BASE_GROUND_INTERNAL_URL` | optional: base ground over Render's private network, for the token call |
| `BASE_SSO_SECRET` | the matching secret from base ground |

base web also keeps its existing link to base ground for sign-ups, renamed:
`STARBASE_URL` → `BASE_GROUND_URL`, `STARBASE_KEY` → `BASE_GROUND_KEY`,
`STARBASE_INBOUND_KEY` → `BASE_GROUND_INBOUND_KEY`.

### The hand-off

1. The app (air or web) sends the browser to
   `${BASE_GROUND_URL}/api/sso/authorize?app=air&redirect_uri=<url>&state=<random>`.
   It keeps `state` in a short-lived, HttpOnly cookie (`SameSite=Lax`).
   `redirect_uri` is the app's own callback, e.g.
   `https://base.win/imaginesurrey/air/auth/base/callback`.
2. base ground checks that `app` is set up (its URL and secret are set) and
   that `redirect_uri` begins with that app's URL followed by `/`. If the
   person isn't signed in, it sends them to the desk's sign-in
   (`${BASE_PATH}/ground/login?next=<this authorize URL>`) and back here after.
   A volunteer (no desk role, no areas) is refused: "base air is for staff."
3. base ground makes a one-time code (32 random bytes, base64url), stores
   only its SHA-256 with the user, the app, the `redirect_uri`, and an expiry
   of 60 seconds, and redirects to `<redirect_uri>?code=…&state=…`.
4. The app checks `state` against its cookie, then from its **server** posts
   `{"code":"…","redirect_uri":"…"}` to
   `${BASE_GROUND_INTERNAL_URL or BASE_GROUND_URL}/api/sso/token` with
   `Authorization: Bearer <BASE_SSO_SECRET>`.
5. base ground compares the secret in constant time against that app's
   secret, then the code: known, unexpired, unused, same `redirect_uri`, same
   app. It marks the code used and answers once:
   `{ "email", "name", "role", "areas", "organization", "client": "<slug>" }`.
   Anything wrong is a `400 {"error":"invalid_grant"}` with no detail.
6. The app finds its own user by email (case-insensitive) and starts its own
   session, or shows "No base air account for <email> — ask an owner to
   invite you." Every hand-off, refused or not, is in the app's audit log
   where it has one.

Each app also has a plain `/auth/base?next=<path>` that starts step 1, so a
link can say "open base air, signed in" in one URL.

### The app switcher

Every app shows the same small **base** switcher in its top bar, listing the
client's apps the person may open: field for everyone; ground, air and web
for staff — a desk role (manager, staff, treasurer) or a volunteer given an
area — the same people the hand-off lets through (air and web once set up).
The other app still decides: it only signs in someone it has an account for. ground learns which are set
up from its settings and serves them at `GET ${BASE_PATH}/api/suite`
(signed in). air and web build their list from `BASE_GROUND_URL`,
`BASE_WEB_URL` / `BASE_AIR_URL` (whichever they have) and link to the other
apps through `/auth/base?next=…` so the hop is already signed in.

## Look and brand

Each app has its own modern look, distinct from the other two, and a
**Brand** page in its admin where an owner or manager sets:

- **Preset**: a starting look. Each app ships with presets; picking one fills
  the fields below, which can then be adjusted. **Reset to preset** puts them
  back.
- **Name** shown in the app (defaults to the client's organization name) and
  **logo** (an uploaded image or a URL; the app's own mark when empty).
- **Colours**: primary, accent, background (surface), text (ink), and the
  colour of text on primary and on accent. A colour picker and a hex field
  for each.
- **Font** from a short list of well-hinted web fonts the app bundles (no
  third-party font requests), **corner style** (sharp, soft, round) and
  **mode** where the app supports it (light, dark, follow the device).
- A **live preview** of the app's own key pieces (a button, a card, a
  heading, a link, a form field, an alert) as the settings are changed, and
  a **contrast check**: any text-and-background pair under 4.5:1 is flagged
  with its ratio and saving asks for confirmation. Field screens in base
  ground hold a stricter line (7:1 for body text) because volunteers read
  them outdoors.

The brand is stored in the app's own database, audited where the app has an
audit log, and applied as CSS custom properties. The server writes them
into the HTML it sends, so there is no flash of the default look. A client
can be **pre-configured**: a preset and colours set before the first sign-in
(by a seed or a setting) and adjustable afterwards.

### Default looks (distinct by design)

| App | Default preset | Feel |
|---|---|---|
| base ground | **Ground** | field-ready and high-contrast: deep forest green, signal amber accents, warm off-white, big tap targets, legible in sun |
| base web | **Imagine Surrey** for Imagine Surrey (navy, red, yellow, Montserrat, exactly today's site); **Civic** for a new client | public and confident |
| base air | **Air** | dark by default, sky blue and violet on deep navy, mono figures for numbers |

## Repository

```
apps/ground     base ground   (Node, Hono, Vite + React, npm)
apps/web        base web      (Next.js, Drizzle, npm)
apps/air        base air      (pnpm monorepo: Hono API, Vite web, workers, operators)
apps/gateway    the front door (Node, no dependencies beyond the runtime)
render.yaml     every client's services, staging and production
```

`main` deploys to staging; the `production` branch to production, moved
forward only by the *Promote to production* workflow, when Trevor says so.
