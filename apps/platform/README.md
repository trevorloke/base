# base.win control centre (`apps/platform`, ops.base.win)

One sign-in for every campaign. From here you see whether each campaign is
answering, open any campaign’s desk already signed in, and set up new
campaigns step by step in the Render dashboard.

It is its own Render service (`base-platform`, Node, no Dockerfile) with its
own small database (`base-platform-db`). It holds no campaign’s database
address, no Render key and nobody’s details: it reads only each campaign’s
public `/api/health`. No campaign ever calls it.

Each campaign is at its own address, `https://<name>.base.win`: a custom
domain on that campaign’s own Render service (Imagine Surrey is
`imaginesurrey.base.win`). Staging is `https://staging.base.win`, the control
centre is `https://ops.base.win`, and `https://base.win` is the front page.

## Settings

| Setting | What | render.yaml |
|---|---|---|
| `DATABASE_URL` | its own database. On Render it won’t start without one: in memory it would forget you, every campaign and the log at each restart. | from `base-platform-db` |
| `OPS_HOST` | `ops.base.win`; every other host gets a 404 (except `/healthz`) | value |
| `OPS_SETUP_CODE` | made by Render; copy it once to set up. Setup stays closed unless it looks like one Render made (32+ characters of the base64 alphabets): past the guessing limits a guess still gets right or wrong, so its length is what stops guessing. Press **Generate** to set up again. | `generateValue` |
| `OPS_SECRET` | made by Render; seals the authenticator key. Changing it means setting up again. | `generateValue` |
| `PLATFORM_SIGNING_KEY` | made by Render; opens desks. Its public half is each campaign’s `BASE_PLATFORM_PUBKEY` (see **base.win’s key**). `old,new` while changing; the first signs. | `generateValue` |
| `OPS_PUBLIC_TEMPLATE`, `OPS_INSECURE_COOKIES`, `OPS_ALLOW_LOCAL` | tests only | not listed |

## First time

The same six steps as GOING-LIVE.md section 8, *First time*, which has the
detail.

1. Render → Blueprints: see whether this repository is listed, which branch it follows and whether Auto Sync is on. If it is listed: after the name check in GOING-LIVE.md section 0, Manual Sync, and `base-platform` and `base-platform-db` appear. If none is listed, make the two by hand (GOING-LIVE.md section 8, step 1).
2. `base-platform` → Settings → Custom Domains → add `ops.base.win`, and a CNAME `ops` at the registrar.
3. Copy `OPS_SETUP_CODE`, open https://ops.base.win → **Set up**: the code, your name, email and password (12+), your authenticator app, then save the ten recovery codes. The email must be one only base.win support uses (you+support@…), never the one you sign in with on a campaign: that account has its own password there, so **Open desk** would be refused.
4. GitHub → Actions → *Promote to production*, if production is on a release from before the control centre (GOING-LIVE.md section 8, step 4, has what to check first). Imagine Surrey’s was, on 2026-11-24.
5. **base.win’s key → Copy**, and paste it as `BASE_PLATFORM_PUBKEY` on each campaign’s service, then **Save and deploy**.
6. **Add a campaign that’s already running** for each running campaign: its short name (Imagine Surrey’s is `imaginesurrey`, as in imaginesurrey.base.win), its name, and the Render address at the top of its service’s page. Then set the **Sample (staging)** address on Campaigns the same way.

**Open desk** works on a campaign only when both of these are true:

- the campaign runs a release that includes the control centre’s side of
  sign-in (step 4). A campaign on an older release shows “On a release
  from before base.win sign-in” on its page, and its set-up page says to
  Promote first;
- its `BASE_PLATFORM_PUBKEY` is set (step 5).

Health, the checklist and the log work before that.

## A new campaign

**New campaign**: its short name (its address will be `<name>.base.win`),
name, city, province, rules, time zone, races and map area. The map area is
two corners of a box around the city: in Google Maps, right-click the
bottom-left corner of the city and click the numbers to copy them, then the
same for the top-right corner.

Then four cards:

1. What to make in Render: a database, a service, and one block for **Add
   from .env**. Its two random values are made in your browser and never reach
   the control centre. The block starts the campaign with no opponents on its
   rating scale; they are added in the app.
2. The service’s Render address, pasted here.
3. **Give it its address**: Render → the new service → Settings → Custom
   Domains → add `<name>.base.win`; then, where base.win’s domain is
   registered, a CNAME record named `<name>` pointing at the service’s
   onrender.com address. Wait for the certificate.
4. **Invite the first manager**.

The checklist ticks itself as things start answering; “Answers at
`<name>.base.win`” ticks once the new address reaches the campaign’s server.
Under More there is a render.yaml block if you would rather we add it.

A campaign added with **Add a campaign that’s already running** has a shorter
set-up page: its settings already live in Render, so the page shows only the
`BASE_PLATFORM_PUBKEY` line to add and the address step.

## Opening a desk

**Open desk** opens a new tab on the campaign’s own Render address (not
`<name>.base.win`), signed in as **base.win support**, for 2 hours. It needs a
code from your app within the last 10 minutes; otherwise the new tab asks for
one. The token lives one minute, works once, and is checked by the campaign
itself (its key, its address, its environment, its instance). The campaign
sees every visit in History and on Today, and its managers can turn it off.

