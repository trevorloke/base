# base.win control centre (`apps/platform`, ops.base.win)

One sign-in for every campaign. From here you see whether each campaign is
answering, open any campaign’s desk already signed in, and set up new
campaigns step by step in the Render dashboard.

It is its own Render service (`base-platform`, Node, no Dockerfile) with its
own small database (`base-platform-db`). It holds no campaign’s database
address and nobody’s details, and it reads each campaign’s public
`/api/health`. No campaign ever calls it.

With `RENDER_API_KEY` set it also reads what Render says about each
campaign’s service and database, and makes a short list of named changes
there, each behind a code typed for it and on the log. It keeps no setting’s
value, reads no secret and never connects to a campaign’s database. Without
the key it walks you through Render by hand, as before. See **Render, from
the control centre** below.

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
| `RENDER_API_KEY` | optional: a Render key, pasted in Render and nowhere else. It turns on the **Render** page. A value with a space in it, or under 20 or over 200 characters, counts as none. | `sync: false` |
| `RENDER_SERVICE_ID` | set by Render on every service: this service’s own id there. Nothing can target it. | not listed |
| `OPS_PUBLIC_TEMPLATE`, `OPS_INSECURE_COOKIES`, `OPS_ALLOW_LOCAL`, `OPS_RENDER_API` | tests only | not listed |

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

With a Render key, once **Check Render’s answers** has opened it, card 1 is
**Make it in Render** instead, and cards 1 and 2 by hand move under More
(see “Making a new campaign here”, below).

A campaign added with **Add a campaign that’s already running** has a shorter
set-up page: its settings already live in Render, so the page shows only the
`BASE_PLATFORM_PUBKEY` line to add and the address step.

## Render, from the control centre

This part is off until a Render key is set. Without one, no page here has a
word about it, and the control centre walks you through Render by hand, as
before.

With `RENDER_API_KEY` set on `base-platform`, a **Render** page appears in
the menu:

- **Render** lists every campaign: its service, its last deploy, whether its
  database is open to the internet, and what needs a look.
- **Connect** ties a campaign to the one service in Render at its saved
  address, and that service's database. It changes nothing in Render.
- A connected campaign's page (its **Render: service, deploys, database**
  link) shows the service, the last deploy, its addresses, which settings
  are missing and who may reach its database. It has up to five buttons:
  **Deploy latest**, **Restart**, **Set base.win’s key**, **Add its address**
  (`<name>.base.win`) and **Close the database to the internet**.
- **Check Render’s answers** asks Render each question these pages rely on
  and says whether the answer came back as expected. It only reads.

Every button first shows a page that says what will happen and to which
service. Then it asks for a code from your app, typed for that one change:
the 10-minute window does not count here, and a recovery code is refused.
Each change is two lines on **Log** (“Asked Render to…”, then the result).
At most one change runs on a campaign at a time, 6 an hour per campaign and
30 a day in all.

What it never does, by design: it never deletes, suspends or resizes
anything; it never reads a secret (not a database address, not an email,
texting or Google key); it never lists a service's settings; it never
changes a setting that has a value, except base.win's own public key; it
takes no typed value; and Render is never asked anything on a timer, only
when you open one of these pages. It keeps Render's ids for a campaign's
service and database, and nothing Render answered.

### Making a new campaign here

Off until **Check Render’s answers** has run with Sample (staging)
connected and every line, including “Staging’s service / database, as a new
one is made”, came back as expected. That check reads staging's service and
database, which render.yaml made with the same words a new campaign is made
with (plan, region, PostgreSQL 16, Docker, the health check), and keeps
what it saw on **Log**. The newest check decides: a failing one, a release
that changes what is sent, or a key for another workspace turns it off
again. Off, the set-up page is as before and the two routes below are Not
found.

On, a new campaign's set-up page has **Make it in Render**. It says what it
makes (two paid things), asks for a code, then:

1. makes the database `base-win-<name>-db`, closed to the internet;
2. waits for Render to say it is ready (or stops: press **Carry on** later);
3. makes the service `base-win-<name>` from the production branch, with
   every setting from the campaign's own row in the creating call, so it
   never starts on the code's defaults. Render makes `STARBASE_TWO_STEP_KEY`
   and `GOOGLE_TOKEN_KEY` itself; the new database's address goes from
   Render to Render inside that one call and is kept nowhere here;
4. saves the service's Render address, as if pasted, and checks it;
5. adds `<name>.base.win` to the service.

Six lines say where it is: Database made, Database ready, Service made,
Address added, First build live, Answering. Each thing is looked for
before it is made, and its id saved and logged once made. If Render doesn't
answer a make, wait two minutes and press Carry on: it finds what Render
made and uses it; anything else under the name stops it, and nothing is
ever deleted. Two new campaigns a day at most. Campaigns added as already
running, campaigns set up by hand and the sample are never offered it.

