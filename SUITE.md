# Base: how the apps fit together

**Base** (broad application for social engagement) is a suite of three apps
for a campaign or cause, served at **base.win**. Every client has its own
copy of each app, with its own servers and databases, **and its own web
address**. No client's voters, donors or posts share a database, a browser
origin or a cookie with another's.

| App | Folder | What it is | Who uses it |
|---|---|---|---|
| **Base Ground** | `apps/ground` | The organizing app (was Starbase). Two faces from one build: **field** for volunteers, **ground** for the staff desk | field: most volunteers. ground: a few staff |
| **Base Web** | `apps/web` | The client's public website and its back office (was the Imagine Surrey website) | the public; a few staff in its admin |
| **Base Air** | `apps/air` | Attention and social: listen, forecast, post through operators inside red lines (was Starsign) | a few staff |
| **front door** | `apps/gateway` | base.win itself: sends each client's subdomain to that client's apps | everyone, unseen |

Base Ground is the default app and the sign-in hub. In words on screen the
names are written **Base**, **Base Ground**, **Base Web**, **Base Air**;
code, packages and settings use `base`, `base-ground`, `BASE_*`.

## Addresses

Each client has a subdomain of its own: `<client>.base.win` in production,
`<client>.staging.base.win` on staging. For Imagine Surrey (`imaginesurrey`):

| Address | Goes to |
|---|---|
| `imaginesurrey.base.win/` | redirects to `/field/` |
| `imaginesurrey.base.win/field/…` | Base Ground, field app (volunteers) |
| `imaginesurrey.base.win/ground/…` | Base Ground, the desk (was `/admin`) |
| `imaginesurrey.base.win/api/…` and ground's own public pages (`/u`, `/bu`, `/lu`, `/r`, `/o`, `/c`, `/join`, `/media`, `/learn`, `/learn-files`, `/tiles`, `/in/v1`, `/sw.js`, `/assets`, …) | Base Ground's server |
| `imaginesurrey.base.win/air/…` | Base Air (its web app and its `/api`) |
| `imaginesurrey.base.win/web` | sends a signed-in staffer to Base Web's admin, which lives on the client's own domain (`https://imaginesurrey.ca/admin`). The public website is only ever on the client's domain |
| `base.win/` | a plain landing page. It never lists clients |
| `base.win/healthz` | the front door's health (no client names or counts) |