Every change made here (and every desk opened) is on **Log**, chained so a
changed or missing line shows.

## When things go wrong

Every Render change ends with **Save and deploy**, then wait for “Live”.

- **Lost your phone:** sign in with a recovery code. Codes gone too: Render →
  base-platform → Environment → `OPS_SETUP_CODE` → **Generate**, Save and
  deploy, then open ops.base.win/setup with the new code. Same operator, new
  password, app and codes; every console session ends and every browser is
  forgotten.
- **Known browsers:** a browser that has signed in keeps a mark for 90 days
  (a bearer cookie, nothing on the server to revoke one by one). From it,
  sign-in skips the per-email limit. A new browser doesn't: a stranger who
  knows your email can hold it at “Too many tries” (15 minutes at a time);
  use a browser you signed in with before, or set up again with a new
  `OPS_SETUP_CODE`. Setting up again and using a recovery code (at sign-in
  or at a code prompt) each forget every browser but the one that used it —
  the way to drop a lost or shared one. The wrong-code lock (20 wrong codes
  after a right password) forgets none: someone with your password could
  otherwise hold every browser at the email limit, recovery code and all.
  A copied mark lifts only the email limit for whoever holds it (password and
  code still needed, 20 tries per address in 15 minutes); drop it with a
  recovery code. Signing out keeps the mark.
- **Stop base.win sign-in on one campaign at once:** empty its
  `BASE_PLATFORM_PUBKEY`, Save and deploy. Entry stops and open visits end.
- **Changing the signing key:** first copy the current `PLATFORM_SIGNING_KEY`
  value somewhere safe. Then press Generate for a new value and set the field
  to `<old>,<new>` (the copied value, a comma, the new one); the old one
  still signs, so nothing stops. Paste the two keys
  **base.win’s key** shows into each campaign. When that page no longer
  lists anyone without the new key, set `PLATFORM_SIGNING_KEY` to `<new>`
  alone; later remove the old key from each campaign.
- **“Server changed: confirm it”:** the campaign’s database was rebuilt. Check
  it is the same campaign, then **Confirm it’s the same campaign**.
- **“This server says it is somewhere else”:** the Render address saved here
  isn’t the one the server reports. Fix it under More → Edit.
- **“On a release from before base.win sign-in”:** the campaign runs a
  release without the control centre’s side. GitHub → Actions → *Promote to
  production*, wait for “Live”, then **Check now**.
- **“`<name>.base.win` not answering”:** the campaign’s own address doesn’t
  reach it. In Render → its service → Settings → Custom Domains, check
  `<name>.base.win` is there, verified, with its certificate issued; at the
  registrar, check the CNAME record named `<name>` points at the service’s
  onrender.com address. The Render address still works meanwhile.
- **“`<name>.base.win` answers from another server”:** the address reaches a
  campaign server, but not this campaign’s. In Render, check
  `<name>.base.win` is under Custom Domains on this campaign’s service and
  on no other; at the registrar, check the CNAME record named `<name>`
  points at this service’s onrender.com address.
- **“Not on a real database”:** the campaign keeps its data in the built-in
  database, not in Postgres. On Render that means `STARBASE_EMBEDDED_DB=1`
  was set on its service: without it, a service with an empty
  `DATABASE_URL` does not start. Unless a disk is mounted for it, that
  data is lost at the next deploy. Set `DATABASE_URL` to its database’s
  Internal Database URL.
- **A new campaign never goes “Live”, or stays “Not answering”:** open its
  service’s log in Render. With `DATABASE_URL` empty the server refuses to
  start, and the log says so. Set `DATABASE_URL` to its database’s
  Internal Database URL (card 1, step 4), then Save and deploy.
- **“Sign-up is open to anyone”:** nobody has made the campaign yet, and the
  first person to open its address can. Set `BASE_PLATFORM_PUBKEY` on it
  (step 5 of First time; remove `STARBASE_OPEN_SIGNUP` if it is set), then
  **Invite the first manager** from here.
- **“Production is on …; staging is on …”:** staging has a release this
  campaign doesn’t. Nothing is wrong; GitHub → Actions → *Promote to
  production* when you want it there.
- **The control centre won’t start (“DATABASE_URL is empty”):** Render →
  base-platform → Environment → set `DATABASE_URL` to base-platform-db’s
  Internal Database URL.

## Tests

- `npm run test:platform` (and `npm run test:platform:pg` over Postgres):
  `apps/platform/test/*.test.mjs`.
- `e2e-ops.mjs` at the repo root (ports 5600–5609; system node, under the
  browser lock; `npm run build` first). Campaign “b” is a real campaign
  server (`node server/index.js`, in memory, holding base.win’s key): New
  campaign, Check now, then Invite and open the desk on it. The others are
  `test/fake-client.mjs`, which checks each token by the campaign side’s
  rules. One port stands in for every `<name>.base.win`
  (`OPS_PUBLIC_TEMPLATE`).
