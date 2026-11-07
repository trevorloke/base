# Going live: database, website and payments

This guide takes the site from this repository to a live website. Supporter data goes into your Supabase database, the same one your Supabase app can use. Allow about an hour. You need accounts with Supabase, Vercel and Stripe, plus Node.js 20 or newer on your computer for step 4.

## 1. Prepare the Supabase database

1. **Open the Supabase project your app uses.** If you're creating a new project, choose the **Canada (Central)** region so supporter data stays in Canada.

2. **Check for clashing table names.** In **Table Editor**, look for any existing table with one of these names:

   `people`, `memberships`, `contributions`, `recurring_donations`, `newsletter_subscribers`, `campaign_signatures`, `news_posts`, `events`, `event_rsvps`, `products`, `orders`, `order_items`, `stripe_events`, `volunteer_tasks`, `shifts`, `tracker_promises`, `tracker_updates`, `tracker_announcements`

   If one already exists, stop here. The website's tables need to move into their own schema before going further.

3. **Copy two connection strings.** Click **Connect** at the top of the project:
   - **Transaction pooler** (port 6543): the live website uses this one.
   - **Session pooler** (port 5432): use this one to set up the tables.

   In both, replace `[YOUR-PASSWORD]` with your database password.

4. **Create the tables.** On your computer, run:

   ```sh
   git clone https://github.com/trevorloke/ImagineSurreyWebsite.git
   cd ImagineSurreyWebsite
   npm install
   DATABASE_URL="<session pooler string>" npm run db:migrate
   DATABASE_URL="<session pooler string>" npm run db:seed
   ```

   - **`db:migrate`** creates every table and turns on **row-level security** for each one. On Supabase, a table without row-level security can be read by anyone with the app's public API key. With it on, only the website's own database connection can reach these rows until you allow your app in (section 4). Tables that belong to your app are not touched.
   - **`db:seed`** loads the 26 tracked promises, the six shop products and the starter volunteer tasks. Running it again never overwrites changes made in `/admin`.

   After this first time, you don't need to repeat them: every **production** deploy on Vercel runs any new migrations and the seed before building (the `vercel-build` script; set `SKIP_DB_MIGRATE=1` to turn that off). If that step fails, the deploy stops and the current site stays live.

## 2. Put the website online with Vercel

5. **Import the repository.** In Vercel, choose **Add New → Project**, import `trevorloke/ImagineSurreyWebsite`, and keep the detected Next.js settings.

6. **Add these Environment Variables:**

   | Name | Value |
   | --- | --- |
   | `DATABASE_URL` | The **transaction pooler** string (port 6543) |
   | `NEXT_PUBLIC_SITE_URL` | `https://<your-project>.vercel.app` for now |
   | `STRIPE_SECRET_KEY` | Stripe → Developers → API keys → Secret key. Use `sk_test_…` while testing. |
   | `STRIPE_WEBHOOK_SECRET` | Leave blank for now; you fill it in at step 8 |
   | `MEMBERSHIP_FEE_CENTS` | The membership minimum (membership is by donation): `1000` for $10 a year, or `0` for free membership |
   | `MEMBERSHIP_YOUTH_MIN_CENTS` | Optional. The minimum for members aged 14 to 30; unset means half of `MEMBERSHIP_FEE_CENTS` ($5) |
   | `CONTRIBUTION_LIMIT_CENTS` | `142970` ($1,429.70). Only a fallback: the limit for each year is kept in Admin → Contribution limits (the seed stores 2026) |
   | `ADMIN_EMAIL` | **Required to sign in to `/admin`.** Your email: the first sign-in with this address and `ADMIN_PASSWORD` creates the owner account |
   | `ADMIN_PASSWORD` | A long password (12+ characters) for that first sign-in. Change it afterwards under My account |
   | `ADMIN_SESSION_SECRET` | A long random string, e.g. from `openssl rand -hex 32`. It also signs supporter sign-ins |
   | `CRON_SECRET` | A long random string. Vercel sends it to the two daily jobs: day-before reminders (about 10 a.m. Pacific) and a sweep of any email (and any Starbase sign-up) still queued. These work on every Vercel plan |
   | `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO` | Email (step 9a). Optional at first: without them nothing is sent, but every message is still logged |
   | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Texts (step 9b). Optional |
   | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_MEDIA_BUCKET` | Image uploads in Admin → Media (step 9c). Optional |
   | `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` or `NEXT_PUBLIC_GA_MEASUREMENT_ID` | Analytics, only if you want them |
   | `STARBASE_URL`, `STARBASE_KEY` | The campaign's database, Starbase (step 9f). Optional at first: without them sign-ups stay on the website only |
   | `STARBASE_INBOUND_KEY` | A long random secret you make (step 9f), so Starbase can pass on unsubscribes and text STOPs made there. Optional: without it the website refuses them |
   | `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | The human check on public forms (step 9g). Turn it on before launch |

