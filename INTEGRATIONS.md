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
| [Email — Resend or SendGrid](#email--resend-or-sendgrid) | invites, newsletters, press, ladders, shift alerts, receipts; bounces and spam complaints back | yes | `RESEND_API_KEY`, `MAIL_FROM` (+ `RESEND_WEBHOOK_SECRET`); or `MAIL_PROVIDER=sendgrid`, `SENDGRID_API_KEY`, `SENDGRID_WEBHOOK_PUBLIC_KEY` |
| [Mailchimp](#mailchimp) | a list sent to the campaign's Mailchimp audience as a tag; unsubscribes and dead addresses back, and base.win's own out | no (only if the campaign builds its emails in Mailchimp) | `MAILCHIMP_API_KEY` (+ `MAILCHIMP_AUDIENCE_ID`, `MAILCHIMP_WEBHOOK_SECRET`) |
| [Texting and calls — Twilio](#texting-and-calls--twilio) | the campaign's number: texts, text blasts, ladder texts, calls, SMS shift alerts | no (phones' own apps until then) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` |
| [Address lookup](#address-lookup) | suggestions as you type, placing people on the map | yes (free default, no key) | `GEOCODER`, `GEOCODER_FALLBACK`, `BC_GEOCODER_KEY`, `GOOGLE_MAPS_SERVER_KEY` |
| [Map background](#map-background) | the map volunteers walk | no (free default; change before election week) | `GOOGLE_MAPS_TILES`, `GOOGLE_MAPS_SERVER_KEY`, or `STARBASE_TILE_URL` |
| [Two-step sign-in key](#two-step-sign-in-key) | seals everyone's authenticator key | before the public link goes out (works without, with a warning) | `STARBASE_TWO_STEP_KEY` |
| [Hosting — Render](#hosting--render) | the two environments | yes | `render.yaml` |
| [GitHub Actions](#github-actions) | tests, and promoting staging to production | yes | none |
| [The campaign's website](#the-campaigns-website) | sign-ups, petitions, volunteers, newsletter opt-ins in | when the website is ready | a website key (Settings → Services) |
| [Online payments — Stripe](#online-payments--stripe) | gifts once or monthly and membership dues on the website, by card, Apple Pay or Google Pay | when the website takes money (test mode first) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |

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

## Email — Resend or SendGrid

One email sender per deployment, behind one small layer (`server/lib/mail`:
plain HTTPS, no SDK, a file per sender). [Resend](https://resend.com) is the
default and the one base.win was built on;
[SendGrid](https://sendgrid.com) is there for a campaign that already pays
for it. `MAIL_PROVIDER` names one (`resend` or `sendgrid`); unset, base.win
uses whichever has its key, Resend first — so a deployment with only
`RESEND_API_KEY` sends exactly as it always has. A sender that is named but
not set up is never quietly swapped for the other one.

**Resend**

1. Resend → **API Keys** → create a key. *Full access* lets base.win show
   the domain's DNS records and check the webhook; a *Sending access* key
   sends just as well, and Settings → Services says what it can't see.
2. Set `RESEND_API_KEY` to it and `MAIL_FROM` to a sender on the campaign's
   domain: `Imagine Surrey <team@imaginesurrey.ca>`. Staging: a separate
   key, or none.
3. **Settings → Services → Email → Sending domain** → **Add domain**. The
   panel lists the DNS records Resend asks for (SPF, DKIM) and one more,
   DMARC — no sender sets that one up, and Gmail, Yahoo and Outlook ask
   bulk senders for it (the panel offers the least there is, `v=DMARC1;
   p=none`). Add each at the domain's DNS host, then **Check again** until
   every line says *In*. (Adding the domain in Resend's own screen does the
   same; the panel then shows where it stands.)
4. Bounces and complaints: Resend → **Webhooks** → **Add webhook** with the
   address on the Email row (`https://<public address>/hooks/mail/resend`)
   and the events listed there. Set `RESEND_WEBHOOK_SECRET` to the webhook's
   signing secret (`whsec_…`).

**SendGrid**

1. SendGrid → **Settings → API Keys** → a key that can send mail (with
   access to Sender Authentication the panel can show the domain's records).
2. Set `MAIL_PROVIDER=sendgrid`, `SENDGRID_API_KEY` and `MAIL_FROM`
   (SendGrid has no test sender: without `MAIL_FROM` nothing is sent).
3. **Sending domain**, as above (SendGrid asks for three CNAME records
   when the domain is added with its automated security, as base.win adds
   it).
4. SendGrid → **Settings → Mail Settings → Event Webhooks**: the address on
   the Email row (`https://<public address>/hooks/mail/sendgrid`), the
   events *delivered*, *bounce*, *dropped*, *deferred* and *spam report*,
   and **Signed Event Webhook** on. Set `SENDGRID_WEBHOOK_PUBLIC_KEY` to its
   verification key.

base.win turns SendGrid's own click, open and unsubscribe tracking off in
every email: it counts its own and has its own unsubscribe pages.

One difference to know before choosing it: SendGrid has no idempotency key.
With Resend, an email tried again after a timeout is dropped by Resend when
the first try did get through. With SendGrid it can arrive twice — a receipt
or an over-limit notice that base.win tries again by itself after SendGrid
didn't answer. Newsletters and list emails are the exception: base.win
waits for SendGrid's delivery events before it offers *Try again* (below).

**What comes back.** Every newsletter, press and list email carries
base.win's own reference, and base.win keeps the sender's id for it. The
sender then posts what happened to `/hooks/mail/<sender>` — signed (Svix's
HMAC for Resend, an ECDSA signature for SendGrid; checked over the exact
bytes), each event done once, and answered at every address of the server,
the campaign's website domain included:

- **Delivered** — the send's row says *Delivered 1,180 of 1,200*. Until the
  sender has said something, a send says *sent*, as before.
- **Bounced for good** — the address goes on the campaign's suppression
  list (`email_suppressions`): no list, newsletter or ladder emails it again,
  and a send saved earlier leaves it off when it goes. A bounce is about the
  address, not the person: nobody's consent changes, and a person given a
  new address is reachable again. A full mailbox or a block is not a
  bounce for good and stops nothing.
- **Marked as spam** — the address is suppressed and the consent is ended
  too (off the newsletter, or *do-not-email*, with the no on record). A send
  at or over 0.1% complaints says so on its row; that is Gmail's line.
- **Refused by the sender** (its own suppression list) — counted with the
  bounces and suppressed here too, so the two lists agree.
- A bounce or a complaint about an email that wasn't a newsletter or a list
  email (a receipt, a ladder email, an invite) still stops the address, in
  every campaign on the server that holds it.
- **Not sure it went** (the sender never answered): any event that says the
  sender has the email settles it. Resend drops a repeat that carries the
  same key, so *Try again* is safe there after ten minutes. SendGrid has no
  such key: *Try again* is offered only after thirty minutes, once its
  events have come in since and none was for that email — and it says a
  second copy is possible.

There is no button yet to take an address back off the suppression list; a
corrected address is a different address and is not on it.

| Setting | Default | Notes |
|---|---|---|
| `MAIL_PROVIDER` | — | `resend` or `sendgrid`. Unset: whichever has its key, Resend first |
| `MAIL_FROM` | Resend: `onboarding@resend.dev` | Resend's test sender reaches only the account's owner — set it. SendGrid needs it |
| `RESEND_API_KEY` | — | without a sender's key nothing is emailed: sends are recorded as *queued*, invites show their link to copy, receipts wait |
| `RESEND_WEBHOOK_SECRET` | — | the Resend webhook's signing secret; a comma list while one is rolled to the next. Without it delivery events are refused (503) |
| `RESEND_REGION` | `us-east-1` | where **Add domain** makes the domain at Resend (`us-east-1`, `eu-west-1`, `sa-east-1`, `ap-northeast-1`; Resend has no Canadian region) |
| `SENDGRID_API_KEY` | — | SendGrid's key |
| `SENDGRID_WEBHOOK_PUBLIC_KEY` | — | the Event Webhook's verification key, as SendGrid shows it (or a PEM block); a comma list while it is changed |
| `SENDGRID_API_BASE` | `https://api.sendgrid.com` | `https://api.eu.sendgrid.com` for an EU subuser |
| `STARBASE_EMAIL_TIMEOUT_MS` | `15000` | one email's time limit |

Opens and clicks are still counted by base.win itself (`/o`, `/c`), and
unsubscribes are base.win's own pages.

**Check:** Services → Email reads, and sends nothing: the key works;
`MAIL_FROM`'s domain is on the sender's account and verified; the domain has
a DMARC record (base.win's own DNS lookup); and bounces and complaints come
back — at Resend, a webhook to this server with those events and the secret
set here; at SendGrid, the verification key set and an event that has come
in. Each thing missing is one sentence saying what to do. A sending-only key
can't list domains or webhooks: the check says so and the key is fine.

Built against Resend's published API; confirm on your own account with
Settings → Services → Check before relying on it. Sending through Resend is
what base.win has always done; its delivery events and its domain calls are
new here and have not been run against a real account. Not confirmed there:
every value a bounce's type can take (base.win stops an address only on
*Permanent*), and that an email to an address on Resend's own suppression
list is accepted and then reported as *suppressed*.

Built against SendGrid's published API; confirm on your own account with
Settings → Services → Check before relying on it. It has not been run
against a real SendGrid account. Not confirmed there: how the spam-report
event is spelled as delivered (both spellings are read), that base.win's
reference comes back on each event (the sender's id is used when it
doesn't), the name of the header that carries that id (`X-Message-Id`), how
big a batch of events can be (up to 1 MB is taken), and how a retried
delivery is stamped (no age limit is put on its signature).

## Mailchimp

[mailchimp.com](https://mailchimp.com). For a campaign whose communications
lead already builds emails in Mailchimp and wants to keep doing so. The
audience is still chosen in base.win, and nobody who said no in either place
is emailed from the other. base.win calls Mailchimp's Marketing API with
plain HTTPS (no SDK, `server/ext/mailchimp`). Not needed to launch: without
`MAILCHIMP_API_KEY` there is no button and nothing else changes.

What happens:

- **A list becomes a tag.** On a list's page, **Send to Mailchimp** (desk
  roles; later **Sync again**). It asks first: how many addresses go. By
  default only the list's addresses that are **subscribed to base.win's
  newsletter**; one tick — *Everyone on this list who can be emailed; they
  agreed to hear from us by email* — widens it to everyone the list could
  email (never do-not-email, do-not-contact, unsubscribed, or an address
  that bounced). Mailchimp's terms require permission, which is why the
  careful one is the default.
- **Only the email address, first name and last name leave base.win.**
  Never a rating, a tag, a note, a street address or anything about money.
- **Nobody already in the audience is changed.** New addresses are added as
  subscribed; someone already there keeps their name and their status, so a
  person who unsubscribed in Mailchimp is never put back. Then the tag
  **base.win: *list name*** is brought into line with the list: who is
  missing joins it, who left the list leaves it (they stay in the audience).
  Running it twice changes nothing. It works in the background and the line
  under the buttons says how it stands — *Syncing with Mailchimp · 1,500 to
  go*, *In Mailchimp · 4,212 addresses · tag “base.win: Members”*, or
  *Stopped: Mailchimp said …* with **Try again**. If Mailchimp says "too
  many" or is down, base.win tries again by itself and carries on where it
  stopped.
- **Unsubscribed and cleaned come back.** Someone who unsubscribes in
  Mailchimp is turned off here — off the newsletter list, or *do-not-email*
  when they were never on it — with a no on the consent record (source
  `mailchimp-unsubscribe`), unless they have said yes *here themselves*
  since they left there (ticked the newsletter box on the campaign's
  website, or used their own link from an email): a newer yes of their own
  is not undone by an older no. An address the team typed in or imported
  is the team's word, not theirs, and does not count. An address
  Mailchimp *cleaned* (it bounced for good) goes on the suppression list, so
  nothing here emails it either. Three ways it arrives: Mailchimp's webhook,
  the moment it happens; a job every night, for anything a webhook missed
  (once a week, and the first time, it reads everyone unsubscribed or
  cleaned, so someone added here after they left there is found); and **Pull
  now** on Settings → Services. Every sync pulls first, so nobody who left
  in Mailchimp is ever offered to it again. Only addresses the campaign
  already holds are touched: nothing is kept about a stranger.
- **base.win's own no goes out.** An unsubscribe here (the link in an email,
  the desk's Remove), a *do-not-email* or *do-not-contact* tag, or an address
  that bounced or reported spam: within moments the member is marked
  unsubscribed in Mailchimp — only if Mailchimp has them as subscribed. An
  address Mailchimp doesn't have is never added to say no for it. **base.win
  never moves anyone in Mailchimp to subscribed.**
- **The webhook is only a hint.** Whatever a delivery says, base.win then
  reads that member from Mailchimp itself and acts on the answer, so a forged
  call can do nothing but cause one read, about an address already on file.
  Its address ends in 32 characters made from the API key (never shown here;
  Connect gives it to Mailchimp), and when `MAILCHIMP_WEBHOOK_SECRET` is set
  each delivery must also carry Mailchimp's signature.

Before you connect: the first pull turns off, here, everyone on file who has
unsubscribed in that Mailchimp audience. That is the point — and the desk
cannot put them back; only they can. So be sure the audience is the one the
campaign's emails really go to.

Set it up:

1. In Mailchimp, create an API key (today: your profile → **Account &
   billing** → **Extras** → **API keys**). The whole key, ending included
   (`…-us19`: that is the server the account lives on).
2. Set `MAILCHIMP_API_KEY` to it. An account with more than one audience
   also needs `MAILCHIMP_AUDIENCE_ID`: **Check** names each audience with
   its id so you can pick.
3. **Settings → Services → Mailchimp** → **Check**: *The key works ·
   audience “…” · 4,212 subscribed — but Mailchimp isn’t sending
   unsubscribes here yet: tap Connect*.
4. **Connect** (the one step that changes something at Mailchimp): it adds a
   webhook on the audience to this base.win's public address
   (`STARBASE_PUBLIC_URL` must be set) for *unsubscribes*, *cleaned* and
   *address changes*, from subscribers and admins — not from the API, so
   base.win's own changes don't echo back. If Mailchimp answers with a
   **signing secret**, it is shown once: copy it into
   `MAILCHIMP_WEBHOOK_SECRET`. (Connect again later shows no secret —
   Mailchimp gives it once. For a new one, delete the webhook in Mailchimp,
   under the audience's settings, and Connect again.)
5. **Check** again: *… · unsubscribes come back here*. Then **Pull now**
   once, for everyone who left before today.

| Setting | Default | For |
|---|---|---|
| `MAILCHIMP_API_KEY` | — | the key; its ending is the account's server |
| `MAILCHIMP_AUDIENCE_ID` | the account's only audience | which audience, when the account has several |
| `MAILCHIMP_WEBHOOK_SECRET` | — | optional: the signing secret Connect showed (a comma list while one is rolled). Set, an unsigned delivery is refused |
| `MAILCHIMP_API_BASE` | from the key | tests point it at a stand-in |

**Check:** Services → Mailchimp reads, and writes nothing: the key works;
the audience (with how many are subscribed), or each audience by name when
one has to be chosen; and whether a webhook on it sends unsubscribes and
cleaned addresses to this server — *tap Connect* when it doesn't, or when
it points at an address made from an earlier key. With
`MAILCHIMP_WEBHOOK_SECRET` set it also says when that secret would have
Mailchimp's deliveries refused: the webhook isn't a signed one, or the last
thing it sent didn't match the secret. The line under the
buttons says when the last pull was and what it found, and how many of
base.win's unsubscribes Mailchimp has not been told yet (Pull now sends them
again).

What it does not do: people who said no in base.win **before** Mailchimp was
connected are not told to Mailchimp by themselves — a list sent from here
never includes them, but if the audience has them from elsewhere,
unsubscribe them there once. It does not import an audience (People →
Import reads Mailchimp's CSV export), bring back a Mailchimp campaign's
opens and clicks, or rename a tag when its list is renamed.

Built against Mailchimp's published API; confirm on your own account with
Settings → Services → Check before relying on it. It has not been run
against a real Mailchimp account: only against a stand-in
(`server/test/fake-mailchimp.js`) built from what Mailchimp publishes about
its API — search extracts of its documentation and its own client library;
the documentation itself could not be opened while this was written. Not
confirmed there:

- that webhook signing is on for the account, and the header's exact name
  and shape (`X-Mailchimp-Signature: t=…,v1=…` is what is read; the
  signature is only required once `MAILCHIMP_WEBHOOK_SECRET` is set);
- that Mailchimp asks the webhook's address with a GET before saving it
  (base.win answers 200 there either way);
- what a batch answers for an address that is unsubscribed or cleaned in the
  audience (base.win counts on *nobody already there is changed*, and reads
  who left before every sync);
- how many addresses one tag change takes (500 at a time is sent) and how
  long a tag's name may be (cut at 100 characters);
- whether Mailchimp sends a webhook again after a failure (the nightly pull
  is the net either way).

Before the first real send: on a small list of your own team's addresses,
**Send to Mailchimp**, look at the tag in Mailchimp, unsubscribe one
address there and see it turn off here, then unsubscribe another here and
see it marked unsubscribed there.

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

1. Twilio → buy a Canadian number with SMS and voice. Register it for
   messaging as Twilio requires. For a Canadian campaign that means a
   **verified toll-free number** (or a short code) for any text to a list:
   Twilio's guidance for Canada is that the carriers don't take application
   texts from an ordinary local number, and a toll-free number can't text
   at all until Twilio has verified it. (10DLC registration is a US scheme
   and doesn't apply.) One-to-one texts a volunteer types are another case;
   a local number may serve for those. Settings → Services says which kind
   of number `TWILIO_FROM` is.
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
