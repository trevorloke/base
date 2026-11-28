# Going live

The order to do things in, once per client, before the team signs in. Each
step says where it happens and how to tell it worked. The longer
explanations are in [TESTING.md](TESTING.md) (deploying, what to test by
role) and [README.md](README.md) (how each part works).

## 0 · Three environments

This is the one map of what runs where. The rest of this guide refers back
to it.

| Environment | Render service | Deploys from | Database | Address | What it is |
|---|---|---|---|---|---|
| **Staging** | `base-win-staging` | `main` | `base-win-staging-db` | `https://staging.base.win` | the sample campaign and the public demo; it says *Staging* on every screen |
| **Production**, one service per client | Imagine Surrey: `base-win` | `production` | `base-win-db` | `https://imaginesurrey.base.win` | the campaign's own desk, field app and website |
| | a new client: `base-win-<name>` | `production` | `base-win-<name>-db` | `https://<name>.base.win` | the same, for that client alone (section 6) |
| **Admin**, the control centre | `base-platform` | `production` | `base-platform-db` | `https://ops.base.win` | every campaign on one page, for base.win support (section 8) |
| The front page | a static site, set up by hand in Render (it is not in `render.yaml`) | `main` | none | `https://base.win` | the page `apps/front/index.html`; it frames staging's demo |

Each address is a custom domain on its service (section 2). A service also
keeps the address Render gave it, ending in `.onrender.com`.

**How code moves.** Every merge to `main` deploys staging by itself. The
front page deploys from `main` too. The control centre deploys from
`production`, with the clients. To move it on:
GitHub → **Actions** → *Promote to production* → **Run workflow**. It
fast-forwards the `production` branch to what `main` is now (or to a commit
you name), refuses while CI is red on that commit, and never rewrites
production.
Every client's production and the control centre deploy from that branch,
so one promote updates every client and ops.base.win together. Only code
moves this way, never data: each database stays where it is.

**Before a promote, check Imagine Surrey's brand line.** Render →
`base-win` → **Environment** must show `BASE_BRAND=imagine-surrey` (or
the same line under its older name, until it is renamed: section 10).
That line is what gives Imagine Surrey its own set-up: its look, opponents,
fields, membership, website and sample. With the line missing, a server
named exactly *Imagine Surrey* still gets it and says so once in its log
(*BASE_BRAND is not set on a server named Imagine Surrey*): add the
line. After the promote, open `https://imaginesurrey.base.win/api/health`
and read `"brand":"imagine-surrey"`. Every other client's reads
`"brand":"base"`.

**What the control centre does, and what it does not.** It watches every
campaign's health, opens any campaign's desk signed in as *base.win
support*, and walks you through adding a client in Render. With
`RENDER_API_KEY` set it also reads what Render says about each campaign's
service and database, and makes a short list of named changes there, each
behind a code typed for it and on the log. It keeps no setting's value,
reads no secret and never connects to a campaign's database. Without the
key it walks you through Render by hand, as before (section 8, *The Render
key*).

**Staging is public.** Anyone can open the demo on base.win, and is signed
in as the sample campaign's manager. So staging never gets a real email,
texting or payment key that can reach real people, and never a real list,
whole or in part. Its keys are test keys, or left unset. Try a change on
staging with the sample campaign's made-up people. Import only made-up
files there.

Everyone and everything in the sample is made up: the people's surnames,
their house numbers (9900 to 9999, which no street in the sample has), the
opponents on the rating scale and their elector organizations
(`server/lib/samplecast.js`). The street map is real: each person's dot sits
in the middle of their street, on a piece of the City of Vancouver's street
centreline (open data, under the Open Government Licence – Vancouver), never
on a house. A check runs every
day (GitHub → Actions → *Staging check*): it walks the demo as a visitor
does, and opens an issue when it finds a real name, phone number, email
address or link, or a live email or texting key.

**The sample makes itself again.** When a release carries a newer sample
(`SAMPLE_VERSION` in `server/lib/samplecampaign.js`), staging drops the old
one at its next start and makes the new one, by itself. It takes about a
minute (TESTING.md, *Staging*); a visitor in the demo meanwhile sees *The
demo is being refreshed* and is signed back in when it is done. Staging
does this only while its database holds one campaign and that campaign's
first manager is the demo account. If not, it drops nothing, and its log
says so. Then, and only then, set `BASE_SAMPLE_RESET` in Render
(base-win-staging → Environment) to a new word: any word this database
hasn't seen, of your own invention (for example `fresh-2026-11`). Nobody
issues it and it is not a secret. A new word drops everything in staging's
database and makes the sample again.

The same goes for map and translation keys (Google, Stadia, CARTO): every
demo visitor would draw on them. Staging gets base.win's own key, with a
daily ceiling set (`GOOGLE_TILES_DAILY_MAX`, `GOOGLE_PLACES_DAILY_MAX`), or
none. Never a client's: a client's key goes on its production only, and is
tried there with the team's own phones.

**One client, one production.** Each client has one production service and
one database, and they are that client's alone. There is one staging, and
it is shared: it is base.win's, not any client's.

**Before a Blueprint sync.** `render.yaml` is a Blueprint, and Render
matches it to what you have by name. We have not seen Render's dashboard,
so check there first; the steps below follow how Render documents its
Blueprints. Each time, in this order:

1. Render → **Blueprints**: see whether this repository is listed, which
   branch it follows and whether **Auto Sync** is on.
2. If Auto Sync is on, a merge to `main` (or to whichever branch step 1
   showed) that changes `render.yaml` syncs by itself, with nobody
   pressing anything. So do the name check (steps 4 and 5) before such a
   change is merged, or turn Auto Sync off first.
3. A sync applies the whole file, not only what changed. It makes
   `base-platform` and `base-platform-db` if they are missing (both paid),
   sets the plan of both campaign databases, sets each service's branch,
   and sets every setting that has a value in `render.yaml`: staging's sample, `NODE_ENV`,
   `BASE_ENV` and the control centre's address. A client's own
   settings are `sync: false`, so a sync leaves them as they are in Render.
   Every setting is listed under its `BASE_` name. Each older name a
   service may still have is listed too, as `sync: false` with no value,
   so a sync neither removes it nor writes over its value (section 10).
4. The name check. In Render, check the services are named exactly as
   `render.yaml` names them: `base-win-staging`, `base-win` and, once it is
   made (section 8), `base-platform`. Check the databases the same way:
   `base-win-staging-db`, `base-win-db` and, once it is made,
   `base-platform-db`.
5. Staging's Render address (top of its page in Render) still carries the
   name the service had when it was made; Render can never change that
   address, and nothing needs it changed (section 10, item 6). If a
   service's name still shows an old name, rename it in Render first: the
   service → **Settings → Name**. If a database's name does not match, do
   not sync until it does.
6. Only then Render → **Blueprints** → the Blueprint → **Manual Sync**. A
   sync that finds nothing under a name makes a second, empty one there.

If no Blueprint is listed, the services were most likely made by hand, and a change to
`render.yaml` reaches Render only when you make it there too. Do not make a
new Blueprint over them (**New → Blueprint**) without checking the names
match (steps 4 and 5): under a name it does not find, it makes a second,
empty service or database. The control centre can be made by hand instead
(section 8, *First time*, step 1).

**Before a release goes to staging or production,** check each service's
Environment for anything the release notes ask. On Render a campaign's
service must have `DATABASE_URL` set, or it does not start (section 1,
step 2). For Google Maps: **tell us Google or the free map for
canvassing.** Until then the free map stays: Google is the map only with
`GOOGLE_MAPS_TILES=on` and `GOOGLE_MAPS_SERVER_KEY` both set, so a key set
for address lookup does not change the map (§5, Recipe B). Google's map is
not kept on phones for no-signal areas.
For staging, with no synced Blueprint: set base-win-staging → Environment →
`BASE_CANDIDATES` to the exact line in `render.yaml`'s staging block (the
made-up Avendrel, Brindlemoor and Castramont). The sample saves those three
on its own Rating scale either way; the setting gives their buttons' longer
words. Then check that staging's `/api/scale` names those three.

**Production is every live client, and ops.base.win.** When we say
production, we mean every live client's campaign server and the control
centre at `https://ops.base.win`. One Promote updates all of them together.
(The control centre moves onto the `production` branch after the next
Promote; until then it updates from `main`.) A release replaces the app
only: it never changes a client's settings in Render and never erases its
data. Two checks keep that promise, and Promote waits for both to pass: one
fails if the app would drop, empty, rename or retype stored data when it
starts (`server/test/release-safety.test.js`, and the same for the control
centre); the other fails if `render.yaml` gives a client's own setting a
fixed value, which a Blueprint sync would write over
(`server/test/release-settings.test.js`).

## 1 · Deploy

1. Render → **Blueprints**: see whether this repository is listed, which
   branch it follows and whether Auto Sync is on (section 0, *Before a
   Blueprint sync*). If it is listed, a change to `render.yaml` is applied
   by a sync: by itself at the merge when Auto Sync is on, otherwise with
   the Blueprint → **Manual Sync**. Either way the name check in section 0
   comes first. If none is listed, the services were made by hand, and the
   change is made by hand in Render too. `render.yaml` holds
   `base-win-staging` (from `main`), `base-win` (from `production`) and
   `base-platform` (from `production`), each with its own database.
2. Wait for the deploy, then open the service's health page:
   `https://staging.base.win/api/health` or
   `https://imaginesurrey.base.win/api/health`. Staging's answer includes
   `"ok":true`, `"env":"staging"`, `"organization":"Sample Campaign"`,
   `"store":"postgres"` and `"tzdataCurrent":true`; production's says
   `"env":"production"` and `"organization":"Imagine Surrey"`.
   `"store":"postgres"` means the service is using its Render database. On
   Render a campaign's service with no database address does not start, and
   its log says why.
   `tzdataCurrent: false` means the server's time-zone rules predate B.C.'s
   permanent UTC-7 (every time after 1 Nov 2026 would show an hour off):
   redeploy on a newer Node image before going further.
3. **The first start after the person-search release** builds new search
   indexes on the people file. On a local 300,000-person copy that took
   about 2 seconds in all; on staging's database it took *(fill in from
   staging's boot log: the line `search: indexes ready in <n> ms`)*. While
   it builds, saving a person waits, and phones keep their saves in the
   outbox until it ends. Deploy outside canvassing hours. Anyone mid-call-
   list who sees *A new version is ready* taps Reload.
