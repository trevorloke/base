# Integrations

Every outside service base.win talks to, what it is for, the settings it
reads, where each key comes from, and how to check it works. Keys and tokens
go in the hosting's environment (Render → the service → **Environment**),
never in the code, the repo or a chat. Once they are set, a manager opens
**Settings → Services** in the admin: each service says whether it's set up,
and **Check** makes one real call to it (nothing is sent to anyone, nothing
is written) and says exactly what is wrong if anything is.

| Service | For | Needed to launch? | Settings |
|---|---|---|---|
| [Database](#database) | everything the campaign records | yes | `DATABASE_URL` |
| [Public address](#public-address) | links in email, texting's callbacks | yes | `STARBASE_PUBLIC_URL` |
| [Email — Resend](#email--resend) | invites, newsletters, press, ladders, shift alerts, receipts | yes | `RESEND_API_KEY`, `MAIL_FROM` |
| [Texting and calls — Twilio](#texting-and-calls--twilio) | the campaign's number: texts, text blasts, ladder texts, calls, SMS shift alerts | no (phones' own apps until then) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` |
| [Address lookup](#address-lookup) | suggestions as you type, placing people on the map | yes (free default, no key) | `GEOCODER`, `GEOCODER_FALLBACK`, `BC_GEOCODER_KEY`, `GOOGLE_MAPS_SERVER_KEY` |
| [Map background](#map-background) | the map volunteers walk | no (free default; change before election week) | `GOOGLE_MAPS_TILES`, `GOOGLE_MAPS_SERVER_KEY`, or `STARBASE_TILE_URL` |
| [Two-step sign-in key](#two-step-sign-in-key) | seals everyone's authenticator key | before the public link goes out (works without, with a warning) | `STARBASE_TWO_STEP_KEY` |
| [Hosting — Render](#hosting--render) | the two environments | yes | `render.yaml` |
| [GitHub Actions](#github-actions) | tests, and promoting staging to production | yes | none |
| [The campaign's website](#the-campaigns-website) | sign-ups, petitions, volunteers, newsletter opt-ins in | when the website is ready | a website key (Settings → Services) |
| [Online payments — Stripe](#online-payments--stripe) | gifts once or monthly and membership dues on the website, by card, Apple Pay or Google Pay | when the website takes money (test mode first) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| [Phone dialer — CallHub](#phone-dialer--callhub) | a list or a phone bank sent to CallHub's dialer; each call's result back on the person | no (only if the campaign calls through CallHub) | `CALLHUB_API_KEY`, `CALLHUB_API_BASE` |

The campaign's website sends people in with a key; the API is
[below](#the-campaigns-website).

## Database

Postgres. On Render, `render.yaml` creates one per environment and fills
`DATABASE_URL` from it. Without `DATABASE_URL` base.win keeps everything in a
built-in database on the server's disk (`STARBASE_DATA`, default
`./data/starbase`) — fine on a laptop, not for the team.

| Setting | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | `postgres://…`; `sslmode=require` in it turns TLS on |
| `PGSSL` / `PGSSL_STRICT` | off | `1` to force TLS / to verify the certificate |
| `PG_POOL_MAX` | `10` | connections per server |
| `PG_CONNECT_TIMEOUT_MS` | `30000` | how long to wait for a database connection before giving an error (a dropped connection reconnects on the next query; `/api/health` says `"database": "not reachable"` while it's down) |

**Check:** Services → Database answers with how many people are on file.

## Public address

`STARBASE_PUBLIC_URL` — this environment's own `https://` address
(`https://starbase.imaginesurrey.ca`; staging its own). Every link in an
email (invites, unsubscribe, receipts, pictures) is built from it, and so are
the addresses Twilio is told to call back (delivery reports, calls). Without
it, links use whatever address the page was opened at, background sends
(receipts) carry no link, and calls through the campaign's number are off.

**Check:** Services → Public address fetches `<address>/api/health` and
makes sure it's this base.win.

## Email — Resend

[resend.com](https://resend.com). Sends with a plain HTTPS call
(`POST https://api.resend.com/emails`), one idempotency key per email so a
retry is never a second copy.

1. Resend → **Domains** → add the campaign's domain (e.g. `imaginesurrey.ca`)
   and add the DNS records it shows (SPF, DKIM) at the domain's DNS host.
   Wait for **Verified**.
2. Resend → **API Keys** → create one with **Sending access** for that
   domain.
3. Set `RESEND_API_KEY` to it and `MAIL_FROM` to a sender on the domain:
   `Imagine Surrey <team@imaginesurrey.ca>`. Staging: a separate key, or none.

| Setting | Default | Notes |
|---|---|---|
| `RESEND_API_KEY` | — | without it nothing is emailed: sends are recorded as *queued*, invites show their link to copy, receipts wait |
| `MAIL_FROM` | `onboarding@resend.dev` | Resend's test sender reaches only the account's owner — set it |
| `STARBASE_EMAIL_TIMEOUT_MS` | `15000` | one email's time limit |

There is nothing to point back at base.win: opens and clicks are counted by
base.win itself (`/o`, `/c`), and unsubscribes are base.win's own pages.

**Check:** Services → Email asks Resend for the account's domains: the key
works, and `MAIL_FROM`'s domain is there and verified (a sending-only key
can't list domains; the check says so and the key is fine).

## Texting and calls — Twilio

[twilio.com](https://www.twilio.com). One-to-one texts from the Inbox, the
Calls card and the door card; text blasts to a list; STOP/START; calls
placed through the campaign's number (Twilio rings the caller, they press 1,
then it dials the person); SMS shift alerts; a ladder's *Text* step (by the
same rules — inside the texting hours, never to a number that replied STOP
or asked to stop in a reply (*No thanks, stop*: the Inbox only flags those
for a person, but a ladder sends with nobody reading), the campaign named,
"Reply STOP to opt out" added — filed in the Inbox as
the campaign's own conversation). Without it, Call and Text open the
phone's own dialer and messages, a ladder's text waits, and nothing is lost.
A call is never placed through the campaign's number to someone tagged
`do-not-contact` or `do-not-call`.

1. Twilio → buy a Canadian number with SMS and voice. Register it for
   messaging as Twilio requires (A2P/10DLC or toll-free verification).
2. Account SID and Auth Token from the Twilio console → `TWILIO_ACCOUNT_SID`,
   `TWILIO_AUTH_TOKEN`; the number in `+1…` form → `TWILIO_FROM`.
3. Twilio → **Phone Numbers** → the number → **Messaging** → *A message comes
   in*: **Webhook**, `https://<public address>/api/public/twilio/sms`,
   **HTTP POST**. That is the only one set by hand.

base.win tells Twilio where to call back with each text and call, all built
from `STARBASE_PUBLIC_URL`, and checks Twilio's signature
(`X-Twilio-Signature`, with the auth token) on every one. Each answers at
every address of the server, the campaign's website domain included:

| Address | When |
|---|---|
| `/api/public/twilio/sms` | a text comes in (set by hand, above) |
| `/api/public/twilio/sms-status/:id` | a text's delivery report |
| `/api/public/twilio/voice/:token` | a call: "press 1" |
| `/api/public/twilio/voice/:token/connect` | the caller pressed 1 |
| `/api/public/twilio/voice-dial/:id` | the person's line is dialled |
| `/api/public/twilio/voice-status/:id` | the call's status |

| Setting | Default | Notes |
|---|---|---|
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | — | all three, or texting and calling are off |
| `TWILIO_VOICE` | on | `off` keeps texting and turns calls through the campaign's number off |
| `TWILIO_WORKSPACE` | — | the workspace slug a text from an unknown number is filed under, when several campaigns share one server and number |

Election texting has rules of its own; confirm bulk texting with counsel
first (TESTING.md, *Texting and calls — confirm with counsel*).

**Check:** Services → Texting asks Twilio for the number on this account:
the SID and token work, the number is on the account, and its incoming
messages come to this base.win (if they go elsewhere, it names both).

## Address lookup

Suggests addresses as someone types (the map's *+ Door*, Add person, a
profile's Edit, Add a sign), places a person saved with an address and no
pin, and runs the desk's background *Place on map* over a whole list.

| `GEOCODER` | Service | Key |
|---|---|---|
| `bc` (default) | [BC Address Geocoder](https://www2.gov.bc.ca/gov/content/data/geographic-data-services/location-services/geocoder) — the B.C. government's, built for B.C. civic addresses | none; `BC_GEOCODER_KEY` (from the BC API gateway) for higher limits |
| `google` | Google Geocoding API | `GOOGLE_MAPS_SERVER_KEY` |
| `nominatim` | OpenStreetMap's Nominatim — light use only | none |
| `off` | no lookups; pins by hand | — |

`GEOCODER_FALLBACK=google` keeps the free BC service first and asks Google
only for what BC can't place. A Google key: Google Cloud → **APIs &
Services** → enable the **Geocoding API** (and the **Map Tiles API** for
Google tiles) → **Credentials** → an API key **restricted** to those APIs
and to the server's outgoing IP. It is the server's key; the browser never
sees it.

| Setting | Default | Notes |
|---|---|---|
| `STARBASE_GEO_BOUNDS` | a box around Surrey | `lat,lng\|lat,lng` — suggestions and lookups stay in it |
| `STARBASE_PROVINCE` | `BC` | |
| `GEOCODE_MIN_SCORE` | `75` | BC's match score a pin needs |
| `GEOCODE_ON_SAVE` | on | `off`: no lookup when a person is saved (the background run still places them) |
| `GEOCODE_CONCURRENCY`, `GEOCODE_BACKOFF_MS` | `6`, `30000` | the background run's pace |
| `BC_GEOCODER_URL` | the official service | a self-hosted mirror |

**Check:** Services → Address lookup asks for a few addresses in the
campaign's box.

## Map background

OpenStreetMap's free tiles by default, straight to each phone. Their servers
are run by volunteers and are not for a large team in election week; before
then, either:

- **Google Maps:** `GOOGLE_MAPS_TILES=1` with `GOOGLE_MAPS_SERVER_KEY` (Map
  Tiles API enabled, above); `GOOGLE_MAPS_TILE_TYPE` roadmap | satellite |
  terrain (the standard look; each person can switch to the others under
  Show → Map). base.win fetches them for signed-in phones (`/tiles/…`), so
  the key stays on the server.
- **Another provider:** `STARBASE_TILE_URL` (`https://…/{z}/{x}/{y}.png`, a
  key may ride in the query string — the phones see it),
  `STARBASE_TILE_ATTRIBUTION`, `STARBASE_TILE_MAX_ZOOM`.

**Check:** Services → Map background opens a Google tiles session when
Google is on.

## Two-step sign-in key

Two-step sign-in (a code from an authenticator app after the password —
anyone can turn it on in **Your profile**; a manager can require it for desk
roles under **Settings → Members**) keeps each person's authenticator key
sealed (AES-256-GCM) with a key from the environment. Recovery codes are kept
only as slow hashes, which need no key.

| Setting | Default | Notes |
|---|---|---|
| `STARBASE_TWO_STEP_KEY` | — | 32 or more random characters, e.g. `openssl rand -base64 32`; a different one on staging and production. Unset (or shorter), base.win makes a key of its own and keeps it in the database — it works, but anyone with a copy of the database could read the keys, so **Settings → Services** says *Not set up* until it's there |

Setting it later is safe: a key sealed with the database's moves to the new
one the next time its owner signs in. To change it, put the new key first
and the old one after, separated by a comma (`new,old`); drop the old one
once everyone has signed in. A key that's lost can't be got back: people
sign in with a recovery code (and set it up again), or a manager resets
theirs under **Settings → Members**.

## Online payments — Stripe

[stripe.com](https://stripe.com). Gifts once or monthly and membership dues
on the campaign's website (its donate and join forms), paid on Stripe's own
checkout page — by card, and by Apple Pay or Google Pay where the donor's
phone has them — so a card number never touches base.win. base.win calls
Stripe with plain HTTPS (no SDK, `server/ext/payments`) and hears back on
one webhook.

What happens:

- **Before Stripe's page opens**, the website's form has recorded the
  person (money only ever lands on the same email's record, or on someone
  new's) and the checkout, in one write; Stripe is asked only after it, so
  no other write in the campaign ever waits on Stripe. base.win checks the
  eligibility declaration was ticked and refuses what no one may give —
  more than this year's limit at once, or a monthly gift over a twelfth of
  it — in plain words, and Stripe is never asked. What this person gave
  before is never asked here (the form would tell anyone who typed their
  name): it is checked when the payment lands. Stripe's page starts with
  the email the visitor typed, never the one on file (an email is needed;
  one Stripe refuses is said on the form's email field).
- **When the payment lands** (Stripe's webhook), it becomes a gift exactly
  as the desk logs one: method card, marked *online*, the declaration kept
  with it, the limit checked, the receipt issued and emailed by itself.
  Nothing is retyped. Each month of a monthly gift is that month's gift; the
  donor is a monthly donor (a pledge) until the subscription ends. Membership
  dues make the membership (source *website*) and log the dues as a gift.
- **Over the limit when it lands** (gifts logged at the desk while they were
  on Stripe's page): no gift is logged; the payment is refunded through
  Stripe (tried again if Stripe doesn't answer), the donor is emailed
  plainly, and **Donations → Needs you** shows it until the treasurer taps
  *Got it*.
- **Over only with another record that may be the same donor** (another
  email, or a cheque at the desk on their voter record: the same first and
  last name, and the same postal code, phone or street address): the gift
  is logged and flagged under Needs you — "Maybe $… over the … limit", the
  other record under *Why?* — never refunded, since it may be someone
  else. A cheque logged at the desk after the gift online is added up the
  same way, and a postal code is its letters and digits (V3T-2C3 is V3T
  2C3). The treasurer merges the two (People → Duplicates) and refunds, or
  taps *Not the same person* on the flagged gift, one choice for each
  record it names (two that read the same: *Compare in Duplicates*, the
  pairs with the donor and with the records it names), or *Not the same*
  in Duplicates: that pair is
  kept apart and the gift is added up again without it, so the flag goes
  or names what is left. Two records marked Not the same are never added
  up together, and a refund or a lost dispute on the other record's gift
  takes it out of the maybe the same way.
- **A refund or a dispute in Stripe**: a full refund voids the gift and its
  receipt (refunded dues void the membership); a partial refund and an open
  dispute are flagged under Needs you; a lost dispute voids the gift. A
  dispute can be for only part of a payment; when such a dispute is lost,
  the gift is flagged (void it and log what was kept) rather than voided.
  Over the limit, what the bank didn't take back is still with the
  campaign: Needs you and Today show it until the treasurer returns it to
  the donor by hand (Stripe won't refund a payment with a lost dispute) and
  taps *Got it*.

**Set it up — test mode first, on staging:**

1. Stripe → the campaign's account (its business details are the financial
   agent's to give). Developers → **API keys**, in **test mode**: the secret
   key (`sk_test_…`) — or better a **restricted key** with write access to
   Checkout Sessions and Refunds and read access to Payment Intents,
   Subscriptions, Invoices and Webhook Endpoints (if a test gift is refused
   for a missing permission, add the one Stripe names).
2. Developers → **Webhooks** → **Add endpoint**: the address **Settings →
   Services → Online payments (Stripe)** shows
   (`https://<public address>/stripe/webhook`; on the campaign's own
   website domain, `https://<site domain>/stripe/webhook` answers too), with
   these events: `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`,
   `invoice.paid`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `charge.refunded`,
   `charge.dispute.created`, `charge.dispute.closed`. Copy its **signing
   secret** (`whsec_…`).
3. Both go in the host's environment only (Render → the service →
   **Environment**): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — never in
   the repo, a chat or an email.
4. **Settings → Services** says *Test mode*; **Check** reads the webhook
   back from Stripe.
5. Give on the staging website with Stripe's test card (`4242 4242 4242
   4242`, any future date, any CVC): Donations shows the gift marked
   *online*, with its receipt. Try a monthly gift and a membership, and a
   refund from Stripe's dashboard (the gift goes void).
6. Production: the same with **live** keys and a live webhook endpoint
   (Stripe gives it its own signing secret). Apple Pay and Google Pay are
   switched on in Stripe → Settings → Payment methods (Apple Pay wants the
   website's domain added there).
7. Stripe → Settings → **Customer emails**: leave Stripe's own payment
   receipts off — base.win emails the contribution receipt (Donations →
   More → Receipts), and two receipts for one gift confuse donors.

| Setting | | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_live_…`, `sk_test_…` or a restricted `rk_…` | a test key is test mode: no real money moves, and the desk says *Test mode* |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` | the endpoint's signing secret; a comma list while Stripe rolls it to a new one |
| `STRIPE_API_BASE` | — | tests only: a stand-in for `api.stripe.com` |

Without both, the website's donate and join forms say online payments aren't
set up, and the webhook answers 503.

**The webhook** (`POST /stripe/webhook`, no sign-in): a delivery must carry
Stripe's signature over its exact bytes (compared in constant time, five
minutes' tolerance either way) or it is refused with 400 and nothing is
read. Each event is done once (`stripe_events`). Anything not from a
base.win checkout — another app on the same Stripe account — is answered
200 and left alone. A failure answers 500, so Stripe tries again. Stripe
sends events in no set order: a refund or a dispute that comes before its
payment is recorded (the payment's own event still being retried, say) is
looked up in Stripe and, when it's the campaign's, kept and done in the
same write that records the payment.

**Check:** Services → Online payments reads the webhook endpoints back from
Stripe: the key works, and one of them sends every event above to this
address.

## Phone dialer — CallHub

[callhub.io](https://callhub.io). base.win's own phone bank is one
volunteer, one number, one tap. CallHub is a dialer for a room of callers.
With it connected the campaign keeps choosing who to call in base.win — a
list or a phone bank — sends it to CallHub, and sees every call's result on
the person. The calling campaign itself (its script, its survey, its
callers, the number it shows) is made in CallHub, on the phonebook base.win
sent. base.win calls CallHub with plain HTTPS (no SDK, `server/ext/callhub`).

**Built from CallHub's published documentation. Before your first calling
night: press Check, then make one test call and see its result arrive on
the person.** CallHub's documentation could not be opened while this was
built (the build ran where `developer.callhub.io` could not be reached):
what is here follows its reference pages as search results quote them, and
two third-party clients. Nothing has been run against a real CallHub
account. *What is not confirmed*, below, lists exactly what; the Settings →
Services row says the same.

What happens:

- **Send to CallHub** (a list's page, a phone bank's page — managers, staff
  and treasurers; the button is there only when CallHub is set up). It asks
  first: how many numbers go, for how many people, how many are left out.
  Who goes:
  everyone on the list (a phone bank: its numbers still to call) with a
  number that can be dialled, **never** someone tagged `do-not-contact` or
  `do-not-call`, and never a number one of them shares. One CallHub contact
  per number: where several people share a number, the first by name is
  the one sent, and the one results are filed on. **Only the phone number,
  first and last name and city leave base.win** — never a rating, a tag, a
  note, an email or a street.
- **In the background**, a job makes a phonebook in CallHub named for the
  list and the time ("Undecided in Newton — Nov 10, 9:55 am") and adds one
  contact a second. The line on the page says how far it is ("Sending ·
  850 of 2,000", then "Sent"). CallHub's documented limit is 3,600
  contacts a day: a bigger list says so and carries on by itself the next
  day, as it does when CallHub says to slow down. A number CallHub won't
  take is left out and counted, with CallHub's words and whose it was (the
  name is a way to their page); if CallHub refuses the push itself (a key
  that stopped working), it stops with CallHub's words and how far it got,
  and **Carry on** picks up where it stopped (*Send again instead* is
  beside it, for a fresh phonebook). A push left part-way with nothing
  behind it — its background job gave up — says *it stopped part-way*
  and offers **Carry on** alone. Nobody is sent twice.
- **People not to call** go to a do-not-call list in CallHub named
  `base.win`, numbers only, with each push: people tagged `do-not-contact`
  (no calls, no texts) or `do-not-call` (no calls), and numbers that
  replied STOP to a text (no texts). Someone newly tagged `do-not-call` or
  `do-not-contact` does not wait for the next push: once the campaign has
  sent CallHub anything, a background job tells CallHub by itself (a number
  already there for texts only is changed to calls too). The list follows
  base.win the other way too: when nobody here blocks a number any more
  (the tag taken off again), base.win takes it off CallHub's list, by the
  entry CallHub named for it. Where CallHub never named one, or won't let
  it go, a list's page says how many are still there and whose they are,
  and **Check** names the first few — take those off in CallHub. While a
  push is telling CallHub these numbers its line says so
  (*Telling CallHub who not to call first · 150 to go*). A number CallHub
  won't take for that list never stops a push: it is said on the page with
  CallHub's words and whose number it is (a few by name, *Show all* for the
  rest), and asked about again with the next push; the line goes once
  there is nothing left to take. Only if CallHub takes none of a
  campaign's numbers at all
  (five refused in a row before any was ever taken) does the push stop,
  once, with CallHub's words; **Carry on** goes on without them. Whether a
  calling campaign in CallHub honours that list by itself or has to be
  pointed at it is not confirmed: look in CallHub before the first night.
- **Each call's result** comes back as the caller saves it (CallHub's
  `cc.notes` webhook). It is matched by phone number against the numbers
  this campaign sent (the newest push first) and becomes one phone call on
  the person's history: the calling campaign's name, CallHub's result, the
  caller's notes and the survey answers (the number is looked for under
  the result's `contact`, then its `mobile`). A caller whose CallHub email
  is their base.win sign-in is credited with the call; anyone else is named
  in the note. If the person is in an open base.win phone bank, the number
  is crossed off there too (a No answer comes back by the bank's own
  rule). The same result sent twice is one call. A result for a number
  base.win never sent is kept, unfiled — it never lands on a guess and
  never makes a person.
- **What each result counts as**: CallHub's results are the account's own
  words, so each push has a short table — filled in by pattern (*No
  answer*, *Busy* → No answer; *Voicemail*, *Left message* → Left message;
  *Wrong number*, *Disconnected* → Wrong number; *Refused*, *Not
  interested* → Refused; *Do not call*, *Remove* → Refused, and the person
  is tagged `do-not-call`; *Moved* → Moved; anything else → Talked) and
  yours to correct. A correction also moves the results already in — only
  the ones it is about — and an open phone bank's number with them (a
  *Talked* that was a No answer comes back by the bank's own rule). Turning
  a row to *Do not call* asks first (*Tag the 6 people with "Answered"
  do-not-call?*), and so does putting it back (*Stop counting "Answered"
  as do not call?* — a slip of one arrow key on the row is caught too);
  **Yes** takes the tag off everyone it tagged, however often each was
  rung (and from the record kept, when the one it tagged was merged with
  a duplicate since), and their numbers off CallHub's list — never a tag
  someone set by hand (on either record, when two were made one), and
  never bringing back one the desk took off by hand. Anyone it leaves
  do-not-call all the same is named on the saved line, so the desk can
  look (*1 person stays do-not-call, tagged by hand — Ida Example*; or
  *another call says so*). A push with
  thousands of results is moved a part at a time, in the background.
- **A new push starts with the newest push's table** and support question,
  so a pick is made once. What is taken back on a push is taken back on the
  pushes sent since that still carry it — a row that no longer counts as
  *Do not call*, an answer that no longer rates as it did, a support
  question dropped — and the question before it says so (*… — here and
  on the 1 list sent since*), as does the saved line (*1 list sent since
  follows too*). Never the other way: a pick that tags people, or an
  answer newly mapped, is about the one list it was asked on.
- **Ratings** only ever come from a survey answer someone mapped: pick the
  support question on the push, then which answer is which step of the
  campaign's scale. Until then the answers stay in the note and nobody's
  rating moves. A rating is never guessed, and a newer rating (a knock
  since) is never overwritten by an older call. Mapping an answer asks
  first, and can be taken back: when an answer stops rating (*Doesn't
  rate*, or another question, or none) the people it rated are back to what
  they were before the call, unless something else has rated them since.

**Set it up — on staging first:**

1. The API key from the account's settings in CallHub. It goes in the
   host's environment only (Render → the service → **Environment**):
   `CALLHUB_API_KEY` — never in the repo, a chat or an email. If the
   account's API is on another host (CallHub's own docs show
   `https://api-[region].callhub.io`; `api-na1.callhub.io` is one), set
   `CALLHUB_API_BASE` to it.
2. **Settings → Services → Phone dialer (CallHub)** → **Check**: the key
   works. Then **Connect**: base.win gives CallHub the address to send each
   call's result to (it needs `STARBASE_PUBLIC_URL`). **Check** again: *The
   key works · results come back here*.
3. On a small list of your own team's numbers: **Send to CallHub**. In
   CallHub, make a call-center campaign on the phonebook base.win made, and
   see that it leaves out the numbers on the `base.win` do-not-call list.
4. Make two test calls: save one with a note typed, one with only a result.
   Each should be on that person's history in base.win within seconds, and
   the list's page should say *2 results back*. If one is not, press
   **Check**: it says whether results arrived for numbers base.win never
   sent, or in a shape base.win could not read (those are kept as they
   came, for whoever fixes it).
5. Under **What each result counts as**, look over the table; if the survey
   has a support question, pick it and say what each answer means.

| Setting | Default | Notes |
|---|---|---|
| `CALLHUB_API_KEY` | — | the account's API key; without it the row says *Not set up*, there is no Send to CallHub button, and the results address answers 503 |
| `CALLHUB_API_BASE` | `https://api.callhub.io` | the API's address for this account, when it is on another host; also how the tests point at a stand-in |

**The results address** (`POST /hooks/callhub/<key>`, no sign-in; it also
answers on the campaign's website domain). Nothing documents a signature on
CallHub's deliveries, so the lock is the address itself: its last part is 32
characters made from the API key, compared whole before anything is read,
never shown on a screen and never on the log. A new API key is a new
address: Check then says to Connect again, and Connect takes the old one
away. What a delivery can do is bounded all the same: it can only land on
someone whose number this campaign itself sent, once, and it never makes a
person. Each result is kept as it came (`callhub_results`, in the full
export). A failure answers 500, so a sender that retries sends it again.

**What is not confirmed** (it needs one evening with a real account):

1. The shape of a result as CallHub really sends it. base.win reads JSON or
   a form, with the fields at the top level or inside `data`, the caller as
   `agent.email` however it is nested, and the survey as a list or as text.
   A delivery it cannot read is kept as it came and counted by Check.
2. Whether a result comes for every call. CallHub's reference describes
   `cc.notes` as sent "when an agent adds a note"; a call saved with a
   result and no note may or may not send one (step 4 finds out).
3. Whether CallHub signs or retries its deliveries. No signature is checked
   (none is documented); the address is the lock.
4. The API's host for the campaign's account (`CALLHUB_API_BASE`).
5. How CallHub treats a number that is already a contact when it is added
   to a second phonebook, and whether it refuses numbers it thinks invalid
   (those are left out and counted).
6. Whether a result carries any id for the call. None is documented, so
   the same campaign, number, caller, result, notes and recording within
   fifteen minutes is taken to be the same call.
7. Whether a calling campaign honours the `base.win` do-not-call list by
   itself or has to be pointed at it (step 3).
8. Whether CallHub lets a number be taken off its do-not-call list through
   the API, and whether it refuses numbers there that it thinks invalid.
   Both are handled as documented; what CallHub would not take, or would
   not let go, is said on the page and by Check.

Not built yet: a large list by file (CallHub's bulk import), and reading a
calling campaign's full export afterwards as the audit. CallHub's texting
and voice broadcast are not used: base.win has its own texting, and two
systems texting one voter is how a STOP gets missed.

Political calls have rules of their own (the CRTC: a campaign must keep and
honour its own do-not-call list and say who is calling; automatic dialers
have more). Confirm them with counsel before a calling night, as for
texting (TESTING.md).

**Check:** Services → Phone dialer asks CallHub two things and writes
nothing: the key works, and one of the account's webhooks sends call
results (`cc.notes`) to this base.win. Then it says how many results have
arrived, how many were for numbers base.win never sent and how many it
could not read. On a line of its own, since it is yours to do in CallHub:
how many numbers are still on CallHub's do-not-call list that nobody here
blocks any more — with whose the first few are (a list's page names them
all).

## Hosting — Render

`render.yaml` is a Render Blueprint: `starbase-staging` (deploys every push to
`main`) and `starbase` (deploys the `production` branch), each with its own
Postgres. Settings marked `sync: false` are asked for when the Blueprint is
created and are set per service afterwards. GOING-LIVE.md is the order to do
it in.

## GitHub Actions

- **CI** (`.github/workflows/ci.yml`) — the server suite (in-memory and over
  the Postgres wire protocol) and the web build, on every push to `main` and
  `production`. No secrets.
- **Promote to production** (`.github/workflows/promote.yml`) — GitHub →
  Actions → *Promote to production* → Run workflow: fast-forwards
  `production` to `main` once CI is green there, never rewrites it. Render
  then deploys production. Uses only the workflow's own token.

## The campaign's website

The website (hosted apart) sends people in through a small JSON API with a
key — sign-ups, petition signatures, volunteer forms, newsletter opt-ins.
It must call it **from its own server** (its form handler, a serverless
function, a form service's webhook), never from JavaScript in the visitor's
browser: the key would be visible to anyone.

**A key:** Settings → Services → *Website keys* → name it (*Website*) →
**Make a key**. It is shown once — copy it into the website's own secret
settings. base.win keeps only a hash of it, lists it by its first characters
with when it was last used, and **Revoke** stops it at once. Use one key per
website or form service.

```
Authorization: Bearer sbk_…             every request
GET  https://<public address>/in/v1/ping      → 200 { "ok": true, "campaign": "Imagine Surrey", "key": "Website" }
POST https://<public address>/in/v1/people    → 200 { "ok": true, "person_id": "…" }
```

**`POST /in/v1/people`** — JSON (`Content-Type: application/json`), one
person. An email or a phone, and a name (or `first_name` / `last_name`):

| Field | | |
|---|---|---|
| `name` or `first_name`, `last_name` | text | |
| `email` | text | how a sign-up is matched first |
| `phone` | text | any format |
| `address`, `unit`, `city`, `postal` | text | the street line as typed (`13450 104 Ave`); it's placed on the map |
| `tags` | up to 20 words | kept as sent (`Petition: Transit`) |
| `source` | a word for where they came from (`petition-transit`) | added as a tag; default `website` |
| `newsletter` | `true` | a new email goes on the newsletter list; someone who unsubscribed or is do-not-email is never put back on from here (typing an address into a form doesn't prove it's yours) |
| `volunteer` | `true` | a *Wants to volunteer* request under Today → *Needs you*, with `note` |
| `note` | what they wrote | with the volunteer request; on its own, a request for the desk (*Something else*) — never written onto their record |

Anything else (a rating, a role, money) is refused: the website never sets
what only a canvass or the desk decides.

What a visitor typed isn't proof of who they are, so a sign-up never lands
on someone else's record: the same **email** finds a person on file, whose
blanks are filled and tags added (nothing on file is overwritten); with no
email, the same **name and phone** only adds the tags; anything else is a new
person. The answer is the same either way, and says nothing about what was
on file:

```json
{ "ok": true, "person_id": "…" }
```

**Retries:** send an `Idempotency-Key` header (the form submission's own id,
up to 200 characters). The same key with the same body answers what it
answered the first time, with `"replayed": true`, and never makes a second
person; the same key with a different body is refused (409).

**Errors:** `401` no key, a wrong one or a revoked one · `400` a field
missing or not allowed (the message names it) · `415` not JSON · `409` an
Idempotency-Key reused with another body · `429` more than 120 requests a
minute on one key. Everything accepted is on the event log, as the
manager who made the key. A key stops working when it is revoked, and when the manager who made it leaves the campaign.

```sh
curl https://starbase.imaginesurrey.ca/in/v1/people \
  -H "Authorization: Bearer $STARBASE_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: form-2026-10-12-0193" \
  -d '{"first_name":"Asha","last_name":"Example","email":"asha@example.org",
       "postal":"V3T 1V8","newsletter":true,"source":"petition-transit"}'
```

Donations and RSVPs are not taken this way: a gift is logged at the desk
(Donations → Log a gift), where the contribution limits are checked, or
paid online through Stripe ([Online payments](#online-payments--stripe)).

Also, without a key: **files in** — People → Import takes a CSV or
spreadsheet (a dry run first; a `voted` column marks who voted and never
un-marks anyone; Settings → Services gives its address:
`…/desk/people/import` on base.win, `…/admin/people/import` at the server's
own address); **pages out** — the website can link to base.win's public
lessons (`/learn/…`); every email carries its own unsubscribe page.