A campaign made here can also have a missing setting of its own added
(**Add STARBASE_TZ** and so on, on its Render page), to the value from its
own row, then a deploy. A setting that has a value is never changed.

Not known until the first real one: how Render answers the two making
calls, whether it accepts `generateValue` there, and what a second thing
under a taken name does. Do the first one with a throwaway campaign and
made-up values.

**How sure are we of Render's API?** It is written from memory in one file,
`render-api.mjs`, and was built against a stand-in, not the real thing.
**Check Render’s answers** is how you find out: press it once the key is
in, then try each button on **Sample (staging)**, which holds only made-up
data, before any client. A wrong guess is fixed in that one file.

### Before the key

A Render key cannot be narrowed to some services or to "no delete". The
limits above are this code's, and hold only while the code beside the key
is ours. So, first:

1. Promote, so production holds this release.
2. `render.yaml`'s `base-platform` block says `branch: production`
   (committed right after the Promote, never before), and Render →
   `base-platform` → **Settings** shows Branch `production` and Build
   Command `npm ci --omit=dev --ignore-scripts`. A Blueprint sync writes
   `render.yaml`'s branch over a change made only in Render. **Render**
   warns until both are true.
3. GitHub: two-step sign-in on; protect `main` and `production` (no force
   push, CI required). Render: two-step sign-in on.
4. Render → each database → **Recovery**: read what your plan keeps.
5. Turn on Render's notifications (GOING-LIVE.md section 9).

### The key

- **Make it.** Render → your picture, top right → **Account Settings → API
  Keys → Create API Key**, named “base.win control centre” and the month.
  Copy it; Render shows it once.
- **Put it in.** Render → `base-platform` → **Environment → Add**
  `RENDER_API_KEY`, paste, **Save and deploy**. Nowhere else: not a chat,
  an email, a note, a file, GitHub or this console.
- **Try it.** ops.base.win → **Render** says Connected. Press **Check
  Render’s answers**. Connect **Sample (staging)** and press each button
  there first; then connect each campaign. On any campaign that says “Open
  to anyone on the internet”: **Close the database to the internet**.
- **Change it** every six months, after a lost laptop or phone, when anyone
  who could push code leaves, and on any doubt: make a new key, replace the
  value, Save and deploy, see Connected, then delete the old key in Render.
- **Turn it off.** Delete `RENDER_API_KEY` on `base-platform`, Save and
  deploy, then delete the key in Render. The control centre goes back to
  walking you through Render by hand.

### If the key may have leaked

1. Render → **Account Settings → API Keys** → delete the key. That ends it
   at once.
2. Change your Render password. Check two-step sign-in is on, and look at
   the other API keys and the members.
3. On `base-platform`, press **Generate** on `OPS_SETUP_CODE`, `OPS_SECRET`
   and `PLATFORM_SIGNING_KEY` (the key could read all three), Save and
   deploy, set up again, and put the new base.win key on every campaign.
4. For every service the key could see: new email, texting and Google keys
   at their providers; a new database password (in Render);
   `STARBASE_TWO_STEP_KEY` and `GOOGLE_TOKEN_KEY` changed the way their own
   notes say (the new value first, the old one after a comma).
5. In Render, look at each database's **Access Control** and each service's
   branch, repository, commands, addresses and **Events**. Whatever is not
   on the control centre's **Log** was not done by the control centre.
6. Treat each client's list as possibly copied: tell the client. Counsel
   decides what the privacy law asks.
7. Only then make a new key.

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
- The Render pages run against `test/fake-render.mjs`, a stand-in for
  Render's API that speaks at the same level as the real thing, so every
  test runs the real client (`render-api.mjs`). It keeps a list of requests
  the control centre must never make (a delete, a whole-settings read or
  write, a suspend, a setting off the readable list); every suite ends with
  that list empty. `test/nokey.test.mjs` holds five pages as they were
  before the key existed: when one of them changes on purpose, make the
  copies again (the command is at the top of that file).
  `test/render-make.test.mjs` is Make it in Render: the gate, then every
  step against every failure (refused, made but said it failed, made with
  no answer, listed late, the save failing, a new console), each ending
  with at most one database and one service under the name.
- `e2e-ops.mjs` at the repo root (ports 5600–5609; system node, under the
  browser lock; `npm run build` first). Campaign “b” is a real campaign
  server (`node server/index.js`, in memory, holding base.win’s key): New
  campaign, Check now, then Invite and open the desk on it. The others are
  `test/fake-client.mjs`, which checks each token by the campaign side’s
  rules. One port stands in for every `<name>.base.win`
  (`OPS_PUBLIC_TEMPLATE`). The run's first part has no Render key; then
  the key is set and the stand-in for Render listens on 5608. Last, it makes
  campaign “d” with Make it in Render; its server answers on 5609 once its
  first build is live.
