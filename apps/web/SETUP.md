# Going live on Render

This guide takes Base Web (one client's public website and its admin) from this repository to a live site on Render: a Docker web service, a Render Postgres database, two cron jobs, Stripe, and the client's own domain. Allow about an hour. You need a Render account, Stripe, and (for image uploads) a Supabase project used only for Storage.

Base Web is a product. Each client gets its own copy: its own web service, database and domain. **Imagine Surrey** is the first client; a new client's deployment starts as a clean, neutral site in the **Civic** look (step 2).

## 1. The pieces on Render

Every client has a production and a staging copy (SUITE.md). For a client with the slug `imaginesurrey`:

| Render resource | What it is |
| --- | --- |
| `base-web-imaginesurrey` | Web service, Docker, from the `production` branch |
| `base-web-imaginesurrey-staging` | Web service, Docker, from `main` |
| `imagine-surrey-db` | Render Postgres for production (Imagine Surrey's existing database, Oregon) |
| `base-web-imaginesurrey-staging-db` | Render Postgres for staging |
| `base-web-imaginesurrey-reminders`, `base-web-imaginesurrey-email` | Cron jobs for the two daily jobs (and the same pair with `-staging`) |

### The web service

- **Runtime:** Docker. **Build context:** `apps/web`. **Dockerfile:** `apps/web/Dockerfile`. **Region:** Oregon (the same as the database, so it uses the private connection string). **Plan:** Starter or larger (always on).
- **Health check path:** `/api/health`. It answers `{ "ok": true, "service": "base-web", "commit": "<git sha>" }` from the process alone.
- **What a deploy does.** The image is built with **no database and no secrets**: public pages render when they are asked for, reading through the site's hour-long data cache. When the new container starts, it brings the database up to date (pending migrations, then the seed, which only adds missing rows and never overwrites anything changed in `/admin`) and only then starts the server. If that step fails, the container exits, the deploy fails, and the current site stays live. It runs on every Render deploy except pull-request previews; set `SKIP_DB_MIGRATE=1` to turn it off.
- **Time zones.** The image carries current ICU time-zone rules (`tzdata/`, `ICU_TIMEZONE_FILES_DIR`), so Pacific times stay right after BC's move to permanent UTC-7.

The Blueprint entries (for the root `render.yaml`; production shown, staging is the same with `-staging` names, `branch: main` and its own database):

```yaml
  - type: web
    name: base-web-imaginesurrey
    runtime: docker
    plan: starter
    region: oregon
    branch: production
    dockerContext: ./apps/web
    dockerfilePath: ./apps/web/Dockerfile
    healthCheckPath: /api/health
    autoDeploy: true
    buildFilter:
      paths: ["apps/web/**"]
    envVars:
      - key: DATABASE_URL
        fromDatabase: { name: imagine-surrey-db, property: connectionString }
      # The client, fixed into the build (a change needs a new deploy).
      - key: BASE_WEB_CLIENT
        value: imagine-surrey          # leave unset for a new client
      - key: BASE_WEB_JURISDICTION
        value: bc
      - key: NEXT_PUBLIC_SITE_URL      # the public address, e.g. https://imaginesurrey.ca
        sync: false
      - key: ADMIN_SESSION_SECRET
        generateValue: true
      - key: CRON_SECRET
        generateValue: true
      - key: ADMIN_EMAIL               # the first owner
        sync: false
      - key: ADMIN_PASSWORD
        sync: false
      - key: STRIPE_SECRET_KEY
        sync: false
      - key: STRIPE_WEBHOOK_SECRET
        sync: false
      - key: MEMBERSHIP_FEE_CENTS
        value: "1000"
      - key: CONTRIBUTION_LIMIT_CENTS
        value: "142970"
      - key: SUPABASE_URL              # image uploads (Supabase Storage)
        sync: false
      - key: SUPABASE_SERVICE_ROLE_KEY
        sync: false
      - key: RESEND_API_KEY
        sync: false
      - key: EMAIL_FROM                # e.g. Imagine Surrey <hello@imaginesurrey.ca>
        sync: false
      - key: EMAIL_REPLY_TO
        sync: false
      - key: TWILIO_ACCOUNT_SID
        sync: false
      - key: TWILIO_AUTH_TOKEN
        sync: false
      - key: TWILIO_FROM
        sync: false
      - key: NEXT_PUBLIC_TURNSTILE_SITE_KEY
        sync: false
      - key: TURNSTILE_SECRET_KEY
        sync: false
      # Base Ground: sign-ups, consent, and signing in with Base (section 3, and step 3f).
      - key: BASE_GROUND_URL           # e.g. https://imaginesurrey.base.win
        sync: false
      - key: BASE_GROUND_INTERNAL_URL  # Base Ground over the private network, for the sign-in token call
        fromService: { type: web, name: base-ground-imaginesurrey, property: hostport }
      - key: BASE_SSO_SECRET           # the same value as BASE_WEB_SSO_SECRET on Base Ground
        fromService: { type: web, name: base-ground-imaginesurrey, envVarKey: BASE_WEB_SSO_SECRET }
      - key: BASE_GROUND_KEY           # a website key made in Base Ground (step 3f)
        sync: false
      - key: BASE_GROUND_INBOUND_KEY   # given to Base Ground too, for consent sent here
        generateValue: true
      - key: BASE_AIR_URL              # optional: Base Air in the switcher, e.g. https://imaginesurrey.base.win/air
        sync: false

  - type: cron
    name: base-web-imaginesurrey-reminders
    runtime: node
    region: oregon
    branch: production
    rootDir: apps/web
    schedule: "7 17 * * *"             # 10:07 a.m. Pacific (UTC-7)
    buildCommand: echo "nothing to build"
    startCommand: node scripts/cron.mjs reminders
    envVars:
      - key: CRON_SECRET
        fromService: { type: web, name: base-web-imaginesurrey, envVarKey: CRON_SECRET }
      - key: BASE_WEB_INTERNAL_URL
        fromService: { type: web, name: base-web-imaginesurrey, property: hostport }

  - type: cron
    name: base-web-imaginesurrey-email
    runtime: node
    region: oregon
    branch: production
    rootDir: apps/web
    schedule: "37 17 * * *"            # 10:37 a.m. Pacific
    buildCommand: echo "nothing to build"
    startCommand: node scripts/cron.mjs email
    envVars:
      - key: CRON_SECRET
        fromService: { type: web, name: base-web-imaginesurrey, envVarKey: CRON_SECRET }
      - key: BASE_WEB_INTERNAL_URL
        fromService: { type: web, name: base-web-imaginesurrey, property: hostport }

databases:
  - name: base-web-imaginesurrey-staging-db
    plan: basic-256mb
    region: oregon
    postgresMajorVersion: "16"
  # Production uses Imagine Surrey's existing database, imagine-surrey-db.
```

The cron jobs run `scripts/cron.mjs`, which has no dependencies: it calls `/api/cron/reminders` (day-before reminders for RSVPs and shifts) or `/api/cron/email` (anything still queued: email, and sign-ups waiting for Base Ground; it also prunes old page views) with `Authorization: Bearer $CRON_SECRET`, over Render's private network (`BASE_WEB_INTERNAL_URL`, or `NEXT_PUBLIC_SITE_URL` if that isn't set), and fails the run if the site doesn't answer 2xx. Without `CRON_SECRET` on the web service, both job URLs refuse every call.

### Moving Imagine Surrey's live site

Imagine Surrey's site already runs on Render as a Node web service with its database in `imagine-surrey-db`. To move it to the Docker service: create `base-web-imaginesurrey` pointing at the same database (`DATABASE_URL` from `imagine-surrey-db`), copy every setting from the old service (renaming `STARBASE_URL`, `STARBASE_KEY` and `STARBASE_INBOUND_KEY` to `BASE_GROUND_URL`, `BASE_GROUND_KEY` and `BASE_GROUND_INBOUND_KEY`: the old names are no longer read), add `BASE_WEB_CLIENT=imagine-surrey`, deploy, check it on its `onrender.com` address, then move the custom domain and suspend the old service and its cron jobs. The first deploy runs migration 0008 (renaming the old Starbase outbox and carrying its rows over) and 0009 (the brand table).

## 2. Which client: a new one, or Imagine Surrey

`BASE_WEB_CLIENT` picks the client's starting content and is **fixed when the site is built**, so changing it needs a new deploy.

| Setting | Imagine Surrey | A new client |
| --- | --- | --- |
| `BASE_WEB_CLIENT` | `imagine-surrey` | unset |
| What the site shows | Exactly today's site: its copy, logo and images, the six town centres and postal-code finder, the Safe Surrey promise tracker, its pledge and SkyTrain petition, its shop, and the Imagine Surrey look | A clean, neutral site in the Civic look: neutral copy, no neighbourhoods, no shop products, no campaigns, an empty promise tracker, the name as a wordmark |
| `BASE_WEB_ORG_NAME`, `BASE_WEB_ORG_EMAIL` | not needed | the organization's name and public email before anyone edits Site settings (fixed at build) |
| `BASE_WEB_BRAND_PRESET` | optional | optional: `civic` (default), `commons`, `heritage`, `clear` or `imagine-surrey` |
| `BASE_WEB_JURISDICTION` | `bc` | `bc` (the default and the only one so far: Elections BC, the LECFA, BC PIPA, BC postal codes, the 2026 contribution limit) |

The seed adds, for every client: the starter volunteer tasks, the jurisdiction's published contribution limit, and draft privacy and accessibility pages in the client's name. Imagine Surrey's also adds its shop, the 26 tracked promises, its pledge and petition, two sample shift openings and a sample draft email. A client's own words, places and starting data live in `src/seeds/<client>/` (CONTRIBUTING.md, "Clients").

## 3. Sign in with Base

Staff who are signed in to Base Ground can open the admin without another password (SUITE.md, "The hand-off"). On this service set `BASE_GROUND_URL` (Base Ground's public address, e.g. `https://imaginesurrey.base.win`, or `https://imaginesurrey.staging.base.win` for staging) and `BASE_SSO_SECRET` (the same value as `BASE_WEB_SSO_SECRET` on Base Ground), and optionally `BASE_GROUND_INTERNAL_URL` (Render's private `host:port` for Base Ground; `http://` is added and any path is taken from `BASE_GROUND_URL`). On Base Ground set `BASE_WEB_URL` to this site's address (e.g. `https://imaginesurrey.ca`).

- The admin sign-in page then shows **Sign in with Base**. Passwords and email links still work.
- `/auth/base?next=/admin/…` starts the hand-off from anywhere (only paths on this site are followed).
- People are signed in by a **link** between their Base Ground login (its client and `sub`) and a staff account here, never by the email alone: a Base Ground manager can make a ground login for any address. The first time, Base Web finds the **existing** staff account with the same email (any capitals) and the person proves once that it is theirs, with that account's password or a one-time link emailed to its address (opened in the same browser); then the link is stored. After that the link decides, whatever the email says. Wrong passwords count toward the usual lockout.
- It never creates an account: anyone else sees "No Base Web staff account for <email> — ask an owner to invite you." A staff account already linked to a different Base Ground login is refused. Owners and administrators still give their authenticator code afterwards.
- Owners see each person's link under **Admin → Staff** and can remove it (the next sign-in asks for the proof again); everyone can see and remove their own under **My account**.
- Every hand-off and every link made, refused or removed is in the audit log (`signin` with method `base`, `signin.base`, `signin.base-refused` with the reason, `signin.base-link-started`, `staff.base-link`, `signin.base-link-refused`, `staff.base-unlink`, `account.base-unlink`).
- With `BASE_GROUND_URL` set, the admin's top bar has the **Base** switcher: Base Ground's Field and Ground, Base Air (when `BASE_AIR_URL` is set) and this admin.

## 4. The look: Admin → Brand

Owners and administrators set the public site's look in **Admin → Brand**: a preset (Imagine Surrey, Civic, Commons, Heritage, Clear), the name and logo (and a logo for dark backgrounds), eight colours, a bundled font and the corner style, with a live preview and a contrast check that flags any pair under 4.5:1 and asks before saving. Saving is audited and refreshes every public page at once. Until something is saved, the client's seed (or `BASE_WEB_BRAND_PRESET`) decides; Imagine Surrey's is its own look, exactly as before.

## 5. Stripe, the domain, and the services

1. **Connect Stripe's payment notices.** In Stripe → Developers → Webhooks, add the endpoint `https://<your-site>/api/stripe/webhook` and select these events:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `checkout.session.expired`
   - `invoice.paid`
   - `customer.subscription.updated`
   - `customer.subscription.paused`
   - `customer.subscription.resumed`
   - `customer.subscription.deleted`
   - `charge.refunded`

   Set the endpoint's **API version** to the version the site's Stripe library is pinned to (`node_modules/stripe/esm/apiVersion.js`, currently `2026-09-30.endive`). Events then arrive in the shape the code expects. With an older version the site still copes, by fetching objects again, at the cost of an extra Stripe call per event. In Stripe → Settings → Billing → Customer portal, turn the portal on so monthly donors can change or cancel their gift from `/me`.

   Copy the endpoint's signing secret (`whsec_…`) into `STRIPE_WEBHOOK_SECRET` on the Render service. Render redeploys when you save.

2. **Add your domain.** In Render → the web service → Settings → Custom Domains, add the client's domain (Imagine Surrey: `imaginesurrey.ca` and `www.imaginesurrey.ca`) and follow the DNS instructions. Render issues the certificate. Then:
   - change `NEXT_PUBLIC_SITE_URL` to `https://imaginesurrey.ca`
   - change the Stripe webhook address to the new domain
   - redeploy (Settings → Manual Deploy → Clear build cache & deploy), because `NEXT_PUBLIC_` values are built into the pages

3a. **Email (Resend).** Create a Resend account, verify your sending domain (add the DNS records it shows, and set up DMARC), and put the API key in `RESEND_API_KEY`. With email on:
   - Newsletter sign-ups are double opt-in: people join only when they click the confirmation link, which is valid for 72 hours.
   - Supporters get receipts and next steps, RSVP and shift confirmations with calendar files, reminders the day before, sign-in links for `/me`, and promise-follow alerts.
   - Campaigns from Admin → Email and texts start sending the moment you press Send and keep going in the background. A daily job (`/api/cron/email`) sends anything left over. Each email carries the recipient's one-click unsubscribe link.

   Admin → Integrations has a "Send me a test email" button.

3b. **Texts (Twilio).** Put the account SID, auth token and sending number (or an `MG…` messaging service) in the three `TWILIO_` variables. In Twilio, set the number's "A message comes in" webhook to `https://<your-site>/api/sms/inbound` (POST).
   - The site verifies Twilio's signature, and it uses `NEXT_PUBLIC_SITE_URL` to do so, so that must match the public address exactly.
   - Replies of STOP, START, HELP, JOIN and PUNJABI, HINDI, CHINESE or TAGALOG are handled automatically and recorded in the consent ledger.
   - Canadian carriers need a verified toll-free number for volume texting. Allow a few weeks for verification.

3c. **Image uploads (Supabase Storage).** The site still keeps uploaded images in Supabase Storage (only images: the database is Render Postgres). In a Supabase project, open Storage and create a **public** bucket named `site-media`. Put the project URL in `SUPABASE_URL` and the service-role key in `SUPABASE_SERVICE_ROLE_KEY` (server only, never in the browser). **Required on Render:** Render wipes the service's disk on every deploy and restart, so the site refuses uploads to its own disk there (`RENDER=true`) and Admin → Integrations shows the image storage card in red until these are set.

3d. **Staff.** Sign in at `/admin/login` with `ADMIN_EMAIL` and `ADMIN_PASSWORD`, then invite the rest of the team at Admin → Staff.
   - With email on, each person gets a one-time sign-in link. Without it, you're shown a one-time password once, to pass on securely.
   - Deactivating an account or resetting a password signs that person out everywhere.
   - Keep at least one owner you can reach, and make a second owner: if the only owner is locked out, so is everyone. The dashboard reminds you while there is one owner, or an owner still named "Owner" (rename yourself under My account).
   - **Two-factor sign-in.** Owners and administrators must set up an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…) before the rest of the admin opens: at first sign-in, My account shows a QR code and a setup key, asks for one code, then shows 10 one-time recovery codes once. From then on, a correct password or email link is followed by a code (`/admin/login/verify`); a recovery code works instead, once each. Wrong codes count toward the same 15-minute lockout as wrong passwords. Organizers and editors may turn it on too. Anyone can turn theirs off or make new recovery codes under My account with a current code, and an owner can reset someone else's at Admin → Staff (it signs them out everywhere).
   - The app secrets are stored encrypted with a key derived from `ADMIN_SESSION_SECRET`. **Changing `ADMIN_SESSION_SECRET` stops every authenticator app's codes from matching** (and signs everyone out): staff then sign in with a recovery code and set the app up again, or an owner resets them.
   - `ADMIN_MFA_REQUIRED=0` switches the requirement off, but only on a development copy (`NODE_ENV` not `production`) or under the end-to-end test runner. It is **ignored when `RENDER=true`** (Render sets this on every service), so the live site always requires two-factor sign-in for owners and administrators. The local admin preview mode skips it too, since it only runs on a copy with a local database.