7. **Click Deploy.**

8. **Connect Stripe's payment notices.** In Stripe → Developers → Webhooks, add the endpoint `https://<your-site>/api/stripe/webhook` and select these events:
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

   Copy the endpoint's signing secret (`whsec_…`) into `STRIPE_WEBHOOK_SECRET` in Vercel, then redeploy.

9. **Add your domain.** In Vercel → Settings → Domains, add `imaginesurrey.ca` and follow the DNS instructions. Then:
   - change `NEXT_PUBLIC_SITE_URL` to `https://imaginesurrey.ca`
   - change the Stripe webhook address to the new domain
   - redeploy

9a. **Email (Resend).** Create a Resend account, verify your sending domain (add the DNS records it shows, and set up DMARC), and put the API key in `RESEND_API_KEY`. With email on:
   - Newsletter sign-ups are double opt-in: people join only when they click the confirmation link, which is valid for 72 hours.
   - Supporters get receipts and next steps, RSVP and shift confirmations with calendar files, reminders the day before, sign-in links for `/me`, and promise-follow alerts.
   - Campaigns from Admin → Email and texts start sending the moment you press Send and keep going in the background. A daily job (`/api/cron/email`) sends anything left over. Each email carries the recipient's one-click unsubscribe link.

   Admin → Integrations has a "Send me a test email" button.

9b. **Texts (Twilio).** Put the account SID, auth token and sending number (or an `MG…` messaging service) in the three `TWILIO_` variables. In Twilio, set the number's "A message comes in" webhook to `https://<your-site>/api/sms/inbound` (POST).
   - The site verifies Twilio's signature, and it uses `NEXT_PUBLIC_SITE_URL` to do so, so that must match the public address exactly.
   - Replies of STOP, START, HELP, JOIN and PUNJABI, HINDI, CHINESE or TAGALOG are handled automatically and recorded in the consent ledger.
   - Canadian carriers need a verified toll-free number for volume texting. Allow a few weeks for verification.

9c. **Image uploads (Supabase Storage).** In Supabase → Storage, create a **public** bucket named `site-media`. Put the project URL in `SUPABASE_URL` and the service-role key in `SUPABASE_SERVICE_ROLE_KEY` (server only, never in the browser). On Vercel, uploads fail without this, because the server's disk isn't kept.

9d. **Staff.** Sign in at `/admin/login` with `ADMIN_EMAIL` and `ADMIN_PASSWORD`, then invite the rest of the team at Admin → Staff.
   - With email on, each person gets a one-time sign-in link. Without it, you're shown a one-time password once, to pass on securely.
   - Deactivating an account or resetting a password signs that person out everywhere.
   - Keep at least one owner you can reach, and make a second owner: if the only owner is locked out, so is everyone. The dashboard reminds you while there is one owner, or an owner still named "Owner" (rename yourself under My account).
   - **Two-factor sign-in.** Owners and administrators must set up an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…) before the rest of the admin opens: at first sign-in, My account shows a QR code and a setup key, asks for one code, then shows 10 one-time recovery codes once. From then on, a correct password or email link is followed by a code (`/admin/login/verify`); a recovery code works instead, once each. Wrong codes count toward the same 15-minute lockout as wrong passwords. Organizers and editors may turn it on too. Anyone can turn theirs off or make new recovery codes under My account with a current code, and an owner can reset someone else's at Admin → Staff (it signs them out everywhere).
   - The app secrets are stored encrypted with a key derived from `ADMIN_SESSION_SECRET`. **Changing `ADMIN_SESSION_SECRET` stops every authenticator app's codes from matching** (and signs everyone out): staff then sign in with a recovery code and set the app up again, or an owner resets them.
   - `ADMIN_MFA_REQUIRED=0` switches the requirement off, but only on a development copy (`NODE_ENV` not `production`) or under the end-to-end test runner. It is **ignored when `RENDER=true`** (Render sets this on every service) and on Vercel, so the live site always requires two-factor sign-in for owners and administrators. The local admin preview mode skips it too, since it only runs on a copy with a local database.

