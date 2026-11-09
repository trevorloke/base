# The door — the front door at base.win

One address for every client; each client's base.win on its own server and
database.

| Address | Goes to | Who |
|---|---|---|
| `base.win/imaginesurrey` | → `/imaginesurrey/site/` — the campaign's public website | anyone |
| `base.win/imaginesurrey/site/…` | the website's pages, forms and news | anyone |
| `base.win/imaginesurrey/field` | the volunteers' app | everyone the campaign invites |
| `base.win/imaginesurrey/desk` | the office — every area, the Website among them | managers, staff, treasurers (and anyone given an area); a volunteer is turned away |
| `base.win/imaginesurrey/web…` | → `/imaginesurrey/desk/website` (the old back-office address) | |

The door passes requests through to the client's server with the path as it
came. It holds no secrets and checks no one: signing in, and who may open
the desk, are the server's own.

## Setting up base.win

1. **The server, for each client.** On the client's base.win service
   (Render: Environment), set
   - `BASE_PATH=/imaginesurrey`
   - `STARBASE_PUBLIC_URL=https://base.win/imaginesurrey` (links in emails —
     invites, unsubscribe, receipts — then use base.win)

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

   `server` is an origin (no path). A config from before may say `ground`
   for it, and may still have `web` or `air` entries: `ground` is read as
   the server, the others are ignored.
3. **The domain.** Point `base.win` at the door service (Render: Settings →
   Custom Domains → add `base.win`, then the DNS records it shows at your
   registrar). Render issues the HTTPS certificate.
4. **A new client** is a new server (its own service and database, with its
   own `BASE_PATH`) and one more entry in `BASE_CLIENTS`.

Run it locally: `BASE_CLIENTS='{"imaginesurrey":{"server":"http://127.0.0.1:3200"}}' node door.mjs`
(base.win with `BASE_PATH=/imaginesurrey` on :3200), then open
http://127.0.0.1:8080/imaginesurrey. Tests: `npm test`.
