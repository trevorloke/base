# The door — the front door at base.win

Every client at its own address, `<client>.base.win`; each client's base.win
on its own server and database.

| Address | Goes to | Who |
|---|---|---|
| `imaginesurrey.base.win` | the volunteers' app | everyone the campaign invites |
| `imaginesurrey.base.win/admin` | the office (the desk) — every area, the Website among them | managers, staff, treasurers (and anyone given an area); a volunteer is turned away |
| `imaginesurrey.base.win/site/…` | the campaign's public website: pages, forms and news | anyone |
| `imaginesurrey.base.win/desk…` | → `/admin…` — the desk by its name | |
| `imaginesurrey.base.win/field…` | → `/…` — the volunteers' app by its name | |
| `base.win` | base.win's own page | anyone |
| `base.win/imaginesurrey/…` | → `imaginesurrey.base.win/…` — the address from before, which only sends people on to the same screen (the name alone → `/site/`, `/field…` → `/…`, `/desk…` → `/admin…`; path and query kept; a form's POST keeps its body) | anyone |

Signing in, phone storage and offline copies belong to `<client>.base.win`,
so each campaign has its own and no campaign sees another's.

The door passes requests through to the client's server with the path as it
came. It checks no one: signing in, and who may open the desk, are the
server's own. It holds one secret, `BASE_DOOR_KEY`: every request reaches
the server from the door's own address, so the door says whose it is (the
visitor's address, as Render's proxy in front of the door wrote it) with
that key, which the server alone can check. That is how the server's limits
per address — sign-in tries, the website's forms — tell visitors apart;
anyone else who sends those headers is not believed. Without the key, everyone
who comes through the door counts as one address, and one person's tries
use up everyone's.

## Setting up base.win

1. **The server, for each client.** On the client's base.win service
   (Render: Environment), set
   - `STARBASE_PUBLIC_URL=https://imaginesurrey.base.win` (links in emails —
     invites, unsubscribe, receipts — then use it)
   - `BASE_DOOR_KEY` — the door's key (step 2), the same on every client's
     server: 32 or more random characters (`openssl rand -base64 32`).
     While moving to a new key the server takes both, comma-separated
     (`new,old`): set that, then the door's to the new one, then the
     server's to the new one alone.
   - `APP_HOSTS=starbase.imaginesurrey.ca` — the app's other addresses on
     this server, comma-separated: here the one people used before
     base.win. None of them can be made the website's domain (Website →
     Settings → Your own domain), so the app keeps answering there. Never
     list the website's own domain here.

   No `BASE_PATH`: the server answers at its root, at `imaginesurrey.base.win`
   through the door **and** at its own address as before. A server set up
   when `base.win/imaginesurrey` was the address: delete `BASE_PATH` and
   change `STARBASE_PUBLIC_URL`, then Save and deploy (until then it still
   opens at `imaginesurrey.base.win`, but its emails link to the old
   address, which sends people on). People sign in once more at the new
   address, and a phone with the app installed installs it again from there.
2. **The door.** A Node web service from this repository: root directory
   `apps/door`, no build command, start command `node door.mjs`, health
   check `/healthz`. Set `BASE_CLIENTS`:

   ```json
   {
     "imaginesurrey": {
       "name": "Imagine Surrey",
       "server": "https://<imagine-surrey-base-win>.onrender.com"
     }
   }
   ```

   Some names are kept for base.win itself and the door won’t start with
   them in the list: `ops, staging, hub, api, admin, platform, _ops, _hooks, www,
   door, status, help, mail, app, desk, field, site, login, assets, sample`
   (`RESERVED` in door.mjs; the control centre at ops.base.win refuses the
   same names, and builds this whole value for you on New campaign).

   `server` is an origin (no path). A config from before may say `ground`
   for it, and may still have `web` or `air` entries: `ground` is read as
   the server, the others are ignored.

   And `BASE_DOOR_KEY`: the same key as the servers'. The door starts
   without it but says so in its log — and every visitor then counts as
   one address to the servers. With a proxy or CDN in front of the door as
   well as Render's, set `BASE_TRUSTED_PROXIES` to how many there are (the
   visitor's address is that many entries from the right of
   `X-Forwarded-For`; default 1).
3. **The domain.** Point `base.win` and `*.base.win` at the door service
   (Render: Settings → Custom Domains → add `base.win`, then `*.base.win`,
   and the DNS records it shows for each at your registrar; a wildcard asks
   for two extra records that prove the domain is yours). Render issues the
   HTTPS certificates. That one wildcard covers every client: the door
   answers `<client>.base.win` for any name in `BASE_CLIENTS`, and a plain
   "Not here" page for any other name. A subdomain with a service of its own
   (`ops.base.win`, `staging.base.win`) keeps its own DNS record and custom
   domain on that service. A door on another domain sets `BASE_APEX` to it
   (default `base.win`).
4. **A new client** is a new server (its own service and database) and one
   more entry in `BASE_CLIENTS`. No DNS: the wildcard already covers it.

Run it locally: `BASE_APEX=localhost:8080 BASE_CLIENTS='{"imaginesurrey":{"server":"http://127.0.0.1:3200"}}' node door.mjs`
(base.win on :3200), then open http://imaginesurrey.localhost:8080.
Tests: `npm test`.