4. Going back to an earlier build (Render → **Rollback**) starts cleanly
   on the server: the database keeps what the older build expects to find.
   A build from before other websites (Website → Other websites) doesn't
   know them, so their pages show up among the main site's until you roll
   forward again. **Phones are not clean across the rename release
   (2026-12, section 10):** a phone that opened the new build keeps what it
   saves under the app's new storage name, which a build from before it
   does not read. Rolled back past it, such a phone shows nothing waiting
   to send, and its walk lists and letter drafts are out of sight (not
   lost) until you roll forward; signing out on the older build leaves them
   on the phone. So before rolling back past it, ask everyone in the field
   to send what is waiting (the outbox shows 0) and to sign out of shared
   phones, and roll forward as soon as you can. Rolled forward, everything
   waiting under either name is sent once; anything a volunteer entered
   again on the older build is sent twice, so check for doubled contacts.
   A phone signed in as two different people across the rollback opens
   asking who it is.

## 2 · Domains

| Address | Render service | What it serves |
|---|---|---|
| `staging.base.win` | `base-win-staging` | the sample campaign and the public demo |
| `imaginesurrey.base.win` | `base-win` | Imagine Surrey: the staff and volunteer app, the public forms, and the website under `/site/` |
| `ops.base.win` | `base-platform` | the control centre |
| `base.win` (and `www.base.win`, which sends people on to it) | the front page (a static site) | the page people see first, with staging's demo in it |
| `imaginesurrey.ca`, `www.imaginesurrey.ca`, once the campaign moves its website onto base.win | `base-win`, with `BASE_SITE_DOMAIN` (below) | the website made under **Website** in the admin, at `/`; nothing of the app answers there |

Each one is added under that service's **Settings → Custom Domains**, with
a CNAME at the registrar pointing at the address Render shows (for bare
`base.win`, the record Render shows for a root domain). Render issues the
certificates. On 2026-11-24 `staging.base.win`, `imaginesurrey.base.win`
and `base.win` were answering; `ops.base.win` was not set up yet (section
8, *First time*).

Imagine Surrey's app also has an older address under `imaginesurrey.ca`,
from before the rename; it is the one listed in `base-win`'s `APP_HOSTS`
(Render → `base-win` → Environment). We could not reach it on 2026-11-24.
If people still use it, keep it as a custom domain on `base-win` and in
`APP_HOSTS` (section 3); check that it answers before giving it to anyone.
Retiring it: section 10, item 10.

The website made under **Website** is live from the first deploy at the
app's own address, under `/site/` (`https://imaginesurrey.base.win/site/`),
so it can be checked before any DNS moves (SITE.md).

### Moving the campaign's domain onto base.win

Today `imaginesurrey.ca` is the present website (its own Render service).
On the day it moves, base.win's website answers there at `/` and
`imaginesurrey.base.win/site/` sends people to it. The desk stays at
`imaginesurrey.base.win`. The same steps work for any client. In this order:

1. **The website is ready** at `https://imaginesurrey.base.win/site/`: its
   pages, Authorized by and the privacy link. Make the present website's
   petitions again with the same address (`/act/<the same slug>`), so their
   links keep working.
2. **If the present website keeps running for a while** (its members' pages,
   its monthly gifts, the emails it already sent): on its own service set
   `NEXT_PUBLIC_SITE_URL` to its Render address (`https://<its
   service>.onrender.com`) and redeploy; point its Stripe webhook and its
   Twilio number at that address. Stripe and Twilio don't follow a redirect.
   Its two Render Cron Jobs (reminders and email, `apps/web/SETUP.md` §2b)
   call `https://imaginesurrey.ca/api/cron/…`: in each job's command, change
   `https://imaginesurrey.ca` to that address too. **If the present website
   stops instead,** delete those two jobs: after the move they would reach
   base.win, fail every day and hand it their key.
3. **Render → the present website's service → Settings → Custom Domains:**
   remove `imaginesurrey.ca` and `www.imaginesurrey.ca`. The domain is down
   from here until step 6 is done, so do steps 3 to 6 together.
