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
| [Google sign-in and connections](#google-sign-in-and-connections) | Sign in with Google; the one Google connection Gmail, Drive and Calendar use | no (passwords always work) | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_TOKEN_KEY` |
| [Two-step sign-in key](#two-step-sign-in-key) | seals everyone's authenticator key | before the public link goes out (works without, with a warning) | `STARBASE_TWO_STEP_KEY` |
| [Hosting — Render](#hosting--render) | the two environments | yes | `render.yaml` |
| [GitHub Actions](#github-actions) | tests, and promoting staging to production | yes | none |
| [The campaign's website](#the-campaigns-website) | sign-ups, petitions, volunteers, newsletter opt-ins in | when the website is ready | a website key (Settings → Services) |
| [Online payments — Stripe](#online-payments--stripe) | gifts once or monthly and membership dues on the website, by card, Apple Pay or Google Pay | when the website takes money (test mode first) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| [Phone dialer — CallHub](#phone-dialer--callhub) | a list or a phone bank sent to CallHub's dialer; each call's result back on the person | no (only if the campaign calls through CallHub) | `CALLHUB_API_KEY`, `CALLHUB_API_BASE` |
| [Connect anything](#connect-anything) | any other tool (Zapier, Make, a Slack channel, the campaign's own): people in with a website key, a ladder step out to a web address | no | none (a website key in; a ladder step out) |

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

## Calendars

No keys and no accounts: calendar files and links are plain `.ics` that
Google, Outlook and Apple read themselves. Google refreshes a calendar link
every 8–24 hours (it can't be hurried, and it ignores the file's refresh
hint) and adds such links only on a computer — on a phone the app offers to
email the link. Google fetches from its own servers, so the link must be
reachable from the internet (staging and production are). Links are built
from `STARBASE_PUBLIC_URL`.

## Email — Resend or SendGrid

One email sender per deployment, behind one small layer (`server/lib/mail`:
plain HTTPS, no SDK, a file per sender). [Resend](https://resend.com) is the
default and the one base.win was built on;
[SendGrid](https://sendgrid.com) is there for a campaign that already pays
for it. `MAIL_PROVIDER` names one (`resend` or `sendgrid`); unset, base.win
uses whichever has its key, Resend first — so a deployment with only
`RESEND_API_KEY` sends exactly as it always has. A sender that is named but
not set up is never quietly swapped for the other one.

**From addresses.** A newsletter, an email to a list or a press release may
go from another address than MAIL_FROM — any address at MAIL_FROM's own
domain (Settings → Services → Email → *From addresses*; managers add them,
the desk picks one on a send). Resend and SendGrid verify the domain, not
each address, so nothing more is set up at the sender; an address at any
other domain is refused before it is saved (a secondary site's domain is a
later step). The tracked links, the open pixel and every unsubscribe link
stay on the main site's address (`STARBASE_PUBLIC_URL`). System mail —
invites, shift notices, receipts, two-step, ladders — always goes from
MAIL_FROM.

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
  person who unsubscribed in Mailchimp is never put back. An audience that
  insists on a field of its own for every member (a postal code, a last
  name) still takes them: Mailchimp is asked to accept a member without it
  (`skip_merge_validation`), and nothing is made up to fill it. Then the tag
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
  since they left there (ticked the newsletter box on the website base.win
  serves, or used their own link from an email): a newer yes of their own
  is not undone by an older no. An address the team typed in or imported,
  or one another website's server sent in, comes without the words they
  saw: it is not their yes here, and does not count. An address
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
  unsubscribed in Mailchimp — only if Mailchimp has them as subscribed. Each
  new no is told, whatever older one is on the person's record (a no from
  the address they had before, a tag the desk has since lifted), and so is
  the new address of someone already tagged. A change that says nothing new
  about email (another tag beside it, a phone number) tells Mailchimp
  nothing: someone who has since said yes in Mailchimp itself is not taken
  off there by an edit here. An
  address Mailchimp doesn't have is never added to say no for it. One
  address Mailchimp won't change never holds up the others: they are told,
  and Settings → Services says how many are still waiting, in Mailchimp's
  own words for why. **base.win never moves anyone in Mailchimp to
  subscribed.**
- **The webhook is only a hint.** Whatever a delivery says, base.win then
  reads that member from Mailchimp itself and acts on the answer, so a forged
  call can do nothing but cause one read, about an address already on file.
  Its address ends in 32 characters made from the API key (never shown here;
  Connect gives it to Mailchimp), and when `MAILCHIMP_WEBHOOK_SECRET` is set
  each delivery must also carry Mailchimp's signature.

**The first pull asks first.** The first pull from an audience turns off,
here, everyone on file who ever unsubscribed in it — that is the point — and
the desk cannot put them back; only they can. So it never runs by itself:
until a person says yes for that audience, Connect, **Pull now**, the
nightly pull and **Send to Mailchimp** only count it (a send counts afresh
each time), and ask whenever the count finds someone — *Audience ‘…’ ·
1,240 people here unsubscribed there · 85 dead addresses. Counted 3:42
p.m.*, with **Turn their email off here** and **Not now**. It counts people,
not addresses: two records sharing one address are two. None of them is
turned off, and no list is sent, until someone says yes (a manager on
Settings → Services, or whoever sends a list); the yes is on the event log
with what they were shown, and it is for those numbers: a yes to a count
that has changed since is refused (look again), and the first pull after
the yes — one that began after it — counts again: if it would turn off
more (the supporter file came in meanwhile), it turns off nobody and asks
again. *Not now* changes nothing. When a count finds nobody on file to turn
off there is nothing to ask: a list goes, turning nobody off — and nothing
opens, so the first count that does find someone (the file came in after
Connect) still asks. Another audience (`MAILCHIMP_AUDIENCE_ID` changed)
asks again. What waits for the yes is the past: someone who unsubscribes in
Mailchimp, or whose address dies there, after the audience was first
counted is turned off here yes or no — that no is new — at once by the
webhook, or by the next pull (the nightly one, Pull now, a sync's) if the
webhook never arrives; the line under the buttons says so (*Last pulled
2:17 a.m. · 1 unsubscribed*). Once the first pull after the yes is done,
pulls run by themselves.

Set it up:

1. In Mailchimp, create an API key (today: your profile → **Account &
   billing** → **Extras** → **API keys**). The whole key, ending included
   (`…-us19`: that is the server the account lives on).
2. Set `MAILCHIMP_API_KEY` to it. An account with more than one audience
   also needs `MAILCHIMP_AUDIENCE_ID`: **Check** names each audience with
   its id so you can pick. Until then a list's **Send to Mailchimp** says
   a manager has to choose one, without naming the setting.
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
5. **Check** again: *… · unsubscribes come back here*. Then answer the
   question under the buttons — is that the audience the campaign's emails
   really go to? — with **Turn their email off here**.

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
thing it sent didn't match the secret. The line under the buttons says when
the last pull was and what it found (or that it stopped, in Mailchimp's
words), and how many of base.win's unsubscribes Mailchimp has not been told
yet, with what Mailchimp last said about one of them (Pull now sends them
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
the documentation itself could not be opened while this was written. Two
things here come from that client library alone (`@mailchimp/mailchimp_marketing`
3.0.80, read, not run): a tag's members are listed without the unsubscribed
and the cleaned unless asked (base.win asks, so someone who left is still
found and taken out of the tag), and `skip_merge_validation` lets a member
in without a field the audience usually requires. Not confirmed there:

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
- that someone unsubscribed in Mailchimp can be put in a tag (base.win only
  tries for a person who said yes here since; refused, they are counted
  among those *Mailchimp wouldn’t take*);
- that Mailchimp reads an `Idempotency-Key` (one is sent with every write;
  each write is also safe to repeat by its nature);
- that a member's `last_changed` is when they left or their address died
  (base.win reads it so: until someone says yes to the first pull, a no
  dated after the audience was first counted is taken in without asking —
  and an edit to that member in Mailchimp since, an import that updates
  them say, would make an older no look new);
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
A call is never placed through the campaign's number to someone tagged
`do-not-contact` or `do-not-call`.

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
pin, and places a whole list in the background — started by an import that
leaves addresses without a pin, or by hand (*Place on map*).

| `GEOCODER` | Service | Key |
|---|---|---|
| `bc` (default) | [BC Address Geocoder](https://www2.gov.bc.ca/gov/content/data/geographic-data-services/location-services/geocoder) — the B.C. government's, built for B.C. civic addresses | none; `BC_GEOCODER_KEY` (from the BC API gateway) for higher limits |
| `nominatim` | OpenStreetMap's Nominatim — light use only | none |
| `off` | no lookups; pins by hand | — |

**A name for a point** (a shift's place picked on the map,
`server/ext/schedule`): in B.C., and unless `GEOCODER=off`, the BC Address
Geocoder is asked for the nearest intersection within 150 m ("King George
Blvd & 88 Ave"), then the nearest civic address within 100 m ("near 8850
King George Blvd") — `/intersections/nearest` and `/sites/nearest`, with
`BC_GEOCODER_KEY` when set, for at most 60 points a minute, each call given
up on after 4 seconds. Slow, down or an answer that isn't a corner or a
door: the place is named by the nearest door on file (asked by the desk;
a volunteer granted Shifts gets the next rule), else by its
coordinates — the service is never asked inside a write, and no failure
of it stops a save. These two calls have not been tried against the live
service yet (it couldn't be reached from where they were built): if names
come back as coordinates, that is why.

**Google no longer places pins.** Google's terms let its geocodes be kept
30 days only, not shared between users and not drawn on another map;
base.win's pins are kept, shared, on the event log and drawn on the free
map. `GEOCODER=google` now places with the B.C. service and
`GEOCODER_FALLBACK=google` is ignored (each said once in the log and on
Settings → Services *Map pins*: take them away in Render). Pins placed by
Google before this can't be told apart (nothing recorded the provider).

**Google's address suggestions (Google Places)**, only when turned on:

| `ADDRESS_SUGGEST` | Who suggests |
|---|---|
| unset (default) | the suggester `GEOCODER` names (B.C.); **Google is never asked**, with or without a key |
| `google` | Google Places Autocomplete (New), through the server, then the B.C. service when Google is paused, busy, past today's ceiling or offers no door |
| `bc`, `nominatim` | that service, never Google |
| `off` | no outside service (the doors on file still come) |

Off by default because the words a person picks are saved as the record
(kept, shared, on the event log), and whether Google's terms allow that is
for counsel or Google to confirm in writing first (GOING-LIVE.md §5, Recipe
B). Also needed: Google's logo, unaltered, at
`web/public/google/google-maps-logo.svg` — without it in the build Google's
rows never show, and Services says *Google’s logo file is missing*. With
`GEOCODER=off`, Google is asked only if `ADDRESS_SUGGEST=google` is set, and
nothing falls back to B.C.

A pick (`GET /api/address/place`) asks Google for the address words only
(Place Details with `addressComponents,formattedAddress`, never its
location), which ends Google's session, then places it with the B.C.
service; Google's pin never goes on the map. Google and B.C. are asked
together, within 4 seconds for suggestions and for a pick. Typed addresses
go to Google from the server; the browser never sees the key.

| Setting | Default | Notes |
|---|---|---|
| `GOOGLE_PLACES_DAILY_MAX` | `300` | Google asks a day (autocomplete or details), the campaign's day; then the B.C. service until midnight. Kept in the database across restarts |
| `GOOGLE_PLACES_PER_PERSON` | `50` | Google asks a person a day; then that person's box gets B.C.'s rows |
| `GOOGLE_PLACES_URL` | Google's | a stand-in for tests only |

A Google key: Google Cloud → **APIs & Services** → enable the **Map Tiles
API** and **Places API (New)** → **Credentials** → an API key with **API
restrictions** to those APIs and **Application restrictions: None**
(GOING-LIVE.md §5, Recipe B). Not a *Websites* key: Google refuses it to a
server. Not an IP restriction on Render: its outgoing addresses are shared
and change, and fixed ones are a paid add-on. It is the server's key; the
browser never sees it.

| Setting | Default | Notes |
|---|---|---|
| `STARBASE_GEO_BOUNDS` | a box around Surrey | `lat,lng\|lat,lng` — suggestions and lookups stay in it |
| `STARBASE_PROVINCE` | `BC` | |
| `GEOCODE_MIN_SCORE` | `75` | BC's match score a pin needs |
| `GEOCODE_ON_SAVE` | on | `off`: no lookup when a person is saved (the background run still places them) |
| `GEOCODE_CONCURRENCY`, `GEOCODE_BACKOFF_MS` | `6`, `30000` | the background run's pace |
| `GEOCODE_RETRY_MS` | `900000` | how long a paused run waits before it tries again by itself (doubling, up to six hours) |
| `BC_GEOCODER_URL` | the official service | a self-hosted mirror |

**Check:** Services → Map pins asks for a few addresses in the campaign's
box (one ask every 30 seconds at most); a busy or silent B.C. service is
said in plain words. Services → Address suggestions (Google Places) asks
Google once for "100" whenever a key is set, even while suggestions are off,
so the key can be tested first; when Google refuses it says why in plain
words, with *Google said* and the setup step that fixes it. Its row shows
today's asks against the ceiling.

## Map background

Free tiles by default, straight to each phone: CARTO's light map for the
*Clean* look the map opens on (`STARBASE_TILE_CLEAN=off` leaves it out), and
OpenStreetMap's own servers for *Standard*, *Muted* and *Dark*. Neither is
for a large team in election week — OpenStreetMap's servers are run by
volunteers, CARTO's free basemaps are not meant for heavy or commercial use
— and their current terms could not be read from where this was written:
read them before relying on either (GOING-LIVE.md, section 5). When one
stops answering, the map switches to the other once by itself — if the
other answers — and then says *The street map isn’t loading*; with a
provider of the campaign's own there is no second one to switch to. The
service worker keeps both free providers' tiles as they are looked at
(never ahead). Before election week, either:

- **Google Maps:** on whenever `GOOGLE_MAPS_SERVER_KEY` is set (Map Tiles
  API enabled, above); `GOOGLE_MAPS_TILES=off` keeps the free map.
  **Before this goes to staging, tell us Google or the free map for
  canvassing. With a key already set, Google becomes the map and phones
  stop keeping street maps offline.** `GOOGLE_MAPS_TILE_TYPE` roadmap |
  satellite | terrain (the standard look; each person can switch to the
  others under Show → Map — no Muted or Dark over Google's tiles, whose
  imagery may not be altered). base.win fetches them for signed-in phones
  (`/tiles/…`), so the key stays on the server. Google allows no offline use
  of its tiles: they carry Google's own cache header (made private) and the
  service worker doesn't keep them, so with no signal a Google map shows
  the doors on a blank background. `GOOGLE_TILES_DAILY_MAX` (default none)
  stops tiles for the rest of the campaign's day once reached (*503*, the
  phones turn to the free map); Services shows today's tiles.
- **Another provider:** `STARBASE_TILE_PROVIDER=stadia` (Stadia Maps,
  everything filled in; `STARBASE_TILE_KEY` only if it can't be told the
  campaign's web address — the phones see it), or `STARBASE_TILE_URL`
  (`https://…/{z}/{x}/{y}.png`, a key may ride in the query string),
  `STARBASE_TILE_ATTRIBUTION`, `STARBASE_TILE_MAX_ZOOM`.

Google key: as under Address lookup — API restriction to Map Tiles (and
Places API (New)), application restriction **None** (GOING-LIVE.md §5,
Recipe B). Each call to Google has a limit (a session 8 s, a tile 6 s); a
slow answer is *504* for that tile and is not a refusal.
When Google refuses, base.win stops asking it for a minute (30 seconds
after quota) and the tiles answer *503* with *Retry-After*; the phones turn
to CARTO's free map by itself until Google answers (`STARBASE_TILE_CLEAN=off`
leaves that out). The credit line is *Google Maps ·* and Google's own words
for the view (`GET /api/map/credit`, asked with the phones' session, kept an
hour per patch of map).

**Check:** Services → Map background, with Google on, opens a session of
its own and fetches one tile over the campaign's area (one ask every 30
seconds at most). When Google refuses it says what failed in plain words,
*Google said* with Google's own words, and the step of Recipe B that fixes
it. The same live check is on the map, for managers: **Map → Show → Map
check** (or *Why?* when the street map isn't loading) has *Street map
service*, *Map pins* and *Address suggestions* lines (`GET /api/map/check/services`).

While Google is the map or suggests addresses, the map's Show sheet and the
end of **Your profile** say *Maps by Google* (or *Maps and address
suggestions by Google*) with links to Google's Maps terms and privacy policy,
as Google's terms ask.

**Directions** (no key, no cost, nothing to set up): a door card's and a
walk-list door's More, a shift's place and a sign each have a *Directions*
link that opens the phone's Google Maps from where it is (walking to a door,
driving to a sign). base.win never sends anyone's location: the link
carries only the place. Texts, emails and calendar files keep the plain map
link.

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

## Google sign-in and connections

One OAuth client in the campaign's Google Cloud project serves Sign in with
Google and every Google connection (Gmail, Drive, Calendar). Until it is
set, no Google button shows and **Settings → Services → Google** says what
is missing.

| Setting | Default | Notes |
|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | — | Google Cloud → Google Auth Platform → Clients → *Web application*. The secret is shown once: copy it into Render at once (a lost one: add a new secret) |
| `GOOGLE_TOKEN_KEY` | — | 32 or more random characters (`openssl rand -base64 48`), a different one per environment. Seals each person's stored Google connection; sign-in needs none. There is no fallback in the database: unset, connections are refused. Lost, everyone connects again — nothing else is lost. To change it: `new,old`, then drop the old |
| `GOOGLE_ACCOUNTS_BASE`, `GOOGLE_OAUTH_BASE` | Google's | tests only (`server/test/fake-google.js`); ignored in production |

- **The redirect address** is always `<STARBASE_PUBLIC_URL>/api/auth/google/back`
  — Services shows it with a Copy button. Paste it into the client's
  *Authorized redirect URIs*. **Change it in Google first, then change
  `STARBASE_PUBLIC_URL`.** No JavaScript origins are needed.
- **Check** reads Google's discovery document, asks Google's sign-in page
  about the redirect address (nothing is followed), and tries an impossible
  code with the id and secret: *Working* only when all three pass.
- **Audience:** Internal (Workspace accounts only) or External and
  **published** — never left in Testing on production (Testing ends Gmail,
  Drive and Calendar connections every 7 days). Sign-in alone asks only
  `openid email profile`: no Google review.
- Google deletes a client nobody has used for six months: sign in with
  Google on production at least every four months.
- When Google refuses the client (a wrong secret), base.win stops calling
  Google for 60 seconds and Services shows when; when Google doesn't answer,
  30 seconds. A Gmail or Drive outage never stops anyone signing in.
- Disconnecting tells Google (a revoke, in the background) only when the
  person has nothing else connected and nobody else here uses that Google
  account. With `STARBASE_JOBS=off` nothing can tell Google: people remove
  base.win in their Google Account themselves.

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

## Donations taken in another tool

No connection and no key: GiverLever and tools like it were not found to
offer a public API, so their history comes in by file. Export the gifts
from the other tool as a CSV or Excel file — donor, email, amount, date,
how it was paid, and its own gift and receipt numbers if it has them — and
bring it in under **Donations → More → Import donations** (README, *Gifts made
in another tool*). Its column names don't matter; the import shows how it
read them before anything is saved. Imported gifts count toward the year's
limit and the disclosure; base.win makes no receipt for them. New online
gifts are a different matter: point the website's Donate button at
base.win's own form (*Online payments — Stripe*, above) and nothing needs
importing.

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

## Connect anything

For a tool base.win has no section for — Zapier, Make, a Slack channel, the
campaign's own script — there is one way in and one way out. Neither needs a
setting on the server.

**In — the website's API.** Anything that can make an HTTPS call with a key
can send a person in: `POST /in/v1/people`
([above](#the-campaigns-website)), with a website key made for that tool
alone. In Zapier:

1. Action: **Webhooks by Zapier → POST**. URL
   `https://<public address>/in/v1/people`, payload type `json`.
2. Data: `first_name`, `last_name`, `email` (and any other field from the
   table above), each filled from the trigger.
3. Headers: `Authorization` = `Bearer sbk_…`, `Idempotency-Key` = the
   trigger's own id, so a retry is never a second person.

Make's *HTTP → Make a request* takes the same three things.

**Out — a ladder's *Send to a web address* step.** Outreach → Ladders → a
ladder → *Other steps* → **+ Send to a web address** (Settings → Services →
*Going out* leads there too): the address the other
tool gave (Zapier's *Webhooks by Zapier → Catch Hook*, Make's *Custom
webhook*, a Slack *incoming webhook*) and a short label (*Zapier*). Ladders
already start on everything — joined the newsletter, gave, got a tag,
booked a shift, signed on the website — and whoever reaches the step is
sent there, once, as one small JSON message:

```json
{
  "id": "ladder-5f0c…-1",
  "event": "tag",
  "ladder": "Welcome new signers",
  "step": "Zapier",
  "at": "2026-11-10T20:00:00.000Z",
  "campaign": "Imagine Surrey",
  "text": "Welcome new signers: Asha Example — Got a tag · signed",
  "person": {
    "id": "…", "first_name": "Asha", "last_name": "Example",
    "email": "asha@example.org", "phone": "+16045550142",
    "postal": "V3T 1V8", "tags": ["signed"]
  }
}
```

- `event` is what started the ladder for them: `newsletter`, `donation`
  (their first gift), `gift`, `tag`, `rating`, `web`, `shift_booked`,
  `shift_attended`, `shift_no_show`, `member` or `survey`. `step` is the
  label. `text` says it in one line: what a chat tool posts (a Slack
  incoming webhook posts its `text`); a name's `<` and `>` are left out of
  it, so nothing typed into a form posts a link or an @channel there.
- **What it never carries:** a rating, a note, an amount, a street address,
  or a tag that gives money away (a ladder that starts on one says only
  *Got a tag* in `text`). `email` is `null` unless a ladder email could go
  to them (on the newsletter list, not unsubscribed, not do-not-email);
  `phone` is `null` unless a ladder text could (a number that hasn't
  replied STOP or asked to stop, not do-not-text, no "no" to texts on the
  website). About someone marked do-not-contact nothing is sent at all —
  their log says *Skipped — do not contact*, and their row on the ladder
  *not sent to Zapier (do not contact)*.
- **Signed.** `Base-Signature: t=<seconds>,v1=<hex>` is the HMAC-SHA256 of
  `<t>.<the body's exact bytes>` with the campaign's signing secret — the
  scheme Stripe signs with. The secret is under the step's *More details →
  Show secret* (`sbw_…`; each look is on the event log). It is made from the
  server's own secret (`SITE_SECRET`, or the one base.win keeps), the
  campaign and a number the campaign counts up — never stored, the same
  every time. A receiver that checks should also refuse a `t` more than
  five minutes old. Zapier, Make and Slack don't check a signature by
  themselves: there the address itself is the key, so treat it as one.
- **A new secret.** When someone who has seen it leaves, or it was pasted
  somewhere: *Show secret → Make a new secret → Yes*. The one before stops
  signing at once, for this campaign only (on the event log, by who and
  when); every message from then on, a later try of an earlier one too, is
  signed with the new one — give it to each tool that checks. Don't change
  `SITE_SECRET` for this: that changes the secret too, but it also breaks
  the unsubscribe and email-preference links in every email already sent.
- **A test first.** *More details → Send a test* sends the address in the
  step — as it is typed, saved or not — one message of the same shape,
  signed the same way, about a made-up person (Sam Example,
  `sam@example.org`), with `"test": true` and `text` starting *Test ·*, and
  says what the address answered in place (*Sent · 200*, *Failed · 500*).
  A Zapier *Catch Hook* asks for one request before its fields can be
  used: this is it. Nobody is put on the ladder and nothing goes on
  anyone's log; the event log notes that a test went, and to which site.
- **Once.** `Idempotency-Key: ladder-<run>-<step>` (the body's `id`) is the
  same on every try for one person at one step.
- **Tries.** The address has 5 seconds to answer 2xx, and is handed one
  message at a time; while it takes its time, everything else base.win
  sends (other addresses, emails, receipts) goes on — when 25 are already
  waiting for it, the next waits its turn back in the queue a few seconds
  later, with no try counted. Any other answer
  but a redirect, or none, is tried again after a minute, then after five
  more — three in all — and then the person's log on the ladder says
  *Zapier: Failed · 500 after 3 tries* and the ladder carries on: a
  failing address never holds anyone up. *Zapier: Sent · 200* is the
  address's own answer. If the server stopped between the send and noting
  the answer, it never sends again by itself; the log says *Not sure it
  went*. Someone taken off the ladder (or reaching its goal) while the
  address is being called stays *Taken off*: what the address answered is
  noted after, and nothing is tried again.
- **A redirect** (any 3xx) is never followed and never tried again — the
  same one would come back: *Zapier: Answered with a redirect (302) — not
  followed*. Give the step the address it points to. (A tool that takes
  the message and then redirects, as a Google Apps Script web app does,
  has it once; the log line still says so.)
- **An address that stops answering** — three calls in a row with no
  answer — is left alone for five minutes, so nobody waits out its
  silence. Whoever reaches the step meanwhile isn't called and loses none
  of their three tries: their log says *Zapier: Waiting — the address
  isn't answering*, and their try waits for the five minutes to end, when
  the first call finds out for everyone waiting (no answer: five more).
  Half an hour after reaching the step it ends there — *Failed · the
  address isn't answering* — and the ladder carries on. Any answer, a 500
  too, clears it.
- **Where it may point.** `https://` only, no name and password in it, and
  never inside a private network (the server's own, a cloud's metadata
  address): refused when the step is saved and again, after the name is
  looked up, at every send — the call goes to the very address that was
  checked.
- **Who.** Only the desk adds the step, changes a ladder that has one,
  sends a test, or sees or changes the secret — never a volunteer, even
  one given Outreach. The address is kept with the ladder (and so in the
  campaign's full export); the event log keeps only the site it goes to
  (`https://hooks.zapier.com/…`), and a person's log on the ladder only
  the label and the answer.

Checking the signature, in Node (`raw` is the body exactly as received):

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
const part = (k) => header.split(',').find((p) => p.startsWith(`${k}=`))?.slice(k.length + 1) || '';
const want = createHmac('sha256', secret).update(`${part('t')}.`).update(raw).digest('hex');
const ok = part('v1').length === want.length && timingSafeEqual(Buffer.from(part('v1')), Buffer.from(want))
  && Math.abs(Date.now() / 1000 - Number(part('t'))) <= 300;
```

| Setting | | Notes |
|---|---|---|
| `LADDER_WEBHOOK_API_BASE` | — | tests only: a stand-in that receives every step's message (`server/test/fake-receiver.js`) |

Not built, on purpose: a Zapier app, webhooks for every event, or a way out
for anything but a ladder step. A ladder with one step is the way to send
"someone signed" or "someone gave" to another tool.