3e. **Content.** Review the draft `/privacy` page in Admin → Pages: name your privacy officer and confirm the processors (Render, Supabase Storage, Stripe, Resend, Twilio, Cloudflare Turnstile, analytics) and what goes to Base Ground. Then fill in Admin → Site settings: the organization's address, the financial agent's authorization line, the board, and the social accounts. After any bulk change made directly in the database, POST to `/api/admin/revalidate` (signed in) to refresh the public pages, or simply wait up to an hour.

3f. **Connect Base Ground (the desk).** Base Ground is the campaign's database. The website sends it new sign-ups so organizers see one record per supporter.
   - **Make a website key.** In Base Ground, a manager opens **Settings → Services → Website keys**, names the key (*Website*) and clicks **Make a key**. The key (`sbk_…`) is shown once: copy it straight into the Render service's Environment.
   - **Set two variables on the Render service:** `BASE_GROUND_URL` is Base Ground's public address with no trailing slash, e.g. `https://imaginesurrey.base.win` (it must be `https://`), and `BASE_GROUND_KEY` is the key. Never give the key a `NEXT_PUBLIC_` name: the website calls Base Ground from its own server, never from the visitor's browser, so the key stays secret.
   - **Test it.** In Admin → Integrations, the **Base Ground (the desk)** card has **Test connection**. It should name your campaign and the key. **Send now** sends anything waiting, and the card links to everything sent (Admin → Integrations → Base Ground), where a refused sign-up can be retried or skipped.
   - **What is sent, and when.** Each one only after the website has accepted it, and only what the person typed into that form:
     - a new petition or pledge signature, tagged `Petition: <title>` (or `Pledge: …`), with newsletter only if they ticked email updates
     - a newsletter sign-up, once it is confirmed (or at once when email isn't set up)
     - a volunteer shift sign-up, which files a *Wants to volunteer* request under Today → Needs you with the shift in the note
     - a membership once it is paid (or at once when membership is free): name and contact details from the form, tagged `Member (joined online)`, with a volunteer request or a lawn-sign note if they ticked those. The fee is never sent.
     - a "delete my account" request from `/me`, as a request for the desk to do the same in Base Ground (it sends the email and name only)
     - **engagement tags**, so the desk sees who is engaged: a new RSVP adds `RSVP: <event title>` (source `rsvp`, with the name and email), a paid shop order adds `Bought merch` (source `shop`, sent after the Stripe webhook has recorded the payment), and a confirmed promise follow adds `Follows: promise <number>` (source `tracker`). A tag and nothing else: no guests, items, totals or payment details.
     - **portal edits**: when a signed-in supporter changes their name, phone, street address or postal code at `/me/preferences`, those details (source `portal`). Base Ground fills blanks only, so what the desk has on file is never overwritten.
     - **every withdrawal** (below)
   - **What is never sent:** money of any kind (donations, monthly gifts, membership fees, order totals and items) and anything staff change in `/admin`. Money is never sent because contribution limits are checked at the desk, where every gift is logged by hand (below).
   - **Unsubscribes both ways (consent sync).** So that neither app emails or texts someone who said stop, every withdrawal on the website goes to Base Ground, and Base Ground can send its own to the website.
     - **Website → Base Ground.** A newsletter unsubscribe, unticking email or texts in the preference centre or at `/me`, a text STOP to the website's number, and an anonymized supporter (Admin → Supporters → Anonymize) each send `POST <BASE_GROUND_URL>/in/v1/consent`, with the same website key and an `Idempotency-Key` (the outbox row's id), retried like sign-ups:
       ```json
       { "email": "pat@example.com", "channel": "email", "action": "withdraw", "reason": "unsubscribe", "at": "2026-11-07T18:30:00.000Z" }
       ```
       `email` and/or `phone` (`+1…`), `channel` is `email` or `sms`, `reason` is `unsubscribe`, `stop`, `preference` or `deletion`, and `at` is when it happened. Base Ground should answer `200 { "ok": true }` and apply it the way its own unsubscribe and STOP do. A deletion's address and number are removed from the website's copy once Base Ground has them (and nothing is queued for a deletion while Base Ground isn't connected).
     - **Until Base Ground has that endpoint** it answers 404. The website treats that as *not supported yet*: the withdrawal stays waiting (never refused, no tries used), is tried again every 6 hours and with **Send now**, and the Integrations card and the outbox page say how many are waiting. Sign-ups keep going meanwhile. Once Base Ground has the endpoint, press **Send now** once.
     - **Base Ground → website.** Make a long random secret (`openssl rand -base64 32`), set it as `BASE_GROUND_INBOUND_KEY` on the website, and give the same secret to Base Ground. Base Ground then calls:
       ```
       POST https://imaginesurrey.ca/api/in/consent
       Authorization: Bearer <BASE_GROUND_INBOUND_KEY>
       Content-Type: application/json
       Idempotency-Key: <its own id for the change, up to 200 characters>

       { "email": "pat@example.com", "channel": "email", "action": "withdraw", "reason": "unsubscribe", "at": "2026-11-07T10:30:00-08:00" }
       ```
       The body has the same shape (`email` and/or `phone`). A withdrawal is applied to everyone here with that email or phone number (in any format): email clears their email consent and unsubscribes the address from the newsletter, sms clears their text consent, and an address nobody here has yet is still recorded, so a public form can't sign it up again. Each one is written to the consent ledger with source `base-ground` and to the audit log (without the address), and is never sent back to Base Ground. A grant (`"action": "grant"`) is answered but **not applied**: only withdrawals flow between the apps on their own; saying yes again is done on the site where the person sees the wording.
       Answers: `200 { "ok": true, "applied": <people changed> }`; the same `Idempotency-Key` and body again gives the first answer with `"replayed": true`, and with another body `409`; `400` for a missing `Idempotency-Key` or a body outside the shape (the message names the field); `401` without the right key; `415` if not JSON; `429` over 120 calls a minute; `503` while `BASE_GROUND_INBOUND_KEY` isn't set.
   - **When Base Ground is down or slow,** the visitor's form still works. Sign-ups (and withdrawals) wait in an outbox and are retried after 1 minute, 5 minutes, 30 minutes, 2 hours, then every 12 hours (by the daily job), and are marked refused after 8 tries. A wrong or revoked key (401) keeps everything waiting, without using up tries, until the key is fixed; the Integrations card shows the problem. Each sign-up carries its own Idempotency-Key, so a retry never makes a second person.
   - **Before it is connected,** sign-ups are kept as *skipped*, so connecting Base Ground later sends only new sign-ups instead of a flood of old ones. Any skipped one can still be sent with **Retry**.
   - **The treasurer's routine (daily, or as gifts come in).** Open **Admin → Gifts to log at the desk** (`/admin/desk-gifts`, the `money` permission). It lists every online gift not yet logged, oldest first: contributor name, address, city, postal code, email, amount (and net of refunds), slate, kind (donation, membership fee or monthly payment), when it was paid (Pacific time) and the Stripe reference. Refunded gifts and gifts over the limit are flagged. For each one, enter it in Base Ground under **Donations → Log a gift**, then click **Mark logged** (or tick several and mark them together). **Download this list (CSV)** gives the same rows. The dashboard shows how many are waiting. The first time, mark any gifts you already entered by hand.

3g. **Turn on the human check (Cloudflare Turnstile).** Every accepted sign-up becomes a supporter record, here and in Base Ground, and can file a request for the desk or send an email, so the public forms need their own spam check on top of the hidden honeypot field and the rate limits. Turnstile is free, shows most people nothing at all (no puzzles), sets no advertising cookies and works with screen readers.
   - In the Cloudflare dashboard, open **Turnstile → Add widget**, add your domain (and the `*.onrender.com` address while testing), and choose **Managed** mode.
   - Put the **site key** in `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and the **secret key** in `TURNSTILE_SECRET_KEY`, then redeploy with a fresh build (the site key is built into the pages).
   - With both set, the petition, pledge, newsletter, membership, volunteer, RSVP, promise-follow, `/me` sign-in and preference-link forms all need a pass. If Cloudflare can't be reached, those forms ask people to try again in a moment. The donation and shop checkouts don't use it: Stripe screens payments itself.
   - Admin → Integrations shows whether it is on.


## 6. Test, then go live

4. **Test with Stripe's test card.** Join and donate using card `4242 4242 4242 4242`, any future expiry date and any CVC. Then confirm that:
    - rows appear in `memberships`, `contributions` and `newsletter_subscribers` (Render → the database → Connect, then `psql`)
    - the same records show in `/admin`

5. **Switch to live payments.**
    - Replace the test key with the live secret key (`sk_live_…`).
    - In Stripe's live mode, create the same webhook endpoint and copy its new signing secret into `STRIPE_WEBHOOK_SECRET`.
    - Redeploy.

Every table the site creates has **row-level security** turned on (a test checks it), so a database shared with another app later can't expose supporter data through a public API key. The website's own connection is unaffected.

## Where each form's data lands

| On the website | Table(s) |
| --- | --- |
| Become a member | `people`, `memberships`, `contributions` (the fee) |
| Chip in (one-time) | `people`, `contributions` |
| Chip in (monthly) | `people`, `recurring_donations`, plus one `contributions` row per payment |
| Newsletter | `newsletter_subscribers` |
| Pledge and SkyTrain petition | `campaign_signatures` |
| Event RSVP | `event_rsvps` |
| Shop | `orders`, `order_items` |
| Volunteer shifts | `shift_openings` (published openings), `shifts` (one row per volunteer per shift), `volunteer_tasks` |
| Promise follows | `promise_follows` |
| Sent to Base Ground | `base_ground_outbox` (one row per forwarded sign-up), plus `people.base_ground_person_id` |
| Logged at the desk | `contributions.desk_logged_at` and `desk_logged_by` |
| Email and text consent | `consent_events` (append-only proof), plus `people.contact_consent_at` and `people.sms_consent_at` as the current state |
| Everything sent | `email_log`, `sms_log`, `email_campaigns` |
| Staff and audit | `admin_users`, `admin_sessions`, `audit_log` |
| Site copy, pages, images | `site_settings`, `site_pages`, `media` |
| The look (Admin → Brand) | `site_brand` |
| Promise tracker (admin) | `tracker_promises`, `tracker_updates`, `tracker_announcements` |

Every person is stored once in `people`, matched by email. Their membership, donations, signatures and RSVPs all link back to that one row.
