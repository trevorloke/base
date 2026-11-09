# Base door — the front door at base.win

One address for every client; each client's apps on their own servers and
databases.

| Address | Goes to | Who |
|---|---|---|
| `base.win/imaginesurrey` | → `/imaginesurrey/field/` | |
| `base.win/imaginesurrey/field` | Imagine Surrey's **Base Ground** — the volunteers' app | everyone the campaign invites |
| `base.win/imaginesurrey/desk` | the same Ground — the office | managers, staff, treasurers (and anyone given an area); a volunteer is turned away |
| `base.win/imaginesurrey/web` | **Base Web** — the website's back office | its staff, with their own sign-in |

The door passes Ground's requests through with the path as it came; Web is
sent on to where it already runs (it serves at its own address today). It
holds no secrets and checks no one: signing in, and who may open the desk or
Web, are each app's own.

## Setting up base.win

1. **Ground, for each client.** On the client's Ground service (Render:
   Environment), set
   - `BASE_PATH=/imaginesurrey`
   - `STARBASE_PUBLIC_URL=https://base.win/imaginesurrey` (links in emails —
     invites, unsubscribe, receipts — then use base.win)

   Ground then answers under `/imaginesurrey` **and** at its own address as
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
       "ground": "https://<imagine-surrey-ground>.onrender.com",
       "web": { "redirect": "https://imaginesurrey.ca/admin" }
     }
   }
   ```

   `ground` is an origin (no path). `web` is either
   `{ "redirect": "https://…" }` (sent on, the rest of the path after it) or
   an origin to pass through to, once Web can live under
   `/imaginesurrey/web` itself. Leave it out and that address says "not set
   up".
3. **The domain.** Point `base.win` at the door service (Render: Settings →
   Custom Domains → add `base.win`, then the DNS records it shows at your
   registrar). Render issues the HTTPS certificate.
4. **A new client** is a new Ground (its own service and database, with its
   own `BASE_PATH`) and one more entry in `BASE_CLIENTS`.

Run it locally: `BASE_CLIENTS='{"imaginesurrey":{"ground":"http://127.0.0.1:3200"}}' node door.mjs`
(Ground with `BASE_PATH=/imaginesurrey` on :3200), then open
http://127.0.0.1:8080/imaginesurrey. Tests: `npm test`.
