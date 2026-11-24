# The door — the front door at base.win

## Not in use today

Each client is served at its own address, `https://<name>.base.win`, by its
own service ([GOING-LIVE.md](../../GOING-LIVE.md), section 0). The door is
not deployed, and nothing needs it.

It is kept for a setup that wants every client under one address,
`base.win/<name>`. base.win itself is the front page today, so the door
cannot hold base.win unless the front page moves. And with the door,
`<name>.base.win` would only send people on to `base.win/<name>`; today it
is the client's own service.

Everything below describes that unused option.

## What it does

One address for every client; each client's base.win on its own server and
database.

| Address | Goes to | Who |
|---|---|---|
| `base.win/imaginesurrey` | → `/imaginesurrey/site/` — the campaign's public website | anyone |
| `base.win/imaginesurrey/site/…` | the website's pages, forms and news | anyone |
| `base.win/imaginesurrey/field` | the volunteers' app | everyone the campaign invites |
| `base.win/imaginesurrey/desk` | the office — every area, the Website among them | managers, staff, treasurers (and anyone given an area); a volunteer is turned away |
| `base.win/imaginesurrey/web…` | → `/imaginesurrey/desk/website` (the old back-office address) | |
| `base.win/imaginesurrey/admin…` | → `/imaginesurrey/desk…` (the office's old address: the server sends it on as a path, so the browser stays on base.win) | |
| `imaginesurrey.base.win/…` | → `base.win/imaginesurrey/…` — a short address that only sends people on (path and query kept; a form's POST keeps its body). Signing in, phone storage and offline copies stay at `base.win/imaginesurrey`, so there is one of each | anyone |

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
   - `BASE_PATH=/imaginesurrey`
   - `STARBASE_PUBLIC_URL=https://base.win/imaginesurrey` (links in emails —
     invites, unsubscribe, receipts — then use base.win)
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

   It then answers under `/imaginesurrey` **and** at its own address as
   before, so nothing breaks while people move over (old bookmarks, invites
   already sent, knocks still waiting on a phone to send). Each campaign
   keeps its own phone storage, offline copies and sign-in on base.win.
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
   them in the list: `ops, hub, api, admin, platform, _ops, _hooks, www,
   door, status, help, mail, app, desk, field, site, login, assets, sample,
   staging, demo` (`RESERVED` in door.mjs; the control centre at ops.base.win refuses the
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
3. **The domain.** Point `base.win` at the door service (Render: Settings →
   Custom Domains → add `base.win`, then the DNS records it shows at your
   registrar). Render issues the HTTPS certificate. For a client's short
   address, add `<client>.base.win` to the same door service the same way;
   the door sends it on to `base.win/<client>` for any name in
   `BASE_CLIENTS` (and for nothing else). A door on another domain sets
   `BASE_APEX` to it (default `base.win`).
4. **A new client** is a new server (its own service and database, with its
   own `BASE_PATH`) and one more entry in `BASE_CLIENTS`.

Run it locally: `BASE_CLIENTS='{"imaginesurrey":{"server":"http://127.0.0.1:3200"}}' node door.mjs`
(base.win with `BASE_PATH=/imaginesurrey` on :3200), then open
http://127.0.0.1:8080/imaginesurrey. Tests: `npm test`.