4. **Render → `base-win` → Environment**, in one save, before the domain
   points here (without it the app's sign-in page would answer there):
   - `BASE_SITE_DOMAIN` = `imaginesurrey.ca`
   - `BASE_SITE_FORMER_URL` = the present website's Render address, only
     if step 2 (its own links in emails already sent go there)
   - remove `BASE_WEBSITE_URL` and `BASE_WEBSITE_KEY`: the
     unsubscribe sync is for a website hosted apart, and this one isn't any
     more. If they are left, nothing is sent and Settings → Services says to
     take them away.
5. **Render → `base-win` → Settings → Custom Domains:** add
   `imaginesurrey.ca` and `www.imaginesurrey.ca`.
6. **At the registrar:** the records Render shows for `base-win`.
7. **Check:**
   - `https://imaginesurrey.ca/` is the website; so is `/donate`.
   - `https://www.imaginesurrey.ca/` and
     `https://imaginesurrey.base.win/site/` go to `https://imaginesurrey.ca/`.
   - `https://imaginesurrey.ca/api/health` is the website's "Page not found".
   - An old link goes to the page that does the same thing:
     `https://imaginesurrey.ca/stats` goes home.
   - The desk works at `https://imaginesurrey.base.win`.
   - Settings → Services → *The website — unsubscribes* says Not set.
   - A test sign-up on the website lands in People.
   - If the present website keeps running: its two cron jobs pass on their
     next run.

`SITE_HOSTS` isn't needed with `BASE_SITE_DOMAIN`. Never put either in
`render.yaml`: a value there is written over at every sync.

**The way back**, if something is wrong:

1. First the domain leaves `base-win`: Render → `base-win` → Settings →
   Custom Domains: remove `imaginesurrey.ca` and `www.imaginesurrey.ca`; add
   them back on the present website's service, and the registrar's records
   with them. Keep `BASE_SITE_DOMAIN` set until this is done: without it
   the app's sign-in page would answer on the domain.
2. Once `https://imaginesurrey.ca/` is the present website again: Render →
   `base-win` → Environment: remove `BASE_SITE_DOMAIN` (and
   `BASE_SITE_FORMER_URL`). The website is at `/site/` again at once. A
   browser that saw the move may for up to an hour still send `/site/` on to
   the domain, which by then is the present website.
3. On the present website: `NEXT_PUBLIC_SITE_URL` back to
   `https://imaginesurrey.ca`, redeploy, and its Stripe and Twilio webhooks
   back; its two cron jobs back to `https://imaginesurrey.ca` (or made again
   from `apps/web/SETUP.md` §2b, if they were deleted).
4. On `base-win`: set `BASE_WEBSITE_URL` and `BASE_WEBSITE_KEY`
   again. Then Settings → Services → *The website — unsubscribes* →
   **Check**, and **Send the ones already off here**, so the unsubscribes
   made in between reach the present website.

**Another website** (a petition or contrast site such as dougdidnt.ca,
SITE.md "Other websites") takes one more custom domain on the service —
check the Render plan allows it. In this order: a manager saves the
address on the site (Website → the site → Domain); then add it in Render
(Settings → Custom Domains; Render adds its `www.`); then the DNS records
Render shows. A site that closes keeps its address saying "This website
has closed" until a manager releases it: remove the domain from Render
**before** releasing it, or the app's sign-in page would answer there.
Every page carries "Authorized by …" from Website → Settings →
Organization (the financial agent and how to reach them); a site can't
go live without it and the privacy policy link.

Until then the campaign's present site keeps `imaginesurrey.ca`; its
server can send sign-ups in with a website key from Settings → Services
(INTEGRATIONS.md, *The campaign's website*: the fields, the answers, an
example).

Its unsubscribes go both ways too. Make a long random secret (`openssl
rand -base64 32`). Set it on the website as its inbound key
(`BASE_WIN_INBOUND_KEY` in this repository's copy of the website; a
website still on older code reads the older name in
`apps/web/src/lib/old-names.ts`), and on this client's Render service as
`BASE_WEBSITE_KEY`, with `BASE_WEBSITE_URL` (the website's `https://` address, no path). Then
Settings → Services → *The website — unsubscribes* → **Check**, and send
the ones already off here. Take both settings away the day the website
moves onto base.win (*Moving the campaign's domain onto base.win*, step 4). (INTEGRATIONS.md, *Unsubscribes, both ways*.)

## 3 · Settings (Render → the service → Environment)

Set these on each campaign service before the first sign-in; the rest can wait.
Servers set up before 2026-12 may still have older names for these; they
keep working, and Settings → Services lists any to rename (section 10).
Every outside service, its settings and where each key comes from is in
[INTEGRATIONS.md](INTEGRATIONS.md). The campaign's own values
(`BASE_ORG_NAME`, `_JURISDICTION`, `_TZ`, `_CITY`, `_SLATES`) are set
on Imagine Surrey's service in Render; `render.yaml` lists them as `sync:
false`, with the value each was first given, so a sync never changes them.
Another client's come from the control centre's New campaign (section 6). So is the
brand: staging is `BASE_BRAND=base` with the name *Sample Campaign* in Vancouver, so it
can be shown to anyone; Imagine Surrey's production is `imagine-surrey`,
and every other client's is `base`. `imagine-surrey` turns on Imagine
Surrey's own set-up (README, *One campaign's own set-up*); `base` is a
campaign with nothing of anyone else's. Unset, or a word that names
nothing, is `base`. For the look, that is only where a campaign starts:
once a manager saves the campaign's own in **Settings → Brand**,
that one stays, whatever the setting says. A campaign already set up keeps
the name it was given: a manager renames it in **Settings → Campaign**.
`BASE_CANDIDATES` unset means nobody on a new rating scale (on Imagine
Surrey's server, its own five). New campaign writes `none` for a new
client, which says the same thing out loud. `BASE_CITY` unset means no
city, and `BASE_GEO_BOUNDS` unset means no map area: maps open wide and
the map's check says *Map area: Not set*.

| Variable | Set it to | Needed for |
|---|---|---|
| `BASE_ENV` | `staging` on the staging service, `production` on production (set by `render.yaml`) | the *Staging* badge; `/api/health` |
| `BASE_FRAME_HOSTS`, `BASE_DEMO_EMAIL`, `BASE_SAMPLE`, `BASE_SAMPLE_RESET` | staging only, and ignored on production: the sites that may frame the app; the account every demo visitor is signed in as at `/api/auth/demo`; `vancouver` to make the sample campaign on an empty database, and again by itself when a release carries a newer sample; and a new word of your own invention to drop everything in staging's database and make the sample again (only when the log asks for it: section 0) | the demo on the base.win website (`server/lib/demo.js`, `server/lib/samplecampaign.js`). Anyone who opens the demo can do whatever the demo account can, so that server holds the sample campaign and nobody real |
| `BASE_ORG_NAME`, `BASE_JURISDICTION`, `BASE_TZ`, `BASE_CITY`, `BASE_SLATES`, `BASE_CANDIDATES` | the campaign (README → *One deployment per client*) | the name the first sign-up sets up, the contribution rules, the campaign's day, addresses, the slates a gift can go to, the rating scale's first candidates |
| `BASE_PUBLIC_URL` | the service's own address from section 0: `https://imaginesurrey.base.win` (staging: `https://staging.base.win`) | every link in an email: invites, unsubscribe, receipts, password links (Forgot password is off without it); calendar links and files |
| `RESEND_API_KEY`, `MAIL_FROM` | from Resend; `Imagine Surrey <team@imaginesurrey.ca>` on the campaign's domain (Settings → Services → Email → *Sending domain* walks through its DNS records). Staging: a test key or unset, never a client's (section 0) | email; without it invites are shown to copy and sends wait as *queued* |
| `BASE_TWO_STEP_KEY` | 32 or more random characters (`openssl rand -base64 32`), a different one per environment | two-step sign-in's keys sealed with a key the database doesn't hold (INTEGRATIONS.md) |

Then, as each one is ready:

| Variable | Set it to | Needed for |
|---|---|---|
| `RESEND_WEBHOOK_SECRET` | the signing secret of the webhook added at Resend (below) | bounces and spam complaints coming back: a dead address is never emailed again |
| `MAIL_PROVIDER`, `SENDGRID_API_KEY`, `SENDGRID_WEBHOOK_PUBLIC_KEY` | only for a campaign that sends through SendGrid instead: `sendgrid`, its key, its Event Webhook's verification key (INTEGRATIONS.md) | email through SendGrid |
| `RESEND_REGION` | leave unset (`us-east-1`) unless the domain should be made in another Resend region | *Add domain* in Settings → Services |
| `MAILCHIMP_API_KEY`, `MAILCHIMP_AUDIENCE_ID`, `MAILCHIMP_WEBHOOK_SECRET` | from Mailchimp: the account's key, whole (its ending names the server); the audience's id only when the account has several; the signing secret *Connect* shows, once | only if the campaign builds its emails in Mailchimp: *Send to Mailchimp* on a list, unsubscribes and dead addresses kept in step both ways (INTEGRATIONS.md, *Mailchimp*) |
| `BASE_WEBSITE_URL`, `BASE_WEBSITE_KEY` | only while the campaign's website is hosted apart (section 2): its `https://` address, no path; the same secret the website holds as its inbound key (`BASE_WIN_INBOUND_KEY`, or its older name on a website still on older code). Set by hand on that client's service. Never on staging, never in the Blueprint | sends this client's unsubscribes and STOPs to its own website (INTEGRATIONS.md, *Unsubscribes, both ways*) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | from Twilio; for texts to a list in Canada the number should be a verified toll-free number or a short code (INTEGRATIONS.md). Staging: test credentials or unset, never a client's (section 0) | texting and calling through the campaign's number, SMS shift alerts; without them the phone's own apps are used |
| `GEOCODER` | leave unset (`bc`, the free BC Address Geocoder). `google` is no longer used for pins (Google's terms): take `GEOCODER=google` and `GEOCODER_FALLBACK=google` away | placing people on the map |
| `GOOGLE_MAPS_SERVER_KEY` | a Google Cloud key with application restriction **None** and API restriction to Map Tiles API and Places API (New) — not a *Websites* key, not an IP restriction on Render (§5, Recipe B). Staging: base.win's own key with a daily ceiling set, or unset, never a client's (section 0). **Tell us Google or the free map for canvassing.** The key alone does not make Google the map | Google Maps tiles with `GOOGLE_MAPS_TILES=on`; Google's address suggestions when turned on |
| `GOOGLE_MAPS_TILES` | `on` makes Google the map, with the key set (`GOOGLE_MAPS_TILE_TYPE` roadmap, satellite or terrain). Unset or `off`: the free map, until the owner chooses Google. Google's tiles are not kept on phones for no-signal areas (Google's terms) | the map's background |
| `GOOGLE_TILES_DAILY_MAX` | leave unset (no ceiling), or tiles a day after which phones turn to the free map until the campaign's midnight | a cap on Google's map costs |
| `GOOGLE_TRANSLATE_KEY` | a **separate** key in the same Google Cloud project, API restriction **Cloud Translation API** only, application restriction None; set a project quota on Cloud Translation "Characters per day" of 300,000 as a backstop. Then press Settings → Services → Translation → Check translation on the service that holds the key: production for a client's key. Staging: base.win's own key, or unset, never a client's (section 0) | the website in Punjabi and Chinese (SITE.md "Languages") |
| `ADDRESS_SUGGEST` | leave unset (the B.C. service suggests addresses, never Google). `google` only after counsel's or Google's written yes and with Google's logo in the build (§5, Recipe B) | Google's address suggestions as you type |
| `GOOGLE_PLACES_DAILY_MAX`, `GOOGLE_PLACES_PER_PERSON` | leave unset (300 Google asks a day, 50 a person), or whole numbers | keeping Google's suggestions inside its free use |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | the campaign's OAuth client (Google Cloud → Google Auth Platform → Clients → *Web application*, redirect address from **Settings → Services → Google**); staging gets its own project and client, never production's (INTEGRATIONS.md, *Google sign-in and connections*) | Sign in with Google, and every Google connection |
| `GOOGLE_TOKEN_KEY` | 32 or more random characters (`openssl rand -base64 48`), a different one per environment; keep a copy in the campaign's password manager | Gmail, Drive and Calendar connections (lost: everyone connects again) |
| `GMAIL_DAILY_MAX` | leave unset (100), or a whole number from 1 to 400 | emails a person may send from their own Gmail in 24 hours, every campaign on this server counted |
| `GOOGLE_PICKER_KEY`, `GOOGLE_CLOUD_PROJECT_NUMBER` | a browser API key limited to the campaign's public address and `https://docs.google.com/*` and to the Google Picker API; the project number (digits) of the project that holds the OAuth client (§7, *Google Drive and Sheets*) | Google Drive and Sheets |
| `BASE_TILE_PROVIDER`, `BASE_TILE_KEY` | `stadia` for Stadia Maps (address, credit and zoom filled in), and its key only if it can't be told the campaign's web address (§5, Recipe A) | the map's background, instead of the free tiles |
| `BASE_TILE_CARTO_KEY` | CARTO's free basemap key (§5, *The street map*) | the quiet *Clean* look; without it the map opens on OpenStreetMap's standard look |
| `BASE_TILE_CLEAN` | `off` | never offer CARTO, key or not (the free map behind Google stays) |
| `BASE_TILE_URL`, `BASE_TILE_ATTRIBUTION`, `BASE_TILE_MAX_ZOOM` | a tile provider the campaign has an agreement with: its `https://…/{z}/{x}/{y}.png` address, its credit line, its deepest zoom (§5, *The street map*) | the map's background, instead of the free tiles |
| `BASE_TRUSTED_PROXIES` | leave unset on Render (one proxy). Set to the number of proxies in front if there is a CDN before Render | rate limits reading the right address |
| `BASE_PLATFORM_PUBKEY` | the control centre's key: **ops.base.win → base.win’s key → Copy**, pasted here (never in `render.yaml` or git), then **Save and deploy** | **Open desk** from the control centre (section 8); while it's set and the campaign isn't made yet, sign-up here is closed — the control centre's first visit makes it |
| `BASE_OWN_URL` | only if Render's own address is missing: `https://<service>.onrender.com` | the address the control centre's sign-in must name (Render sets `RENDER_EXTERNAL_URL` itself) |
| `BASE_DOOR_KEY` | leave unset: it is only for the door (apps/door/README.md), which is not in use today. With the door, the same 32 or more random characters (`openssl rand -base64 32`) as the door's own | with the door only: each visitor keeping their own address for the sign-in and form limits |
| `BASE_SITE_DOMAIN` | the website's own domain, on the day it moves onto base.win (`imaginesurrey.ca`; §2, *Moving the campaign's domain onto base.win*). Never in `render.yaml` | the website at `/` there and on its `www.`, nothing of the app; `/site/` sends people there (SITE.md) |
| `BASE_SITE_FORMER_URL` | only while the present website keeps running at its own address: that address, `https://…` (§2) | its own links in emails it already sent, and its members' pages, still reach it |
| `SITE_HOSTS` | other domains of the campaign's website, if any; not needed with `BASE_SITE_DOMAIN` | the website at `/` there, nothing of the app (SITE.md) |
| `APP_HOSTS` | the app's other addresses on this server, comma-separated: an older address people still use, if there is one (Imagine Surrey's older app address, section 2); never the website's own domain | the app keeps answering there: none of them can be made the website's domain |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | from Stripe: **test** keys on staging first, and never live ones there; **live** keys on production only once a test gift has gone all the way through | gifts and membership dues paid online on the website (INTEGRATIONS.md, *Online payments — Stripe*) |
| `CALLHUB_API_KEY`, `CALLHUB_API_BASE` | from CallHub: the account's API key; the second only when the account's API is on another host than `https://api.callhub.io` | only if the campaign calls through CallHub's dialer: *Send to CallHub* on a list or a phone bank, each call's result back on the person (INTEGRATIONS.md, *Phone dialer — CallHub*) |

Google Calendar adds no setting: enable the Google Calendar API and add its
permission in the same Google Cloud project, then turn on **Settings →
Services → Google → Shifts in Google Calendar** (INTEGRATIONS.md, *Google
sign-in and connections*). Leave it off until Google has verified the app
if the console lists the permission as sensitive.

Twilio: set the number's incoming-message webhook to
`https://imaginesurrey.base.win/api/public/twilio/sms` (HTTP POST). The
other addresses Twilio calls back (delivery reports, calls) are sent with
each text and call, built from `BASE_PUBLIC_URL`; nothing else to set.
They answer at every address of the server, the website's own domain
included, so no domain setting can lose a STOP.

Email: Resend → **Webhooks** → add one at
`https://imaginesurrey.base.win/hooks/mail/resend` (Settings → Services
shows the exact address and the events to tick) and put its signing secret
in `RESEND_WEBHOOK_SECRET`. From then on a bounce or a spam complaint takes
the address off every later send, and a send says how many were delivered.

Mailchimp: nothing to paste into Mailchimp by hand. With the key set,
**Settings → Services → Mailchimp** → **Check**, then **Connect** (it gives
Mailchimp the address unsubscribes come back to, built from
`BASE_PUBLIC_URL`, and shows a signing secret once, for
`MAILCHIMP_WEBHOOK_SECRET`). It then asks before the first pull — the
audience's name and how many people on file it would turn off for good
(with nobody on file yet, it asks once the supporter file is in): make sure
it is the audience the campaign's emails go to, and tap **Turn their email
off here**. It was built against
Mailchimp's published API and has not been run against a real account:
before the first real list, try it on one of your own team's addresses
(INTEGRATIONS.md has the steps and what is not confirmed).

Stripe: Developers → **Webhooks** → add an endpoint at
`https://imaginesurrey.base.win/stripe/webhook` (Settings → Services
shows the exact address and the ten events to tick) and put its signing
secret in `STRIPE_WEBHOOK_SECRET`. The keys go in the host's environment
only — never in the repo, a chat or an email. Test mode first: on staging,
test keys and Stripe's test card; the desk says *Test mode* until live keys
are in.

CallHub: nothing to paste into CallHub by hand. With the key set, **Settings
→ Services → Phone dialer (CallHub)** → **Check**, then **Connect** (it
gives CallHub the address results come back to, built from
`BASE_PUBLIC_URL`). It was built from CallHub's published
documentation and has not been run against a real account: before the
first calling night, make one test call and see its result arrive on the
person (INTEGRATIONS.md has the steps and what is not confirmed).

Google sign-in: the one client, set up once, before Gmail, Drive or
Calendar (each adds its own permission and API to it afterwards):
1. At console.cloud.google.com, create **one project** for the campaign
   (for example "base.win – Imagine Surrey"). With Google Workspace,
   create it inside the imaginesurrey.ca organization, so it belongs to
   the campaign, not to one person. Staging gets its own second project.
2. Google Auth Platform → **Branding**: the app name people see
   ("base.win" or the campaign's), a support email the campaign controls,
   and a home page and privacy policy on the domain of
   `BASE_PUBLIC_URL`. Add that domain under **Authorized domains** and
   verify it in Google Search Console. The privacy policy is the
   campaign's to write: it says what base.win does with Google sign-in,
   Gmail, Drive, Calendar and Maps, and that its use of Google data
   follows Google's API Services User Data Policy, including the Limited
   Use requirements.
3. **Audience**: *Internal* only if everyone signs in with an
   @imaginesurrey.ca Workspace account; otherwise *External* and
   **Publish app**. Never leave production in *Testing* (connections end
   every 7 days).
4. **Data access**: add `openid`, `.../auth/userinfo.email` and
   `.../auth/userinfo.profile`.
5. **Clients → Create client → Web application**, named "base.win", with
   the one redirect address **Settings → Services → Google** shows
   (`<BASE_PUBLIC_URL>/api/auth/google/back`) and no JavaScript
   origins. Copy the client id and secret into Render at once
   (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`; Google shows
   the secret only once), and set `GOOGLE_TOKEN_KEY`.
6. **Settings → Services → Google → Check**.

Gmail (one email to one person, from a staff member's own Gmail), after
the Google client above, in the same Google Cloud project:
1. APIs & Services → Library → enable **Gmail API**. (Skipped, every send
   fails and Services says *Gmail API is off in Google Cloud*.)
2. Google Auth Platform → **Data access**: add `.../auth/gmail.send`, next
   to `openid`, `.../auth/userinfo.email` and `.../auth/userinfo.profile`.
   Nothing else for Gmail. The audience is the one the whole Google setup
   shares (INTEGRATIONS.md, *Gmail*): Workspace + Internal needs no Google
   review; External and published but not reviewed shows staff Google's
   warning and lets no more than 100 people ever connect Gmail; reviewed
   by Google, neither.
3. **Settings → Services → Google → Check** must pass first. Then
   **Services → Gmail**: say how Google is set up, and turn on *Let the
   desk send from their own Gmail*.
4. Each staff member: **Your profile → Google → Connect Gmail**, then
   **Send me a test**. On Workspace, *Your Google Workspace admin hasn't
   allowed base.win* means the admin marks the client **Trusted**.

**Check them.** After the first sign-in (below): **Settings → Services** in
the admin lists every service, says which settings are missing, and
**Check** calls each one for real — the email sender's key, domain, DMARC record and webhook, the Twilio
number and where its replies go, the address service, Google's tiles, the
public address and the database.

## 4 · First sign-in

The first sign-in lands in the **admin** (`/admin/`); the field app at `/` is
what volunteers get, and what you see under *Field app ↗* in your account menu.

1. Open `https://imaginesurrey.base.win/login` → **Set up base.win for
   Imagine Surrey** (the name `BASE_ORG_NAME` gives; a deployment that
   gives none asks for it here). The first account is the manager; this
   creates the campaign's workspace (its jurisdiction's rules, the
   contribution limit seeded, its time zone) and closes sign-up. Everyone
   else joins by invite. Staging needs none of this: its sample campaign
   makes itself (section 3, `BASE_SAMPLE`), and its sign-up stays closed
   to everyone else.
2. **Today** shows a banner if the server's time-zone data is stale (step 1)
   so a manager can't miss it.
3. **Admin** (from the account menu, your initials): under **Members**
   invite the staff and treasurer first, volunteers later once the lists
   are in; under **Teams** group them (a crew per neighbourhood, the phone
   bank); under **Permissions** decide which areas each role, or one person,
   may use.
4. **Outreach → Connections**: the campaign's website address, which the
   public pages (unsubscribe, public lessons) link back to.

With `BASE_PLATFORM_PUBKEY` set (section 3), skip step 1: open the campaign
from the control centre instead (**Open desk**, or **Invite the first
manager**), which makes the campaign and signs you in as *base.win support*.

## 5 · The lists and the map

1. **People → Import**: a CSV or spreadsheet, up to 300 MB in the browser.
   Map the columns, run a dry run first (it reports matches, new people and
   anything it couldn't read), then import. The list's own columns map by
   themselves (house number and street, latitude and longitude, the 1/0
   flags, and the standard fields named after them); social handles
   (Instagram, X, TikTok, Reddit, Facebook, LinkedIn, YouTube, Bluesky,
   Threads, or one column of profile links) fill blank ones only, and a
   cell that isn't a handle or a profile link is left out and counted.
   Before you record social media handles and follower counts, say so on
   the website's /privacy page: that the campaign records the handles and
   follower counts people share with it or that are public on their
   profiles, and why. Removing a handle removes its count; the full export
   carries both.
   Share kits (Outreach → Sharing): save the authorization line under
   Website → Settings first — every post offers it in its words, and the
   editor reminds that pictures should carry it (base.win never draws it on
   a picture). Ask the official agent whether supporters' shares of a
   campaign-made post need the line, and whether to stop a post on general
   voting day. Save the website's own domain so the links read well; until
   then they use the app's /site address.
2. Placing starts by itself: an import that leaves addresses without a pin
   starts a background run (**Place on map** is there where it didn't
   start). The import page shows its progress and the time left, the map
   says *Placing addresses · 12,400 of 150,000*, and it carries on with the
   page closed. If address lookup stops answering it pauses and tries again
   by itself (15 minutes later, then less often); the map says *Placing
   addresses paused*. A run an older release paused gets its next try when
   this release starts. Addresses the geocoder can't place are set aside for a
   pin by hand (drag on the map). Someone with no address at all is never
   put on the map.
3. Open the map on a phone as a volunteer: tap a house, rate the door, see
   it save; turn on airplane mode, do it again, turn it off, watch it send.
4. Gifts taken in another tool this year: **Donations → More → Import
   donations** (a manager or the treasurer), before the first gift is taken
   here, so the year's contribution limit counts them. Take refunded
   payments out of the file (with a payment status column they're left out
   for you). Check first: a gift already typed in here by
   hand is pointed out, to leave out; the gifts with no sure donor
   wait under **Needs you** to be settled. Then the financial agent types
   their filing dates under **Donations → More → Filing dates** — base.win
   knows none.
5. Tell volunteers about **Show → Share my location while I'm out** on the
   map: it's off until they turn it on, and while it's on the managers'
   dashboard (Today) shows where they are. Location needs the site on
   `https` (every host in section 2 is). A position is kept only while they
   share it, a trail for the day; neither is in the export.
5. **Map → Show → Map check** (managers): one sheet with the people on
   file, on the map and not (and why), the placing run, how many live
   outside the campaign's area, the turfs, the street map in use and whether
   its tiles came, and whether this page is the server's current one.
   Nothing should be flagged. If anyone says the map looks empty, ask for a
   screenshot of this sheet: the flagged line says which trouble it is.

6. **Re-importing the voters list after people have moved**: base.win keeps
   moved people where your team put them. Someone marked with a new address
   or *Address unknown* is found by the old address the list still has, so
   no second copy is made at the old door and their address isn't filled
   back in. The import's answer says how many (*moved_kept*) and lists the
   first 50: the name, the address in the list and the one on file (or
   *address unknown*). If the list is right and the team was wrong, fix the
   address on the profile.
7. **Paper walking lists** (Reports → Quick reports → Walking list, or
   Print on a turf's walk list at the desk) are for a canvasser without a
   phone. They show names, addresses and the last support answer, never a
   phone number or an email, and say *Private — bring this sheet back to
   the office.* Bring them back, and type the results in on the turf's
   walk list. A turf with more than 6,000 people in its box must be split
   on the map before it prints.
8. **Hi-rises: three numbers, once**, after the voters list is in. In
   Render → **base-win** → **Shell**, run `node scripts/hr-counts.mjs`. It
   only reads (the database refuses any change while it runs) and prints
   three lines, with no names or addresses:
   - *Located doors*: addresses with a pin, one per unit.
   - *Addresses with 4 or more units*: the ones the map shows as a building.
   - *People with the unit inside the address* (like `1203-13450 104 Ave`).

   Send the three lines to the team. If the second number is under 50, the
   building layer will rarely appear on your map: say so before more
   hi-rise work is done.

### The street map: choose a provider before election week

The map's street tiles go straight from a provider to each phone; base.win
only says which. Out of the box the map opens on OpenStreetMap's standard
look; CARTO's quieter *Clean* look needs the campaign's own free key:

| Look | Provider |
|---|---|
| *Standard* (what the map opens on), *Muted*, *Dark* | OpenStreetMap's own tile servers (`tile.openstreetmap.org`) |
| *Clean* (only with `BASE_TILE_CARTO_KEY`; then the map opens on it) | CARTO's light basemap (`basemaps.cartocdn.com`) |

**CARTO needs a key since late August 2026.** Without one, CARTO answers
every tile with a picture reading "API KEY REQUIRED" on a blank background
instead of streets (other projects broke the same way: Home Assistant
issue #180277, opened 26 August 2026; CARTO's FAQ, read through a search
extract, describes it word for word). That is why the Map showed voter dots
on blank grey from 9 November. To have *Clean* back:

1. Request CARTO's free basemap key at carto.com/basemaps/apikey (the
   owner's step; ask CARTO in writing whether a municipal elector
   organization counts as commercial use — reported caps: 1,000,000
   requests a month commercial, 5,000,000 non-commercial).
2. Set `BASE_TILE_CARTO_KEY` on the campaign's production service in
   Render. (Staging takes base.win's own key or none, never a client's:
   section 0.) Phones can see it, as CARTO's browser keys are meant to be
   used.
3. Open Map → Show → Map check: the picture under *Street map* shows
   streets.

`BASE_TILE_CLEAN=off` now means only "never offer CARTO"; the free map
behind Google stays. If a provider ever sends a notice instead of streets
again, the map says *The street map isn’t showing streets*, and the Map
check shows the picture this phone got (see INTEGRATIONS.md, *If the map is
blank*). After this update, each volunteer should open their turf on the
Map once with signal, so the streets are kept for no-signal areas (phones
had kept CARTO's notices instead; they drop them by themselves).

Neither is meant for heavy use. **We could not read either provider's
current terms from where this was written** (both sites were out of reach),
so what follows is what we remember, not their wording. OpenStreetMap's
servers are run by volunteers on donated machines; its tile usage policy
does not allow heavy use and lets it block a user without notice. CARTO's
free basemaps are for light or non-commercial use, with a paid licence
above that. A campaign's field app in election week is plausibly neither
light nor non-commercial. Read OpenStreetMap's *Tile Usage Policy*
(operations.osmfoundation.org) and CARTO's basemap terms (carto.com) before
relying on either.

Before election week, choose a provider the campaign has an agreement with,
by one of the two recipes below, and set it on the campaign's
**production** service. Staging is public (section 0): it gets base.win's
own key with a daily ceiling set, or none, never a client's. Each Render
service has its own settings, so a key set on one is not on the other. Try
the campaign's key on production, with the team's own phones.

Some facts below (prices, free allowances, plan terms, what counts as
enough credit) were read only from search snippets of the providers' own
pages, not the pages in full: their sites could not be reached from where
this was written. Check them on the provider's site.

#### Recipe A — Stadia Maps (a paid provider, straight to the phones)

1. Make an account at stadiamaps.com and choose a paid plan that allows
   commercial use (the free plan is reported to be non-commercial). Check
   the current price and credits on its pricing page (reported: Starter,
   about US$20/month, 1,000,000 credits).
2. Under billing, **turn on overage, or at least set a usage alert.**
   Overage is reported to be off by default: past the plan's credits the
   map would stop with errors in election week, not charge more.
3. Under *Manage Properties → Authentication Configuration*, add **only the
   campaign's own hostnames**, each in full: its base.win address
   (`imaginesurrey.base.win`), its Render address and its own domain. Do
   not add bare `base.win`: other campaigns' addresses end in it too, and
   their maps could then draw on this account. If Stadia will not take the
   full name alone, use a key instead (step 4, last line).
4. On the campaign's production service in Render set
   `BASE_TILE_PROVIDER=stadia` and save: the address, Stadia's credit
   line and zoom 20 are filled in. Not on staging: its address is not on
   this account's list (step 3), and a client's account is never used
   there (section 0). Only if domain authentication cannot be used, also
   set `BASE_TILE_KEY=<key>`; phones can see that key.
   (Stadia's credit is the one its documentation is reported to show; its
   site could not be read from where this was written.)
5. Open **Map → Show → Map check**: the street map line names Stadia Maps
   and counts tiles loaded, and *Street map service* says *Stadia Maps ·
   straight to the phones*.

Why choose it: no key on the server, no load on the server, and the same
quiet look as *Clean*. **What it does not settle:** neither Google's nor
Stadia's terms clearly allow phones to keep tiles for offline canvassing
(Stadia's general terms are reported to prohibit bulk caching). Phones
already keep tiles they have drawn. Get that answer from the provider **in
writing** before relying on offline maps.

#### Recipe B — Google Maps (through the server)

**Tell us Google or the free map for canvassing.** Google is the map only
with `GOOGLE_MAPS_TILES=on` and `GOOGLE_MAPS_SERVER_KEY` set. Unset or
`off`, the free map stays, and phones keep it for no-signal areas; with
Google they do not. Until the owner chooses Google, leave
`GOOGLE_MAPS_TILES` unset (or `off`) on staging and production.

1. Go to console.cloud.google.com and create (or pick) the project. If the
   campaign's domain is on Google Workspace, create it inside that
   organization so it belongs to the campaign, not to one person. It can be
   the same project as Google sign-in's.
2. Under *Billing*, link a billing account. Google asks for a card even for
   the free use; without billing, Maps answers 1 request a day.
3. Under *APIs & Services → Library*, enable **Map Tiles API** and, if
   Google's address suggestions are planned, **Places API (New)**. The
   **Geocoding API** is no longer used: turn it off if nothing else uses it.
4. Under *APIs & Services → Credentials*, the server key (or *Create
   credentials → API key*), then *Edit*:
   - **Application restrictions: None.** Not *Websites*: that breaks every
     server call. Not *IP addresses*: Render's shared outbound addresses
     change, and fixed ones are a paid add-on.
   - **API restrictions: Restrict key** to Map Tiles API and Places API (New).
   - Save. The key never leaves the server.
5. **Quotas** (*APIs & Services → each API → Quotas*). Map Tiles API *2D
   tiles per day*: the campaign's choice (3,225 a day is the free 100,000 ÷
   31, too low for a canvassing day; 20,000 a day caps tiles at about
   US$300 a month). Places API (New): if it offers per-day quotas, 322 a day
   each for Autocomplete and Place Details (the free 10,000 ÷ 31) unless
   the campaign pays for more; if it offers only per-minute quotas,
   Autocomplete 60 a minute, and base.win's own `GOOGLE_PLACES_DAILY_MAX`
   (300 a day by default, kept across restarts) is the daily stop. Under
   *Billing → Budgets & alerts*, a monthly budget with emails at 50%, 90%
   and 100% (a budget warns; only quotas and base.win's ceilings stop
   spending).
6. On the campaign's production service in Render, set
   `GOOGLE_MAPS_SERVER_KEY=<the key>` (no spaces) and save; set
   `GOOGLE_MAPS_TILES=on` only if Google was chosen for the map. A client's key
   never goes on staging: staging is public, so it gets base.win's own
   key with `GOOGLE_TILES_DAILY_MAX` and `GOOGLE_PLACES_DAILY_MAX` set,
   or none (section 0). Optional:
   `GOOGLE_PLACES_DAILY_MAX` (default 300), `GOOGLE_PLACES_PER_PERSON`
   (default 50), `GOOGLE_TILES_DAILY_MAX` (default none; past it phones turn
   to the free map until midnight). Do not set `ADDRESS_SUGGEST=google` yet
   (below).
7. Run **Settings → Services → Map background → Check** and **Address
   suggestions (Google Places) → Check** (it tests the key even while
   suggestions are off). If one says it isn't working, the line says what
   failed in plain words, *Google said* gives Google's own words, and *see
   Going live §5, Recipe B step N* says which of steps 2–6 to redo.

No Google verification or review is needed for Maps: it is a key, not a
Google sign-in.

**What Google's terms change.**
- *No offline Google tiles.* Google allows no offline use of its tiles, so
  phones no longer keep them: with no signal a Google map shows the doors
  on a blank background (the free map is still kept where it is in use).
  Tiles carry Google's own cache rules.
- *No Google pins.* Google's geocodes may be kept 30 days only, not shared
  and not drawn on another map; base.win's pins are kept, shared and drawn
  on the free map. Pins come from the free B.C. Address Geocoder:
  `GEOCODER=google` now places with B.C. and `GEOCODER_FALLBACK=google` is
  ignored (both said on Services; take them away in Render).
- *Google's address suggestions only once confirmed.* With
  `ADDRESS_SUGGEST=google`, the address box offers Google Places' rows (the
  pin still comes from B.C.). It stays off until counsel or Google confirm
  in writing that saving the words a person picks is allowed, and that
  sending typed addresses (often a voter's) to Google fits the rules on the
  list of electors; and Google's logo file is in the build
  (`web/public/google/google-maps-logo.svg`, unaltered from Google's
  attribution page): without it Google's rows never show.

The map's credit reads *Google Maps · Map data ©… Google*, Google's own
words for the part of the map on screen (Google's policy, as read from
snippets, accepts the words "Google Maps" where a phone map has no room for
its logo).

While Google refuses, volunteers keep streets: the map turns to the free
map by itself and says *Google Maps isn’t loading — showing the free map*
(a manager gets *Why?* beside it, which opens the Map check), and goes back
to Google once it answers. The free map is CARTO's with
`BASE_TILE_CARTO_KEY` set (and `BASE_TILE_CLEAN` not `off`),
otherwise OpenStreetMap's; it is always there, and no setting removes it.
If it refuses too, the map says *The street map isn’t loading*, as before.

Cost, as far as could be read: 100,000 tile requests a month free, then
about US$0.60 per 1,000; Places Autocomplete 10,000 free, then US$2.83 per
1,000, and Place Details 10,000 free, then US$5.00 per 1,000. A phone draws
roughly 12–20 tiles per screen. Settings → Services shows today's tiles and
asks; watch the first busy weekend in Google Cloud → Metrics too.

When Google refuses (a bad key, billing off, the API not turned on, the
usage limit used up), base.win stops asking it for a minute (30 seconds
after the usage limit) instead of asking again for every tile on every
phone, then tries once more. A key pasted with a space or a new line at
the end, and `GOOGLE_MAPS_TILES` set to `1`, `true` or `yes`, work the
same as the plain values; unset, `0` or `off` keeps Google off quietly. A Google
answer slower than its limit is not a refusal: that tile fails and the next
is asked. Places is paused 10 minutes after a key, API or billing refusal
(60 seconds after the usage limit), and the B.C. service suggests meanwhile.

#### How to tell it works

- **Settings → Services → Map background** is named after the map in use
  (*Google Map Tiles*, *Stadia Maps*, *OpenStreetMap*), and its **Check**
  says ✓ *Working* for Google, or that the tiles come straight to each phone.
- On a phone, at a door: the street map draws, and **Map → Show → Map
  check** names the street map in use with its tiles loaded; its *Street
  map service* and *Address lookup* lines say *Working* (or, flagged at the
  top, what failed, what Google said and the step that fixes it).
- Do this on production, with the team's own phones. On staging only with
  base.win's own key, never a client's (section 0).

The foot of the map's Show sheet also says *Map tiles: …*. If a provider stops answering, the map says so: it switches
once by itself to the other free provider where there is one and it
answers (with weak signal neither does, and the streets the phone kept stay
drawn), then shows *The street map isn’t loading* with one tap to try
again (or to try the other, when it has just answered). The phone goes
back to the look the person picked — the one whose streets it keeps — as
soon as the other stops loading too, with no signal, or once the pick
answers again.
With a provider of the campaign's own there is no second one to fall back
on — so test it on production, on a phone, before the week it matters.

No test of ours has drawn the real street map: the browser tests run where
the tile hosts can't be reached, on stand-in tiles. Look at it on staging.

### Faith, Dwelling type and Campus

This part is Imagine Surrey's (its 27 fields). A campaign on
`BASE_BRAND=base` starts with ten fields, Faith and Dwelling type among
them as lists already, and no Campus; nothing is added to it at a later
start. A campaign set up before that rule keeps what it was given:
`node server/neutral-report.mjs` in the service's Shell lists it (it only
reads).

On Imagine Surrey's server every campaign gets **Faith** (Private) once, and an empty Dwelling type or
Campus becomes a pick list by itself, at the first boot (a background job).
A Dwelling type or Campus with words on file stays Text until a manager
turns it into a list: People → More → Profile fields → *Turn into a list*,
go through *Needs you* (a bare "Apartment" or "Kwantlen" can't be
guessed), then **Turn into a list** — do it when nobody is importing;
nothing is lost (what doesn't fit stays in "… as written"). If the
campaign keeps Faith, its privacy notice should say so, why, and how to
have it removed, and that the change history keeps old values. Only a
manager's backup and download carry Faith; staff and treasurers get
theirs without it.

## 6 · A new client

Each client is its own production service and its own database, at its own
address, `https://<name>.base.win` (section 0). Nothing is shared, and the
code names no client.

1. Use the control centre's **New campaign** (ops.base.win). It walks every
   step in the Render dashboard and ticks a checklist as each part answers:
   - the campaign's values: its short name (the `<name>` in its address),
     name, city, province, rules, time zone, races and map area (two
     corners of a box around the city);
   - the database and the service to make in Render (`base-win-<name>-db`
     and `base-win-<name>`, from the `production` branch), with one block
     to paste into Render's Environment;
   - the new service's Render address, pasted back into the control centre;
   - the client's own address: the new service → **Settings → Custom
     Domains** → add `<name>.base.win`, then at the registrar a CNAME named
     `<name>` pointing at the address Render shows.

   No git and nothing to hash (`apps/platform/README.md`).
2. **Invite the first manager** there opens the new desk and invites them.
3. One `main` serves everyone: a change lands on staging, and *Promote to
   production* moves it to every client's production at once. A client
   that must stay on an older version is a second `production-<name>`
   branch for its production service — avoid it unless they ask.

Some short names are kept for base.win itself and can't be a client's:
`staging`, `demo`, `ops`, `www` and the others the control centre refuses.

The fallback, for us: New campaign's page also writes that client's own
block for `render.yaml` (*Or ask us to add it to render.yaml*): its names
(`base-win-<name>`, `base-win-<name>-db`), its `BASE_*` values,
`BASE_BRAND=base` and `BASE_CANDIDATES=none`. Paste that block.
Never copy `base-win`'s own block: it is Imagine Surrey's, and its
`BASE_BRAND=imagine-surrey` setting would give the new client Imagine
Surrey's set-up. The block gives those `BASE_*` lines as `sync: false`,
each value after its `#`: set each value on the new service in Render
(Environment) before its first sign-in. A fixed value there would be
written over at every sync, and the release-settings check refuses it.
Commit on `main`.
The change reaches Render by a Blueprint sync, so go through section 0,
*Before a Blueprint sync*, first: whether a Blueprint is listed, whether
Auto Sync is on, and the name check. If none is listed, make the database
and the service by hand, as New campaign's first card says, and do not
make a new Blueprint over the services that are there. Then set
`BASE_PUBLIC_URL` to `https://<name>.base.win` and add the custom
domain as in step 1.

## 7 · Before the public link goes out

- `https://imaginesurrey.base.win/` loads over https and signs in.
- Forgot password, once, on production with your own account: **Forgot your
  password?** → your email → the link in the email → a new password → you're
  in. *This campaign can’t send email yet* means production has no email key
  or no `BASE_PUBLIC_URL`.
- A test newsletter reaches a real inbox with a working unsubscribe link.
- Set the campaign’s mailing address, an email or phone, and the financial
  agent in **Website → Settings**: they go at the bottom of every email. Until
  the address is set, the compose says *No mailing address yet*.
- Press releases from media@: once MAIL_FROM is on imaginesurrey.ca and
  **Settings → Services → Email → Sending domain** says Verified, tap *Add
  media@imaginesurrey.ca for press* under **From addresses** (Resend and
  SendGrid verify the domain, not each address). Give media@ a real
  mailbox or forwarding where the campaign's email is hosted first:
  reporters reply to it, and base.win receives no mail. Then **Media →
  Write a release → Send me a test**.
- Letters: fill in your papers under **Media → Outlets** — check each one's
  rules on its own page or by phone, tick what it asks a writer for, and
  tap *I checked these today*. base.win ships with none. Put people on Op-ed
  editors, Letters editors and Show hosts, and write short talking points
  for writers (facts and links, never a letter to copy).
- A test gift logged under **Donations** gets its receipt emailed.
- Online giving, on staging in test mode: a gift once, a monthly gift and a
  membership go through Stripe's page and show under **Donations** marked
  *online*, each with its receipt; a refund from Stripe's dashboard voids its
  gift. Then live keys on production, one small real gift, and refund it.
- Backups: check what Render keeps for the production database (section
  9, *Getting data back*). **Today → Export all data** (managers) downloads
  everything (message pictures are not in it); it takes data out, it is
  not a restore.
- Watching: failure notifications and an outside uptime check are on, and
  the databases are closed to the internet (section 9).
- The map, on production, on a phone and a desk: streets behind the doors,
  the whole list as a picture with its key, doors by zoom 15; **Show → Map
  check** with nothing flagged (section 5); and the street map's provider
  chosen for election week.
- Two-step sign-in: on for you (**Your profile**, from the account menu)
  and **Require two-step sign-in for desk roles** ticked under **Settings →
  Members** (it covers volunteers given an area under Permissions, and
  candidates, too);
- Candidates: each one added under **Settings → Candidates** (name, office,
  race, email) and invited; a Mayor race with its own Path to win numbers
  needs `BASE_SLATES` to name it (e.g. `mayor:Mayor,council:City
  council`). A candidate who must also work the desk needs a second account.
  Before anyone uses **call time**, your financial agent confirms against
  Elections BC's *Guide to Local Elections Campaign Financing* that the
  yearly limit is one limit for the organization and its endorsed
  candidates together (call time's room assumes so), that candidates only
  log pledges, and the 60 days after which an unpaid pledge leaves Needs
  you. Two-step (above) matters here: candidates see donors' giving.
  **Settings → Services** shows the two-step key set up.
- Google: `BASE_PUBLIC_URL` is the https address people use, the
  redirect address from **Settings → Services → Google** is in the client's
  *Authorized redirect URIs* (when the public address changes: the new one
  in Google first, then Render), the audience is published (not Testing),
  and **Check** says *Working*. If
  the campaign uses Google Workspace, its admin marks the base.win client
  *Trusted* (Admin console → Security → API controls). Sign in with Google
  once on production; repeat every four months so Google never deletes an
  idle client.
- Keys: every key above is in Render only, never in the repo or a chat.
  Anyone who leaves the campaign is removed under **Admin → Members**, which ends their
  sign-in everywhere at once.

#### Google Drive and Sheets

Drive uses the Google sign-in client above (same project, same client, same
`GOOGLE_TOKEN_KEY`). It asks for one permission, *only the specific Google
Drive files you use with this app* (`drive.file`), which needs no Google
review. Sheets stay **off** until a manager chooses who may send: decide with
your counsel first whether voter data may go to Google Drive.

1. Google Cloud → APIs & Services → Library: enable **Google Drive API**,
   **Google Sheets API** and **Google Picker API** in the project that holds
   the OAuth client.
2. Google Auth Platform → **Data access**: add
   `https://www.googleapis.com/auth/drive.file`. Nothing else for Drive.
3. APIs & Services → Credentials → **Create credentials → API key**. Websites:
   the campaign's public address (`https://imaginesurrey.base.win/*`) and
   `https://docs.google.com/*`; API restriction: **Google Picker API** only.
   Each campaign gets its own project and key; staging's, if it has one,
   is in staging's own project with staging's address.
4. IAM & Admin → Settings: copy the **Project number** (digits, not the ID).
5. Google Auth Platform → Audience: if External, **Publish app**. In Testing
   every Drive connection stops after 7 days.
6. Render, each service: `GOOGLE_PICKER_KEY` and `GOOGLE_CLOUD_PROJECT_NUMBER`.
7. On Google Workspace: mark the client *Trusted* if third-party apps are
   restricted, and decide whether Drive files may be shared outside the
   campaign's domain.
8. Before staff may send to Sheets: a **shared drive** (Workspace only) with
   the managers and staff as members, and a folder in it.
9. In base.win: **Settings → Services → Google Drive and Sheets → Check**,
   then under More **Try opening Google Drive** (it works while Drive is
   still off, for managers only); turn Drive on; pick the shared-drive folder; leave *Who can send to Google
   Sheets* on **No one** until counsel has answered.

## 8 · base.win support (the control centre)

Every Render step ends with **Save and deploy** (not *Save only*), then
waiting for *Live* (2–3 minutes).

### First time

The control centre is not set up until these are done, in this order:

1. Render → **Blueprints**: see whether this repository is listed, which
   branch it follows and whether Auto Sync is on (section 0, *Before a
   Blueprint sync*).
   - **A Blueprint is listed:** after the name check in section 0, the
     Blueprint → **Manual Sync**. It makes `base-platform` and
     `base-platform-db`. With Auto Sync on, the merge that changed
     `render.yaml` has done this already: check the two are there.
   - **None is listed:** make the two by hand, with the settings in
     `render.yaml`'s `base-platform` block.
     1. Render → **New → Postgres**: name `base-platform-db`, region
        Oregon, PostgreSQL 16, the Basic-256mb plan (as `render.yaml` says).
     2. Render → **New → Web Service** → this repository: name
        `base-platform`, language Node, branch `production`, region Oregon,
        instance Starter. Build command `npm ci --omit=dev
        --ignore-scripts`, start command `node apps/platform/server.mjs`,
        health check path `/healthz`.
     3. Under **Environment**: `NODE_VERSION` = `22`, `NODE_ENV` =
        `production`, `OPS_HOST` = `ops.base.win`, and `DATABASE_URL` =
        `base-platform-db`'s **Internal Database URL**.
     4. Add `OPS_SETUP_CODE`, `OPS_SECRET` and `PLATFORM_SIGNING_KEY`,
        pressing **Generate** for each value.
     5. **Create Web Service**, and wait for *Live*.
2. `base-platform` → **Settings → Custom Domains** → add `ops.base.win`. At
   the registrar, add a CNAME named `ops` pointing at the address Render
   shows.
3. `base-platform` → **Environment** → copy `OPS_SETUP_CODE`. Open
   `https://ops.base.win` → **Set up**, with an email only base.win support
   uses (you+support@…), never the one you sign in with on a campaign. It
   asks for the code, your name, that email and a password, and your
   authenticator app, then shows recovery codes to keep.
4. **Promote to production** first (section 0) if production is older than
   the control centre. Imagine Surrey's was, on 2026-11-24. **Open desk**
   needs the campaign to run a release that knows the control centre.
   Before this Promote, do the release check in section 0 on `base-win`
   (`DATABASE_URL` set; `GOOGLE_MAPS_TILES` unset or `off` unless the
   owner chose Google; `BASE_PUBLIC_URL` is `https://imaginesurrey.base.win`) and
   run it outside canvassing hours (section 1, step 3).
5. In the control centre: **base.win’s key** → **Copy**. Paste it as
   `BASE_PLATFORM_PUBKEY` on `base-win` and on `base-win-staging` (Render →
   the service → Environment), then **Save and deploy** on each.
6. **Add a campaign that’s already running**: short name `imaginesurrey`,
   its name (Imagine Surrey), and its Render address (at the top of
   `base-win`'s page in Render, ending in `.onrender.com`). Then set the
   **Sample (staging)** address on Campaigns: staging's Render address
   (top of `base-win-staging`'s page in Render, ending in `.onrender.com`).

### Day to day

- **Open a campaign's desk:** ops.base.win → the campaign → **Open desk**. A
  new tab opens on that campaign's own Render address, already signed in as
  *base.win support*, with a bar across the top. Sign out from the bar when
  done; a visit also ends by itself after 2 hours. Each visit shows on that
  campaign's managers' Today (the last week), and every change it makes is
  tagged on the campaign's log; on a person's History, the doors, calls,
  sign steps, voted marks and merges it made say *(via base.win)*.
- **The control centre's email** must be one only base.win support uses
  (you+support@…), never the one you sign in with on a campaign: an
  account the campaign made with its own password is never taken over, so
  **Open desk** there is refused (*email-in-use*).
- **Kept out of ops.base.win on a new browser** ("Too many tries" while a
  stranger spends the per-email limit): sign in from a browser you used
  before, or press **Generate** on `OPS_SETUP_CODE` (base-platform), Save and
  deploy, and set up again. Setting up again and a recovery code each forget
  every browser but the one that used it; the wrong-code lock forgets none,
  so a browser you used before still gets in with a recovery code.
- **A campaign's managers can stop it** any time: Settings → Members →
  **base.win may sign in here** off. That also ends a visit in progress.
- **Stop all base.win sign-in on one campaign, at once:** empty
  `BASE_PLATFORM_PUBKEY` on its service, then Save and deploy. Entry stops,
  and open visits end.
- **Changing the control centre's signing key:**
  1. Copy the current `PLATFORM_SIGNING_KEY` (base-platform → Environment)
     somewhere safe first.
  2. Press **Generate** on it, then set it to `<old>,<new>`: the old value,
     a comma, the new one. The first value still signs.
  3. On each campaign's service, set `BASE_PLATFORM_PUBKEY` to what
     **base.win’s key** now shows — both public keys, the new one first
     (`<new>,<old>`) — then Save and deploy. A campaign accepts either.
  4. When **base.win’s key** no longer lists a campaign without the new key,
     set `PLATFORM_SIGNING_KEY` to `<new>` alone.
  5. Later, remove the old public key from each campaign. That also ends any
     visit the old key opened.
- **"base.win sign-in not set up"** on a campaign: `BASE_PLATFORM_PUBKEY` is
  missing there, or its deploy hasn't finished (press **Check now** once it
  says *Live*). **"Key in Render is wrong"**: copy base.win’s key again.

### The Render key

Optional. Without it the control centre is as described above, and no page
there has a word about this.

With a Render key on `base-platform`, the control centre gets a **Render**
page: every campaign's service, last deploy and database on one page, and
five buttons per campaign (**Deploy latest**, **Restart**, **Set base.win’s
key**, **Add its address**, **Close the database to the internet**). Each
button first says what it will do, then asks for a code from your app,
typed for that one change; each change is on the control centre's **Log**.
It cannot delete, suspend or resize anything, reads no secret and takes no
typed value (`apps/platform/README.md` has the whole list).

A Render key cannot be narrowed to some services, or to "no delete". Those
limits are the control centre's own code, so the key is only as safe as the
service that holds it. Do these in order.

**Before the key.**

1. Promote (section 0), so production holds this release.
2. `render.yaml`'s `base-platform` block says `branch: production`
   (commit it on `main` right after the Promote, never before: production
   older than the control centre has no `apps/platform`). Then Render →
   `base-platform` → **Settings** shows Branch `production` and Build
   Command `npm ci --omit=dev --ignore-scripts`. A Blueprint sync writes
   `render.yaml`'s branch over a change made only in Render, so both must
   say `production`. The control centre then goes through Promote like
   everything else, and no package's install script runs beside the key.
   The **Render** page warns until both are true.
3. GitHub: two-step sign-in on; protect `main` and `production` (no force
   push, CI required). Render: two-step sign-in on.
4. Render → each database → **Recovery**: read what your plan keeps
   (section 9).
5. Turn on Render's notifications (section 9).

**Make the key.** Render → your picture, top right → **Account Settings →
API Keys → Create API Key**, named “base.win control centre” and the month.
Copy it; Render shows it once.

**Put it in.** Render → `base-platform` → **Environment → Add**
`RENDER_API_KEY`, paste, **Save and deploy**. Nowhere else: not a chat, an
email, a note, a file, GitHub or the control centre itself.

**Try it.** ops.base.win → **Render** says Connected. Press **Check
Render’s answers**: the control centre's idea of Render's API was written
from memory, and this is where it is checked against the real thing. Each
line should say *As expected*; tell us any that does not. Connect **Sample
(staging)** and press each button there first, since staging holds only
made-up data. Then connect Imagine Surrey. On any campaign that says “Open
to anyone on the internet”: **Close the database to the internet**.

**Making a new campaign from here.** Once **Check Render’s answers** has
run with Sample (staging) connected and every line matches, a new
campaign's set-up page offers **Make it in Render**: it makes the campaign's
database and service in Render (Render bills for both from that day), with
that campaign's own settings, then adds `<name>.base.win`. Each press asks
for a code; it may ask you to press **Carry on** once while Render gets the
database ready. It never makes two of anything: if Render doesn't answer,
wait two minutes and press Carry on, and it looks before it makes. Until
that check, the set-up page walks you through Render by hand, as before; a
later check that fails, or a release that changes what is sent, turns it
off for new campaigns until you check again. A campaign already part made
keeps its card, paused: press Check Render’s answers again, then Carry on.
Don't make its database or service by hand. Do the first one with a throwaway
campaign and made-up values, then delete it by hand in Render (its DNS
record first). The CNAME record where base.win's domain is registered is
still yours to add.

**Change it** every six months, after a lost laptop or phone, when anyone
who could push code leaves, and on any doubt: make a new key, replace the
value, Save and deploy, see Connected, then delete the old key in Render.

**Turn it off.** Delete `RENDER_API_KEY` on `base-platform`, Save and
deploy, then delete the key in Render. The control centre goes back to
walking you through Render by hand.

**If the key may have leaked.** Whoever holds it can do anything your
Render login can, from anywhere, with no line on the control centre's log.

1. Render → **Account Settings → API Keys** → delete the key. That ends it
   at once.
2. Change your Render password. Check two-step sign-in is on, and look at
   the other API keys and the members.
3. On `base-platform`, press **Generate** on `OPS_SETUP_CODE`, `OPS_SECRET`
   and `PLATFORM_SIGNING_KEY` (the key could read all three), Save and
   deploy, set up again, and put the new base.win key on every campaign.
4. For every service the key could see: new email, texting and Google keys
   at their providers; a new database password (in Render);
   `BASE_TWO_STEP_KEY` and `GOOGLE_TOKEN_KEY` changed the way their own
   notes say (the new value first, the old one after a comma).
5. In Render, look at each database's **Access Control** and each service's
   branch, repository, commands, addresses and **Events**. Whatever is not
   on the control centre's **Log** was not done by the control centre.
6. Treat each client's list as possibly copied: tell the client. Counsel
   decides what the privacy law asks.
7. Only then make a new key.

## 9 · Keeping watch

**Know when something is down.** Render → each service and each database →
**Notifications**: turn them on for failures. With a Render key on the
control centre (section 8), also look through each service's **Events** in
Render from time to time: that record is Render's own, and the control
centre cannot write it. Then set up an uptime check
outside Render, so you hear about it even when Render does not, on:

- `https://imaginesurrey.base.win/api/health`
- `https://staging.base.win/api/health`
- `https://ops.base.win/healthz`

Add `https://<name>.base.win/api/health` for each new client. A campaign's
health page answers with an error (503) when its database can't be
reached, so the check catches that too.

**Who can reach the databases.** Render → each database → **Access
Control**. Remove `0.0.0.0/0` if it is listed: that entry lets any address
on the internet try to connect. With it gone, only Render's own services
connect. Add one address only while someone needs it, and take it away
after. With a Render key on the control centre (section 8), its **Render**
page says which databases are open to the internet, and **Close the
database to the internet** removes that entry for you.

**Getting data back.** Render keeps point-in-time recovery or daily
backups, according to each database's plan. We have not checked what your
plan keeps or for how long: open the database → **Recovery** in Render and
read it before you rely on it. The app's own export (**Today → Export all
data**) is for taking data out. Nothing loads an export back in, so it is
not a restore.

## 10 · The older setting names

base.win's settings are all named `BASE_…` now (`BASE_TZ`, `BASE_BRAND`,
`BASE_TWO_STEP_KEY` and so on). A server set up before 2026-12 may have
its settings in Render under their older names, and they keep working. base.win reads the new name first and the older one while
the new one is blank, so no campaign loses a setting and nobody is signed
out. Nothing below is needed on the day of the release, and nothing breaks
if any of it waits.

**Where an older name shows,** and only while it is still set:

- the campaign's **Settings → Services**, first row, *Older setting names
  still on this server*: each older name, with the new name to copy its
  value to, and, once the new name is set too, whether the two differ
  (the new one is used, so check it before deleting the older one);
- the server's start-up log: one line per older name ("the setting … still
  works; rename it to … in Render"), and one line when both names are set
  and differ ("… is used": always the new one; for `BASE_TWO_STEP_KEY`,
  "both are used for now"). The log never shows a value;
- the control centre's **Render** board and each campaign's Render page:
  the older names still set on that service, names only, each with its new
  name. That is your checklist. `base-platform` (the control centre itself)
  has none.

**render.yaml.** Every setting is listed under its new name. A value
`render.yaml` fixes (staging's sample settings, and `BASE_ENV` on staging
and `base-win`) is fixed under the new name only. Each older name a service
may still have stays listed, as `sync: false` with no value, so a Blueprint
sync can neither remove it nor write over what Render holds under it. A new
name a sync leaves blank counts as not set, so the older name's value is
still the one used.

The owner's to-do:

1. **Before the first Blueprint sync of this release** (section 0, *Before
   a Blueprint sync*): write down every `sync: false` value on
   `base-win-staging` and `base-win` (Render → the service → Environment),
   in your password manager, since some are keys; never in the repository
   or a chat. Nothing in this release expects a sync to remove a setting.
   This is so any one can be put back exactly if Render ever does.
2. **GitHub, the day the rename pull request opens.** GitHub → the
   repository → Settings → Branches: if a rule requires a check under its
   older name, change it to `base-win`. We could not see that setting from
   here. If there is no such rule, skip this.
3. **Render settings, any time after the release is on production.** On
   each campaign service (`base-win`, `base-win-staging`, and any other
   client), for each older name its Settings → Services lists:
   1. If the new name is not set yet: Render → the service → Environment,
      add the new name and paste **exactly the same value**, copied, not
      retyped. Save, and deploy. Where `render.yaml` already gives the new
      name its value (staging's sample settings, `BASE_ENV`), there is
      nothing to add: check the new one is there.
   2. Check the campaign still shows the same brand, name, time zone and
      map area in Settings → Services, that its *Older setting names* row
      does not say the setting "is set and differs" (or, for
      `BASE_TWO_STEP_KEY`, "does not hold the same key"), and that its
      start-up log has no "both set and differ" line for that setting.
   3. Delete the older name. Save, and deploy. Settings → Services no
      longer lists it.

   If a later sync ever shows an older name again with no value, leave it:
   a blank setting counts as not set. Three settings need extra care:
   - **`BASE_TWO_STEP_KEY`:** copy the exact value. **Never press
     Generate.** Delete the older name only once Settings → Services says
     `BASE_TWO_STEP_KEY` "holds every key" the older name holds; the
     *Two-step sign-in key* row also says if a value under either name is
     too short to use. While both names are set, both keys work, and
     everyone who signs in is moved onto the new name's key. So if the new
     name was given a different value (Generate, or a character missing),
     **keep both**: do not delete the older name, and do not take the new
     value away either (that would lock out whoever signed in since). Put
     the older name's value into the new name as well, after a comma
     (`<what it holds>,<the older value>`), deploy, check the row says it
     holds every key, and only then delete the older name.
   - **`BASE_WEBSITE_KEY` (`base-win` only, while the website is hosted
     apart):** copy it exactly. It must still match the key the website
     holds, or unsubscribes stop reaching the website.
   - **`BASE_SAMPLE_RESET` (staging only):** copy the same word. A word
     staging hasn't seen before drops everything in staging's database and
     makes the sample again (section 0).
4. **The website's settings in Vercel: leave them.** The live website is
   built from its own repository and knows only its three older names (for
   base.win's address, its key and the inbound key;
   `apps/web/src/lib/old-names.ts` lists them). It retires on the
   `imaginesurrey.ca` move. Rename them only if this repository's copy of
   the website is ever deployed there first; that copy reads both names.
5. **Names that are not in the code.** Render already calls the services
   `base-win`, `base-win-staging` and `base-platform`, and the databases
   `base-win-db`, `base-win-staging-db` and `base-platform-db`. Check three
   places we could not see, and rename any that still use the product's
   first name: the Render Blueprint or project that groups them; any Render
   environment group; the Google Cloud project and its OAuth app.
6. **The `.onrender.com` addresses.** Render gives every service a
   permanent machine address ending in `.onrender.com`, from the name the
   service had when it was made. Staging was made under the product's first
   name, so its machine address still carries it, and **Render can never
   change it**: renaming the service changed only the name shown. Nobody
   uses that address; people use `staging.base.win`. It shows at the top of
   the service's page in Render and in the control centre, which uses it to
   check it is talking to the right server. The server's public
   `/api/health` answer names it only to a caller who asked at that very
   address (the control centre does); asked at `staging.base.win` or any
   other address, it says `"ownOrigin": null`. The only way to a clean one is
   a fresh staging service (staging holds only made-up data): a separate
   small job, with a new service, `staging.base.win` pointed at it, the
   control centre updated and the old service deleted. For `base-win`,
   look at the top of its Render page; if its machine address has the old
   name too, the same applies, but moving production to a new service means
   moving its database and domains. We don't recommend it.
7. **Google's sign-in settings.** Google Cloud console → APIs & Services →
   Credentials → your OAuth client: if Imagine Surrey's older app address
   (item 10) is among the authorized addresses, remove it after that
   address is retired.
8. **Render log searches.** If you saved a Render log search or alert for
   the older log prefix, change it to `base.win:`.
9. **Imagine Surrey's privacy page.** The page as saved on its website
   still names the database by the product's first name. A release never
   changes a saved page. The new wording for the paragraph under *Who we
   share it with* ("…copied into our own organizing database, base.win…")
   is sent to you separately to approve; on your yes it is changed in
   Website → Pages as a normal, recorded edit.
10. **Imagine Surrey's older app address** (under `imaginesurrey.ca`, from
    before the rename; it is in `base-win`'s `APP_HOSTS`, section 2). We
    could not reach it on 2026-11-24. On the `imaginesurrey.ca` move, or
    sooner if you confirm nobody uses it:
    1. First, Vercel → the website → its settings: look at the setting for
       base.win's address. If it is that older address, change it to
       `https://imaginesurrey.base.win`, redeploy, and send one test
       sign-up from the website; check it reaches the desk. Only then go on.
    2. Remove it from `base-win`'s `APP_HOSTS`.
    3. Remove it from `base-win`'s custom domains in Render.
    4. Remove its DNS record.

    Phones keep their saved work per address. If any volunteer still used
    that address, open the app there once, online, before removing it.
11. **Stage 2 in the control centre: nothing to do.** The rename does not
    change how new campaigns are made in Render, so stage 2 stays as it is.
12. **Old backups.** Exports downloaded before the rename have the older
    file name; they are still good. New downloads are named
    `base-win-export.json`.

## What base.win does on its own

- Sign-in: 30 tries per address and 10 failures per email in 15 minutes,
  then a wait. Sessions last 30 days and end at sign-out or removal.
  Two-step codes: 20 wrong in a row (across sign-ins and restarts) lock the
  account's app codes until a recovery code or a manager's reset; the
  person and the managers are emailed and the managers' Today says so.
- Public forms: rate-limited per address; a request's body is capped.
- Email: every newsletter carries the reader's own unsubscribe link and the
  headers mail apps use for their Unsubscribe button; an unsubscribed
  address cannot be added back by the desk.
- Donations: contributions are checked against the Elections BC limit per
  contributor (confirm the seeded figure with Elections BC before filing).
- Online payments: checked against the limit before Stripe's page opens and
  again when the payment lands — one that would go over is refunded through
  Stripe by itself, the donor is told, and the treasurer sees it (after a
  dispute lost for only part of it, Stripe won't refund the rest: Needs you
  says how much to return by hand); one over only with another record that
  may be the same donor (or a cheque logged after it) is flagged for the
  treasurer to decide — *Not the same person* clears it when they are two
  people. Stripe's webhook is refused without its signature, and each event
  is done once.
