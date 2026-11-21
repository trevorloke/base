# base.win control centre (`apps/platform`, ops.base.win)

One sign-in for every campaign. From here you see whether each campaign is
answering, open any campaign’s desk already signed in, and set up new
campaigns step by step in the Render dashboard.

It is its own Render service (`base-platform`, Node, no Dockerfile) with its
own small database (`base-platform-db`). It never goes through the door. It
holds no campaign’s database address, no door key, no Render key and nobody’s
details: it reads only each campaign’s public `/api/health`. No campaign ever
calls it.

## Settings

| Setting | What | render.yaml |
|---|---|---|
| `DATABASE_URL` | its own database | from `base-platform-db` |
| `OPS_HOST` | `ops.base.win`; every other host gets a 404 (except `/healthz`) | value |
| `OPS_SETUP_CODE` | made by Render; copy it once to set up. Setup stays closed unless it looks like one Render made (32+ characters of the base64 alphabets): past the guessing limits a guess still gets right or wrong, so its length is what stops guessing. Press **Generate** to set up again. | `generateValue` |
| `OPS_SECRET` | made by Render; seals the authenticator key. Changing it means setting up again. | `generateValue` |
| `PLATFORM_SIGNING_KEY` | made by Render; opens desks. Its public half is each campaign’s `BASE_PLATFORM_PUBKEY` (see **base.win’s key**). `old,new` while changing; the first signs. | `generateValue` |
| `OPS_DOOR_ORIGIN`, `OPS_INSECURE_COOKIES`, `OPS_ALLOW_LOCAL` | tests only | not listed |

## First time

1. Render → Blueprints → Manual Sync: `base-platform` and `base-platform-db` appear.
2. `base-platform` → Settings → Custom Domains → add `ops.base.win`, and a CNAME `ops` at the registrar.
3. Copy `OPS_SETUP_CODE`, open https://ops.base.win → **Set up**: the code, your name, email and password (12+), your authenticator app, then save the ten recovery codes. The email must be one only base.win support uses (you+support@…), never the one you sign in with on a campaign: that account has its own password there, so **Open desk** would be refused.
4. **base.win’s key → Copy**, and paste it as `BASE_PLATFORM_PUBKEY` on each campaign’s service, then **Save and deploy**.
5. **Add a campaign that’s already running** for each running campaign; set the **Sample (staging)** address on Campaigns.

## A new campaign

**New campaign**: its short name (`base.win/<name>`), name, city, province,
rules, time zone and races. Then four cards: what to make in Render (one block
for **Add from .env**; its two random values are made in your browser and
never reach the control centre), the service’s Render address, the door’s
whole new `BASE_CLIENTS` value, and **Invite the first manager**. The
checklist ticks itself as things start answering. Under More there is a
render.yaml block if you would rather we add it.

## Opening a desk

**Open desk** opens a new tab on the campaign’s own Render address (not
base.win/<name>), signed in as **base.win support**, for 2 hours. It needs a
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

## Tests

- `npm run test:platform` (and `npm run test:platform:pg` over Postgres):
  `apps/platform/test/*.test.mjs`.
- `e2e-ops.mjs` at the repo root (ports 5600–5609; system node, under the
  browser lock; `npm run build` first). Campaign “b” is a real campaign
  server (`node server/index.js`, in memory, holding base.win’s key): New
  campaign, Check now, then Invite and open the desk on it. The others are
  `test/fake-client.mjs`, which checks each token by the campaign side’s
  rules.