Why subdomains, not `base.win/<client>/…`: browsers draw their security line
around an origin (scheme + host + port). On one shared host, a bug in any one
client's app would let its pages read and act on every other client's data in
the same browser, whatever the cookie paths say. On its own subdomain each
client is a separate origin. base.win should also be added to the
[Public Suffix List](https://publicsuffix.org/) so clients are separate
*sites* too (cookies marked SameSite then stop at the client's edge).

The front door keeps the path as it is when it passes a request on. Within a
client, Base Ground runs at the root and Base Air under `/air`.

### `BASE_PATH`: each app knows where it lives

| App | `BASE_PATH` | Its public URL setting |
|---|---|---|
| Base Ground | *(none: the root of the client's subdomain)* | `BASE_PUBLIC_URL=https://imaginesurrey.base.win` |
| Base Air | `/air` | `BASE_AIR_PUBLIC_URL=https://imaginesurrey.base.win/air` |
| Base Web | *(none: the root of the client's own domain)* | `NEXT_PUBLIC_SITE_URL=https://imaginesurrey.ca` |

Rules for an app with a `BASE_PATH`:

- The server takes a request whose path starts with `BASE_PATH` and handles
  the rest as if it were at the root. `BASE_PATH` empty means the root.
- A request without the prefix: `/api/health` answers as usual so Render's
  health check works; anything else gets a `308` to the same path under the
  prefix.
- The browser app learns the prefix from the HTML the server sends
  (`<base href="${BASE_PATH}/">` and `window.__BASE_PATH__`). Every absolute
  path the browser builds goes through one helper. Vite builds use
  `base: './'`.
- Cookies are set with `Path=${BASE_PATH || '/'}` and never with a `Domain`
  attribute, so they stay on the client's own host.
- Links the server puts in emails and texts come from the public URL setting.

### Only through the front door

Base Ground and Base Air are Render **private services**: they have no public
address of their own, so every request reaches them through the front door,
and the `X-Forwarded-For` they trust is one the front door wrote. Base Web is
public (it serves the client's domain).

## Signing in once: Base Ground is the hub

A staffer signs in to Base Ground. Base Air and Base Web's admin don't make
accounts for that person: they ask Base Ground who it is, then sign the
person in to **their own existing account**, linked once (below). Base Web
still asks owners and admins for their authenticator code afterwards.

### Settings

On **Base Ground**:

| Setting | Example |
|---|---|
| `BASE_AIR_URL` | `https://imaginesurrey.base.win/air` |
| `BASE_AIR_SSO_SECRET` | long random string, the same value as `BASE_SSO_SECRET` on Base Air |
| `BASE_WEB_URL` | `https://imaginesurrey.ca` |
| `BASE_WEB_SSO_SECRET` | long random string, the same value as `BASE_SSO_SECRET` on Base Web |

On **Base Air** and **Base Web**:

| Setting | Example |
|---|---|
| `BASE_GROUND_URL` | `https://imaginesurrey.base.win` (public; the browser is sent here) |
| `BASE_GROUND_INTERNAL_URL` | Base Ground over Render's private network (`host:port` is fine), for the token call |
| `BASE_SSO_SECRET` | the matching secret from Base Ground |

Base Web also keeps its link to Base Ground for sign-ups: `BASE_GROUND_URL`,
`BASE_GROUND_KEY`, `BASE_GROUND_INBOUND_KEY`.

### The hand-off

1. The app (Air or Web) sends the browser to
   `${BASE_GROUND_URL}/api/sso/authorize?app=air&redirect_uri=<url>&state=<random>`,
   keeping `state` in a short-lived, HttpOnly, SameSite=Lax cookie.
2. Base Ground checks that `app` is set up and that `redirect_uri` begins
   with that app's URL followed by `/`. Not signed in: to the desk's sign-in
   (`/ground/login?next=<this authorize URL>`) and back. Someone who isn't
   staff (no desk role and no areas) is refused.
3. Base Ground makes a one-time code (32 random bytes), stores only its
   SHA-256 with the user, the app, the `redirect_uri` and a 60-second expiry,
   and redirects to `<redirect_uri>?code=…&state=…`.
4. The app checks `state`, then from its **server** posts
   `{"code","redirect_uri"}` to `/api/sso/token` (internal URL if set) with
   `Authorization: Bearer <BASE_SSO_SECRET>`.
5. Base Ground checks the secret in constant time and spends the code once,
   answering `{ "sub", "email", "name", "role", "areas", "organization", "client" }`.
   `sub` is Base Ground's stable, opaque id for the person; `client` is the
   client's slug. Anything wrong is `400 {"error":"invalid_grant"}`.
6. The app signs the person in by **link**, not by email:
   - A link for (`client`, `sub`) exists: sign in the account it points to.
   - No link yet: find the app's own account by the email (case-insensitive).
     The person proves once that the account is theirs, with that account's
     own password (or, in Base Web, a one-time link emailed to it); then the
     app stores the link and signs them in. The email from Base Ground alone
     is never enough, because a Base Ground manager can make a ground login
     for any address.
   - The account is already linked to a different `sub`: refused.
   - No account: "No Base Air account for <email> — ask an owner to invite
     you." No account is ever created this way.
   Every hand-off and every link made or refused goes in the app's audit log.
   An owner can remove a link from the app's admin.

Each app has a plain `/auth/base?next=<path>` that starts step 1.

### The app switcher

Every app shows the same small **Base** switcher in its top bar. Field is for
everyone; ground, Air and Web are for staff (a desk role, or a volunteer
given an area), the same people the hand-off lets through, and Air and Web
only once set up. The other app still decides who it signs in. Ground serves
the list at `GET /api/suite`; Air and Web build theirs from their settings
and link to the others through `/auth/base`.

## Look and brand

Each app has its own modern look, distinct from the other two, and a
**Brand** page in its admin where an owner or manager sets a preset, name,
logo, colours (picker + hex), a bundled font, corner style and (where
supported) mode, with a live preview and a contrast check (pairs under 4.5:1
flagged; field body text in Base Ground held to 7:1; saving a failing pair
asks to confirm). The brand is stored in the app's database, audited, and
written into the HTML as CSS custom properties so there's no flash of the
default look. A client can be pre-configured by settings and adjust after.

| App | Default preset | Feel |
|---|---|---|
| Base Ground | **Ground** | field-ready, high contrast: forest green, signal amber, warm off-white, big tap targets |
| Base Web | **Imagine Surrey** for Imagine Surrey (today's site exactly); **Civic** for a new client | public and confident |
| Base Air | **Air** | dark: sky blue and violet on deep navy, mono figures |

## Repository

```
apps/ground     Base Ground   (Node, Hono, Vite + React, npm); its image is the root Dockerfile
apps/web        Base Web      (Next.js, Drizzle, npm)
apps/air        Base Air      (pnpm monorepo: Hono API, Vite web, workers, operators)
apps/gateway    the front door (Node, no dependencies)
render.yaml     every client's services, staging and production
```

`main` deploys to staging; the `production` branch to production, moved
forward only by *Promote to production*, when Trevor says so.