9e. **Content.** Review the draft `/privacy` page in Admin → Pages: name your privacy officer and confirm the processors (Vercel, Supabase, Stripe, Resend, Twilio, Cloudflare Turnstile, analytics) and what goes to Starbase. Then fill in Admin → Site settings: the organization's address, the financial agent's authorization line, the board, and the social accounts. After any bulk change made directly in the database, POST to `/api/admin/revalidate` (signed in) to refresh the public pages, or simply wait up to an hour.

9f. **Connect Starbase (the desk).** Starbase is the campaign's database. The website sends it new sign-ups so organizers see one record per supporter.
   - **Make a website key.** In Starbase, a manager opens **Settings → Services → Website keys**, names the key (*Website*) and clicks **Make a key**. The key (`sbk_…`) is shown once: copy it straight into Vercel.
   - **Set two variables in Vercel:** `STARBASE_URL` is Starbase's public address with no trailing slash, e.g. `https://starbase.imaginesurrey.ca` (it must be `https://`), and `STARBASE_KEY` is the key. Never give the key a `NEXT_PUBLIC_` name: the website calls Starbase from its own server, never from the visitor's browser, so the key stays secret. Redeploy.
   - **Test it.** In Admin → Integrations, the **Starbase (the desk)** card has **Test connection**. It should name your campaign and the key. **Send now** sends anything waiting, and the card links to everything sent (Admin → Integrations → Starbase), where a refused sign-up can be retried or skipped.
   - **What is sent, and when.** Each one only after the website has accepted it, and only what the person typed into that form:
     - a new petition or pledge signature, tagged `Petition: <title>` (or `Pledge: …`), with newsletter only if they ticked email updates
     - a newsletter sign-up, once it is confirmed (or at once when email isn't set up)
     - a volunteer shift sign-up, which files a *Wants to volunteer* request under Today → Needs you with the shift in the note
     - a membership once it is paid (or at once when membership is free): name and contact details from the form, tagged `Member (joined online)`, with a volunteer request or a lawn-sign note if they ticked those. The fee is never sent.
     - a "delete my account" request from `/me`, as a request for the desk to do the same in Starbase (it sends the email and name only)
     - **engagement tags**, so the desk sees who is engaged: a new RSVP adds `RSVP: <event title>` (source `rsvp`, with the name and email), a paid shop order adds `Bought merch` (source `shop`, sent after the Stripe webhook has recorded the payment), and a confirmed promise follow adds `Follows: promise <number>` (source `tracker`). A tag and nothing else: no guests, items, totals or payment details.
     - **portal edits**: when a signed-in supporter changes their name, phone, street address or postal code at `/me/preferences`, those details (source `portal`). Starbase fills blanks only, so what the desk has on file is never overwritten.
     - **every withdrawal** (below)
   - **What is never sent:** money of any kind (donations, monthly gifts, membership fees, order totals and items) and anything staff change in `/admin`. Money is never sent because contribution limits are checked at the desk, where every gift is logged by hand (below).
   - **Unsubscribes both ways (consent sync).** So that neither app emails or texts someone who said stop, every withdrawal on the website goes to Starbase, and Starbase can send its own to the website.
     - **Website → Starbase.** A newsletter unsubscribe, unticking email or texts in the preference centre or at `/me`, a text STOP to the website's number, and an anonymized supporter (Admin → Supporters → Anonymize) each send `POST <STARBASE_URL>/in/v1/consent`, with the same website key and an `Idempotency-Key` (the outbox row's id), retried like sign-ups:
       ```json
       { "email": "pat@example.com", "channel": "email", "action": "withdraw", "reason": "unsubscribe", "at": "2026-11-07T18:30:00.000Z" }
       ```
       `email` and/or `phone` (`+1…`), `channel` is `email` or `sms`, `reason` is `unsubscribe`, `stop`, `preference` or `deletion`, and `at` is when it happened. Starbase should answer `200 { "ok": true }` and apply it the way its own unsubscribe and STOP do. A deletion's address and number are removed from the website's copy once Starbase has them (and nothing is queued for a deletion while Starbase isn't connected).
     - **Until Starbase has that endpoint** it answers 404. The website treats that as *not supported yet*: the withdrawal stays waiting (never refused, no tries used), is tried again every 6 hours and with **Send now**, and the Integrations card and the outbox page say how many are waiting. Sign-ups keep going meanwhile. Once Starbase has the endpoint, press **Send now** once.
     - **Starbase → website.** Make a long random secret (`openssl rand -base64 32`), set it as `STARBASE_INBOUND_KEY` on the website and redeploy, and give the same secret to Starbase. Starbase then calls:
       ```
       POST https://imaginesurrey.ca/api/in/consent
       Authorization: Bearer <STARBASE_INBOUND_KEY>
       Content-Type: application/json
       Idempotency-Key: <its own id for the change, up to 200 characters>

       { "email": "pat@example.com", "channel": "email", "action": "withdraw", "reason": "unsubscribe", "at": "2026-11-07T10:30:00-08:00" }
       ```
       The body has the same shape (`email` and/or `phone`). A withdrawal is applied to everyone here with that email or phone number (in any format): email clears their email consent and unsubscribes the address from the newsletter, sms clears their text consent, and an address nobody here has yet is still recorded, so a public form can't sign it up again. Each one is written to the consent ledger with source `starbase` and to the audit log (without the address), and is never sent back to Starbase. A grant (`"action": "grant"`) is answered but **not applied**: only withdrawals flow between the apps on their own; saying yes again is done on the site where the person sees the wording.
       Answers: `200 { "ok": true, "applied": <people changed> }`; the same `Idempotency-Key` and body again gives the first answer with `"replayed": true`, and with another body `409`; `400` for a missing `Idempotency-Key` or a body outside the shape (the message names the field); `401` without the right key; `415` if not JSON; `429` over 120 calls a minute; `503` while `STARBASE_INBOUND_KEY` isn't set.
   - **When Starbase is down or slow,** the visitor's form still works. Sign-ups (and withdrawals) wait in an outbox and are retried after 1 minute, 5 minutes, 30 minutes, 2 hours, then every 12 hours (by the daily job), and are marked refused after 8 tries. A wrong or revoked key (401) keeps everything waiting, without using up tries, until the key is fixed; the Integrations card shows the problem. Each sign-up carries its own Idempotency-Key, so a retry never makes a second person.
   - **Before it is connected,** sign-ups are kept as *skipped*, so connecting Starbase later sends only new sign-ups instead of a flood of old ones. Any skipped one can still be sent with **Retry**.
   - **The treasurer's routine (daily, or as gifts come in).** Open **Admin → Gifts to log at the desk** (`/admin/desk-gifts`, the `money` permission). It lists every online gift not yet logged, oldest first: contributor name, address, city, postal code, email, amount (and net of refunds), slate, kind (donation, membership fee or monthly payment), when it was paid (Pacific time) and the Stripe reference. Refunded gifts and gifts over the limit are flagged. For each one, enter it in Starbase under **Donations → Log a gift**, then click **Mark logged** (or tick several and mark them together). **Download this list (CSV)** gives the same rows. The dashboard shows how many are waiting. The first time, mark any gifts you already entered by hand.

9g. **Turn on the human check (Cloudflare Turnstile).** Every accepted sign-up becomes a supporter record, here and in Starbase, and can file a request for the desk or send an email, so the public forms need their own spam check on top of the hidden honeypot field and the rate limits. Turnstile is free, shows most people nothing at all (no puzzles), sets no advertising cookies and works with screen readers.
   - In the Cloudflare dashboard, open **Turnstile → Add widget**, add your domain (and the `*.vercel.app` address while testing), and choose **Managed** mode.
   - Put the **site key** in `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and the **secret key** in `TURNSTILE_SECRET_KEY`, then redeploy (the site key is built into the pages).
   - With both set, the petition, pledge, newsletter, membership, volunteer, RSVP, promise-follow, `/me` sign-in and preference-link forms all need a pass. If Cloudflare can't be reached, those forms ask people to try again in a moment. The donation and shop checkouts don't use it: Stripe screens payments itself.
   - Admin → Integrations shows whether it is on.

## 2b. Or put the website online with Render

If the site runs on Render instead of Vercel, use a **Web Service** (Node):

- **Build command:** `npm ci && npm run build:deploy`. On every deploy, except pull-request previews, it runs new database migrations and the starter content, then builds. If that step fails, the deploy stops and the current site stays live.
- **Start command:** `npm start`. Render supplies the port.
- **Environment:** the same variables as in step 6, under the service's **Environment** tab. Set `NEXT_PUBLIC_SITE_URL` to the public address people type (e.g. `https://imaginesurrey.ca`), never to `localhost`, then redeploy, because `NEXT_PUBLIC_` values are built into the pages.
- **Image storage is required.** Render wipes the service's disk on every deploy and restart, so the site refuses uploads to its own disk there (Render sets `RENDER=true`) and Admin → Integrations shows the image storage card in red. Create a public bucket in Supabase Storage and set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and, if the bucket isn't named `site-media`, `SUPABASE_MEDIA_BUCKET` before anyone uploads a photo.
- **Scheduled jobs:** `vercel.json` is ignored on Render. Add a Render **Cron Job** for each daily job, each with `CRON_SECRET` in its environment, so reminders go out and leftover email and Starbase sign-ups are retried. Set `CRON_SECRET` on the web service too: without it, both job URLs refuse every call on Render.
  - Schedule `7 17 * * *`, command `curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://imaginesurrey.ca/api/cron/reminders`
  - Schedule `37 17 * * *`, command `curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://imaginesurrey.ca/api/cron/email`

## 3. Test, then go live

10. **Test with Stripe's test card.** Join and donate using card `4242 4242 4242 4242`, any future expiry date and any CVC. Then confirm that:
    - rows appear in Supabase in `memberships`, `contributions` and `newsletter_subscribers`
    - the same records show in `/admin`

11. **Switch to live payments.**
    - Replace the test key with the live secret key (`sk_live_…`).
    - In Stripe's live mode, create the same webhook endpoint and copy its new signing secret into `STRIPE_WEBHOOK_SECRET`.
    - Redeploy.

## 4. Let your Supabase app use the data

Your app and the website share one database, so your app can query the website's tables directly with `supabase-js`. Row-level security blocks every request until you add a policy saying who may see what.

To mark a staff user, set `app_metadata.role` to `"staff"` on their account. Use your app's server-side admin code or the SQL editor, never the browser. Then add a policy for each table your app needs. For example, to let staff read supporters and edit the shift calendar:

```sql
create policy "staff read supporters" on public.people
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'staff');

create policy "staff manage shifts" on public.shifts
  for all to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'staff')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'staff');
```

The website keeps working whatever policies you add.

Two rules keep the two apps compatible:

- **Change rows freely, but not table structure.** Your app can read, add and edit rows. It shouldn't rename or drop the website's tables or columns. Structure changes go in `src/lib/db/schema.ts` and a new migration (`npm run db:generate`), so the website keeps working.
- **Every new website table needs row-level security turned on.** A test (`tests/rls.test.ts`) fails if a new table is missing it.

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
| Sent to Starbase | `starbase_outbox` (one row per forwarded sign-up), plus `people.starbase_person_id` |
| Logged at the desk | `contributions.desk_logged_at` and `desk_logged_by` |
| Email and text consent | `consent_events` (append-only proof), plus `people.contact_consent_at` and `people.sms_consent_at` as the current state |
| Everything sent | `email_log`, `sms_log`, `email_campaigns` |
| Staff and audit | `admin_users`, `admin_sessions`, `audit_log` |
| Site copy, pages, images | `site_settings`, `site_pages`, `media` |
| Promise tracker (admin) | `tracker_promises`, `tracker_updates`, `tracker_announcements` |

Every person is stored once in `people`, matched by email. Their membership, donations, signatures and RSVPs all link back to that one row.
