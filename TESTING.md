# Testing base.win

Everything below works from a fresh install. Start with **Run it on your
computer** — five minutes, no accounts needed — then deploy when you want your
team on it.

---

## 1 · Run it on your computer

Needs [Node.js 22](https://nodejs.org).

```sh
git clone https://github.com/trevorloke/starbase.git
cd starbase
npm install
npm run build
npm start                 # → http://localhost:3200
```

1. Open **http://localhost:3200/signup** and set up base.win for Imagine
   Surrey: your name, email and password. You become its manager (the
   workspace is *Imagine Surrey*, **BC — Municipal**). Setup works once:
   after that `/signup` says it's already set up, and everyone else joins
   by invite from **Settings → Members**. (To start over, delete `data/`.)
2. On **Today**, press **Load sample data**: 52 Surrey voters across Newton,
   Whalley, Guildford, Fleetwood, Cloverdale, and South Surrey — with ratings,
   signs, donors, a shift, and a Newton turf.
   **Clear sample data** removes it all later (your own records stay).

Your data lives in `data/`. Stop with Ctrl-C; it's still there next
time. Delete the folder to start over.

> Testing on your phone on the same Wi-Fi: open `http://<your-computer's-IP>:3200`.
> Location ("Locate me") and "Add to Home Screen" need **https** — use the
> deployed version for those.

---

## 2 · Deploy for the team (Render)

The repo's `render.yaml` is a Blueprint for one client's two environments
(GOING-LIVE.md): **starbase-staging** from `main` and **starbase** from
`production`, each with its own managed Postgres database (backups
included). Every setting below, and where its key comes from:
INTEGRATIONS.md.

1. Render → **New → Blueprint** → pick this repo (`main` branch)
   → it creates `starbase-staging` + `starbase-staging-db` and `starbase` +
   `starbase-db` (paid plans — check Render’s current pricing).
2. In the `starbase` service → **Environment**, set:

| Variable | What for | Needed to test? |
|---|---|---|
| `STARBASE_PUBLIC_URL` | your address, e.g. `https://starbase.imaginesurrey.ca` — used in invite and unsubscribe links | **yes** |
| `STARBASE_ORG_NAME`, `STARBASE_JURISDICTION`, `STARBASE_TZ`, `STARBASE_CITY`, `STARBASE_SLATES` | the campaign this deployment runs for (README → *One deployment per client*) | set them before the first sign-in |
| `STARBASE_ENV` | `staging` on the test environment: a *Staging* badge on every screen | **yes**, on staging |
| `RESEND_API_KEY`, `MAIL_FROM` | real email (invites, newsletters, press, shift alerts) | optional — without it, sends are saved as *queued* and invite links are shown to copy |
| `RESEND_WEBHOOK_SECRET` | bounces, spam complaints and "delivered" back from Resend (INTEGRATIONS.md; SendGrid: `MAIL_PROVIDER`, `SENDGRID_API_KEY`, `SENDGRID_WEBHOOK_PUBLIC_KEY`) | optional — without it a send says *sent* and a dead address is tried again next time |
| `MAILCHIMP_API_KEY` | *Send to Mailchimp* on a list, unsubscribes kept in step both ways (INTEGRATIONS.md; `MAILCHIMP_AUDIENCE_ID` for an account with several audiences, `MAILCHIMP_WEBHOOK_SECRET` to check its webhook's signature) | optional — without it the button is not there |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | SMS shift alerts; texting and calling from the app through the campaign's number | optional — without it, Calls opens the phone's own Messages and dialer |
| `GOOGLE_MAPS_SERVER_KEY` | Google geocoding (`GEOCODER=google` or `GEOCODER_FALLBACK=google`) and Google Maps tiles (`GOOGLE_MAPS_TILES=1`) | optional — the free BC geocoder and OpenStreetMap tiles work without it |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_TOKEN_KEY` | Sign in with Google, and the one Google connection Gmail, Drive and Calendar use (INTEGRATIONS.md); in tests a stand-in Google (`server/test/fake-google.js`, pointed at with `GOOGLE_ACCOUNTS_BASE` and `GOOGLE_OAUTH_BASE`) — never real Google | optional — without them no Google button shows, and passwords work as always |
| `STARBASE_TWO_STEP_KEY` | seals everyone's two-step sign-in key (INTEGRATIONS.md) | optional to test — without it a key kept in the database is used, and Settings → Services says so |

The whole order of things, from deploy to the public link, is in
[GOING-LIVE.md](GOING-LIVE.md).

For Twilio, set the number's incoming messages webhook to
`https://<your address>/api/public/twilio/sms` (HTTP POST). Calls through the
campaign also need `STARBASE_PUBLIC_URL`; `TWILIO_VOICE=off` keeps texting
and turns calling off.

Any Docker host works too: `docker build -t starbase .` then run with
either `DATABASE_URL=postgres://…` or a volume at `/data`.

---

## 3 · What to test, by role

Invite real people from **Settings → Members** (tap your initials, top right — managers
only). Each invite is a one-time link — emailed if email is connected,
otherwise copy and text it.

Every screen has one yellow button: that's the main job. Everything else is
one tap away under **More**.

### Manager (you)
- **Two apps.** Sign in at `/login` and you land in the **admin** at
  `/admin/` (the header reads *base.win*, your campaign under it): every screen below. Your
  account menu has *Field app ↗* — open it and you see exactly what a
  volunteer sees (Today · Map · Calls · Shifts · ImagineU), with *Admin ↗*
  to come back. A volunteer who opens `/admin/` is told it isn't theirs.
- **Today → Dashboard → In the field** — tap a dot: who, the outcome, who
  logged it and when, with *Profile* and *On the map* links; tap a person's
  initials for their day and *Only their contacts*; tap a turf for its name.
- **Today → Dashboard** — with the sample loaded: the figures (contacts,
  doors, calls & texts, people reached, support, canvassers, out now), each
  with today's and all-time numbers; *Today · 7 days · 30 days · All time*
  changes everything at once. **Interactions over time**: hover a day for
  its breakdown, *Grouped* lays the outcomes side by side, *Table* shows the
  numbers. **In the field**: tap a volunteer in the list — the map goes to
  them, their contacts stay, their trail shows (today); *out now* and a
  green ring mean they're sharing their location this minute. **By team**
  is each team's contacts (make teams under *Settings → Teams* to see it fill).
  Have a volunteer turn on *Share my location while I'm out* on their map
  (below) and watch them appear within a minute.
- **Today** — three big numbers (doors this week · support · raised); tap
  *Support* for the breakdown by candidate. **Needs you** lists what's waiting:
  gifts over the limit, shifts short of people,
  signs to put up.
- **Lists** (Today → More → Lists, or People → *Save as a list* once a
  filter is on) — every list by name at once, then each one's numbers as
  they're counted (*19 people · 17 can be reached*) and **Email · Text ·
  Call · Walk**, each with how many it reaches. A saved filter counts who
  matches as you pick (how many can be emailed, texted, called), with more
  under *More rules*: gave, membership, shifts, a survey answer, another
  list, added since; a hand-picked list takes people by name. A list's
  page has its five numbers, *Email · Text · Call · Walk this list*,
  *Download CSV* and *Save these people as they are now* (a hand-picked
  copy of who is on it this moment).
- **Outreach** is two modules, **Email** and **Texting** (old links —
  /outreach/newsletter, /eblast, /press, /texts — land in them).
- **Outreach → Email → Write an email** — *To*: the newsletter's
  subscribers, or pick a list; write, Send: everyone with an address who
  may be emailed; the footer's *Unsubscribe* tags that address
  do-not-email. **Outreach → Texting** — the Inbox, phone banks, texting
  one by one and texting settings, one tap each; *Write a text*: choose a
  list, write a text that names the campaign (the counter shows
  the 1000-character limit with "Reply STOP to opt out" counted), Send: one
  text each through the campaign number; at night it waits and says when
  texting opens; replies land in the Inbox.
- **Reports** (Today → More → Reports) — the campaign in numbers, *CSV* on
  every table, and the exports: any table as a spreadsheet.
- **Path to win** (Today → More → Path to win) — tap *Set the win number*:
  election day (unless *GOTV & voting days* has one), then each race —
  *I know the votes needed*, or *Work it out* from eligible voters, turnout %
  and share needed % — and, if you like, how many of your supporters will
  vote; the line under each race shows votes → supporters as you type. Save:
  each race says found of needed, still to find, needed a week beside found
  a week (the last 4 weeks) and *Behind: N more supporters a week*. *Week by
  week* draws each race's line over the new supporters (*Table* for the
  numbers). *Where to work next* ranks the turfs (map and list; *How the
  score works* says why) — tap one and the map opens on it. Staff see it all
  without *Change the numbers*; volunteers never see it.
- **Outreach → Email → Write an email** (to the subscribers) — the message takes Markdown: tap **B**,
  **H**, **• List**, **Link**, **Picture** (a photo goes in from your phone)
  then
  **Preview** to see the email as it will look. **Attach a file** takes a
  PDF or a picture (5 MB each, five at most) and lists it by name with ✕;
  **Send me a test** emails you a copy with everything in it and nothing
  tracked. Without email connected, a newsletter is
  *Saved — not sent*; connect email (Resend) and tap *Send now*. A send
  that partly fails says *Sent to 1 of 2 — 1 failed* with *Try again*. A
  big list says *Sending · 40 of 340* and counts up while it goes out in the
  background (door knocks aren't kept waiting). If the server stops
  mid-send, the send is still listed and the rest go out by themselves
  within a few minutes of the restart; the few it isn't sure about say *We
  don't know if 3 got it*, and *Try again* sends those with the same keys
  (Resend drops a repeat).
- **Two subject lines** (50+ subscribers) — Write newsletter → *Try two
  subject lines*: A and B each go to a small group; after the wait the better
  one (by opens, or by clicks when the message has a link) goes to everyone
  else by itself, and *Last sent* shows the whole list's *All 60: opened ·
  clicked*. While writing, the plan sits under the settings (*A to 12, B to
  12, winner to 36 after 1 hour*). A tie sends A and
  says *Tie — sent A*. Opens run high (Apple Mail opens by itself); clicks
  from mail scanners aren't counted.
- **Outreach → Ladders** (automatic emails, texts & follow-ups) — email steps go
  only to people who said yes to email (the newsletter); everyone else shows
  *Email skipped — didn't ask for email*.
  *+ First name* / *+ Campaign* fill in. The email's unsubscribe link asks
  first; once someone unsubscribes, **Email → More → Subscribers** can't
  add them back — only they can, by signing up again.
  *Starts when* now also takes what someone did on the website (a kind —
  *Signed a petition* — or one petition), *Booked a shift*, *Came to a
  shift*, *Didn't show up for a shift*, *Gave (any gift)*, *Became a member*
  and *Answered a survey*. *Add a goal* (*Came to a shift*, *Gave*, *Became a
  member*, *Voted*): book someone on a "Booked a shift" ladder, check them in
  on the shift — they're off it at once, *Reached the goal*. *+ Text*: it
  must name the campaign (*+ Campaign*), goes only inside the texting hours
  (*Waiting for texting hours*), never to anyone who replied STOP or asked
  to stop in a reply (*No thanks, stop* — skipped, *asked to stop in a
  reply*, until they text START), and "Reply STOP to opt out" is added;
  replies land in the Inbox.
  *Other steps* → *+ Send to a web address*: an `https://` address another
  tool gave (a Zapier catch hook, a Slack incoming webhook) and a label
  (*Zapier*). `http://` and an address inside a private network
  (`https://192.168.1.20/…`) are refused in the step. *More details* →
  *Send a test* sends the address one message about a made-up person (Sam
  Example) and says what it answered, in place (*Sent · 200*); *Show
  secret* is the campaign's signing secret, and *Make a new secret* →
  *Yes* replaces it at once. Tag someone on a "Got a tag" ladder with the
  step: the other tool gets one message (their email only if they said
  yes to email), and their log on the ladder says *Zapier: Sent · 200* —
  or, with the address down, *Didn't go (500) — trying again* (after a
  minute, then five), then *Failed · 500 after 3 tries*, and the ladder
  carries on. Someone marked do-not-contact is
  never sent: their row says *not sent to Zapier (do not contact)*. An
  address that answers with a redirect is handed the message once
  (*Answered with a redirect (302) — not followed*); one that gives no
  answer three times running is left alone for five minutes, and whoever
  reaches the step meanwhile waits for them to end with no try used up
  (*Waiting — the web address isn't answering*). Take someone off while
  the address is being called: their row still says *Taken off*
  (INTEGRATIONS.md, *Connect anything*).
  Settings → Services → *Going out* leads here.
- **Follow-ups (speed to lead)** — every new volunteer (the website's form,
  the door's or Mainstreeting's *Wants to volunteer*, the membership form's
  *I'd like to volunteer*), every website message and every RSVP from
  someone new goes to one named organizer: whoever brought them in or knows
  them (My people), else someone on the turf their pin is in (a captain
  first), else a manager. It's at the top of that organizer's Today —
  *Follow up · 1*, what they did, *23 h left* (red once it's overdue). Tap
  it: what they said, *Call* / *Text*, and how it went — *Talked*, a rating,
  *Left a message*, *No answer*. Logging it closes it. Ladders → Follow-ups
  shows every open one by organizer (*Who has them*), the time to first
  contact over 30 days, and *Hand to…* someone else.
- **Email & texting** (the *Connect* links on Shifts, Receipts and Ladders,
  or Today → More) — whether email and texting are connected, and the
  Imagine Surrey website address the public pages link back to.
- **Calendars** — a shift's page, GOTV's voting days and Donations' filing
  dates have a quiet *Add to calendar*: Google, Outlook, or *Apple & others*
  (a file link that needs no sign-in; with no signal the choices say *Needs
  signal*). After *Count me in* it sits under *You’re on this shift*. Your
  profile → *Your shifts in your calendar* → *Get my calendar link*: an
  iPhone shows *Add to iPhone or Mac · Email me the link · Copy link*, an
  Android phone *Email me the link · Copy link*, a computer *Add to Google ·
  Copy link* (a Mac also *Add to iPhone or Mac*); *More* → *Make a new
  link* ends the old one. Shifts → *Put my shifts in my calendar* opens it.
  A shift email (Notify, the week's notice, the evening-before reminder)
  arrives with a calendar file of that person's own shifts and the line
  *Add to your calendar: open the attached file.*; the text is unchanged.
  On the website, after a sign-up (with or without JavaScript): *Add it to
  your calendar: Google · Outlook · Apple & others*; the Events list links *Get our events in your
  calendar* (`<site>/events.ics`). Browser: `e2e-calendar.mjs` (it starts
  its own server and a stand-in email sender: `PORT=5160 node
  e2e-calendar.mjs` after the web build). Server tests:
  `server/test/ics.test.js` (the file format, UTC times, the B.C. clock —
  run it under any Node and TZ, the digest it prints is the same),
  `server/test/calendar.test.js` (a person's calendar link, Make a new link,
  Email me the link, the one-item files, the website's events) and
  `server/test/schedule-tell.test.js` (the emails' files).
- **ImagineU** (the tab) → *Edit* → *+ Add a course* (*Canvassing 101*),
  then *+ Add a module*: words to open with, then under *More materials*
  *+ Video* (paste a YouTube link), *+ Document* (upload a PDF), *+ Audio*;
  ↑ ↓ to reorder. The module's row says what it holds (*Note · Video ·
  Document*). Set *Who sees it* to *Public* and open the link ImagineU
  shows — a page anyone can open, its materials too. *Done editing*; open
  the module, *Mark this module done*: the course reads *1 of N modules
  done*; *Progress* shows each member's count and, tapped, which modules. A
  volunteer sees the courses, not *Edit*.
- **Phone banks** (People → More → Phone banks, or Today → More — in the admin) → *New
  phone bank*: a name; *Who to call* **From a list** (a list's *Call* opens
  it picked: *14 of 19 on it can be called*) or **Pick people** (*Undecided*;
  the count updates as you filter); a script, *Make the bank*. A bank from
  a list says so: take someone off the list and the bank says *1 left the
  list or can't be called now*; **Add who joined since** brings newcomers
  in. Calls on the list itself (*call them yourself*) goes on past its
  first 300. On the bank: *Hand out* three
  numbers to a volunteer (or a team — split evenly), watch *Callers* fill;
  *Take back* unfinished ones; *Close*. While the bank is open, deleting
  its list is refused (*The phone bank “…” calls this list — close it
  first*). On the volunteer's phone, Calls
  says *Your call lists 1*; tapping through opens the bank on the Calls
  card with the script; each call they log crosses a number off, *Skip*
  (on the bank page) crosses one off without a call.
- **Settings → Members** — invite a volunteer and a staff member; change a role; remove one (their phone is signed out at once).
- **Settings → Teams** — make a team, put two people on it, name a lead; on the map, add the whole team to a turf.
- **Passes** (Turfs → *Pass: none ›*) — **Start a pass**: a name, *What
  for* (Persuasion · Get out the vote · Lit drop · Find out who's who), *Who*
  (All doors · Not rated yet · Undecided or not rated · Yes (1–2) · Everyone
  but opposed), *List to walk* (a list's *Walk* opens the form with it
  picked: only doors with someone on it are walked) and *Tries* (2). Every
  turf's *doors left* changes the moment
  it starts: doors knocked before are back on the lists, doors outside the
  universe leave them. The pass's card counts *doors knocked · talked · yes*
  as the team works; **End this pass** (asks in place) puts every knocked
  door back to done, and starting another pass ends the open one.
- **Settings → Permissions** — untick Donations for Staff and watch a staffer's Donations tab go; tick Outreach for one volunteer and watch them get it. Under **Volunteers' map** pick *Only their turfs*: a volunteer's map now shows just the doors inside the turfs they walk (no turf: *No turf yet*), and *Every door* brings the rest back.
- **Two-step sign-in** — account menu → **Your profile** → *Turn on
  two-step sign-in*: scan the QR code with an authenticator app (Google
  Authenticator, 1Password, Authy…), type its code, keep the ten recovery
  codes (*Copy the codes* or *Download*). Sign out and in: after the
  password it asks for the code; a wrong one is said, the right one opens
  the desk, and a recovery code works once (*9 recovery codes left*).
  **Settings → Members → Require two-step sign-in for desk roles**: a
  staffer's next tap shows the set-up and nothing else until it's on — so
  does a volunteer's once given an area under Permissions; a volunteer with
  no area still signs in with a password. *Reset two-step* on someone's
  row signs them out and clears theirs. Twenty wrong codes in a row (over
  as many sign-ins as it takes) lock the codes from that person's app: the
  sign-in says so, managers get an email and a line on Today, their row
  says *Two-step locked*, and a recovery code signs in and unlocks it.
- **Sign in with Google** (once the Google client is set; INTEGRATIONS.md) —
  *Sign in with Google* sits under *Sign in*. Pressed before linking, it
  says the Google account isn’t linked. Sign in with your password, then
  **Your profile → Google → Link Google account**: Google asks which
  account, and the card says *Linked to …*. Sign out and use the Google
  button: a manager lands on the desk, a volunteer in the field app, and
  with two-step on it asks for the code first. On an invite, tick *Also sign
  in with Google next time* before *Join*. **Settings → Services → Google**:
  the redirect address (*Copy*), *Team can sign in with Google* (off hides
  the button; passwords still work), *Only Google accounts at* a domain
  (your own link must be at it first), and under *More*, *Disconnect every
  Google account*. **Settings → Members** marks who signs in with Google and
  offers *Unlink Google*. `e2e-google-signin.mjs` runs all of this against
  a stand-in Google (it starts its own servers on 5300–5304). It also
  builds a stand-in feature screen with the shared *Connect Google* piece
  on it (`server/test/google-connect-host.jsx`, served at
  `/admin/e2e-google-connect` by the suite's server only) and drives
  Connect, *Connected as … · Disconnect*, *Reconnect* and the paused line,
  the way Gmail, Drive and Calendar will use it.
- **Command bar** — on the desk press **Ctrl+K** (⌘K on a Mac), or *Search*
  under the name: *don* + Enter opens Donations, *gift* opens Log a gift
  with its form, a name or a phone (*604 555 0142*) finds the person; ↑ ↓
  move, Esc closes. A staffer without Donations isn't offered it.
- **Rating scale** (your initials → *Rating scale*) — change the words on 1
  (e.g. *Definitely*; up to 30 letters, a long one wraps on the buttons),
  rename a candidate, **Add** one, move it with ↑ ↓,
  **Take off** one (*Take Locke off the list? Yes · No*). The preview shows
  the buttons as volunteers will see them; **Save**. Locke now sits under
  *Off the list* with how many people have that rating and *Put back*;
  people already rated Locke read *4 · Locke (off the list)* on People,
  profiles and the *Voting for…* filter, and still count on Today. Staff,
  treasurers and volunteers have no Rating scale (typing `/rating-scale`
  lands on Today). Type a new name over a candidate people were rated for:
  the row says *3 people rated McCallum will read Bains — someone new?*;
  **Add them instead** keeps McCallum and adds Bains. A row renamed to
  someone off the list, to a step's words (*Undecided*) or to a name already
  on the list says why under it, and Save refuses it. With 12 on the list
  *Put back* is off (*12 at most on the list — take one off first*). Filter
  People → *Opposed*, add a candidate, rate someone for them, reload: the
  same Opposed link (and the Call list carried from it) still finds them.
- **People → More → Profile fields** → **Add a field**: a name, a type (Text ·
  Yes/No · Pick one · Number · Date), its choices, and *Volunteers can see
  this* (off by default). Tap a field to rename it, add a choice or *Move
  up*; once something is filled in its type can only become Text — a Text
  field's stays Text (the screen says so). A new choice can always be fixed
  or removed with ✕. **Take off** keeps everything filled in (still in *Export all
  data*); *Taken off → Bring back* restores it. The sample adds *Language at
  home*, *Strata council member* and *Union local*.
- **GOTV** (Today → More → *GOTV & voting days*) — set *Election day* to
  today (or add today as an advance-voting day) and **Save**: it reads *On*
  by itself; or switch *On by hand*. Every volunteer's walk list, door card
  and Calls card now has a 48px *Voted ✓*; mark one person yourself from a
  door card. Today opens with the GOTV card (*1 of N supporters have voted ·
  … to go*, *Call who hasn't voted*, *Map: who hasn't voted*); write a GOTV
  script under Scripts → *Get out the vote* and the Script line on a door
  reads *GOTV script*; *Ask the office* offers *Needs a ride to vote*. The
  row on Today reads *GOTV · 1 of N supporters voted* and
  the screen behind it counts by band and by turf (*Walk list* opens the
  turf). Then **People → Import** a file with a *Voted* column (1/0, yes/no
  or a date): it maps to *Voted (1/0 or a date)* and marks the people in it;
  a 0 never un-marks anyone, and the import's line says *adds voted*. Switch
  it off (and *Turn on by itself* off, on a voting day) and the buttons go;
  the marks stay.
- **Shifts → New shift → More → More options → More details → Turfs** (the
  long form) — tap one or more turfs
  (*Anyone who counts themselves in gets these walk lists*), then *Create
  shift*. The shift reads *Walk list: Newton block* (or *Walk lists: …*)
  with *Change turfs*; the list row reads *Saturday canvass · Newton block*
  and the week board shows a small turf chip. Add someone who has no app
  sign-in: their row says *No app sign-in — add them to the turf on the
  map*. A turf the desk gave someone by hand on the Map stays when they
  leave the shift.

- **Addresses that find their place** — Map → **+ Door**: the form opens at
  once; type *13450 104* and pick the door it offers: the address fills in,
  *✓ Pinned on the map*, and the map goes there (tap the map to move the
  pin). Type a full address without picking and **Add door**: it's found
  when it's saved; one nobody knows says so (tap the map instead). With no
  signal, tap the map for the pin. **People → Add person** and **Add a sign**
  take the same box. On a profile, **Edit** (top right) opens the details on
  the name; change one thing and **Save** — only that changes; a new address
  picked moves the pin with it, one typed is found after the save.

- **Email that hears back** (needs `RESEND_WEBHOOK_SECRET` and the webhook
  at Resend) — send a newsletter to a few addresses of your own and one
  that doesn't exist: in a minute or two **Outreach → Email → More → Past
  sends** says *Delivered 3 of 4 · 1 bounced*, **Subscribers** marks that
  address *can't be emailed*, and the next send counts one fewer. Mark one
  as spam from a mailbox whose provider reports it (Resend says Gmail
  doesn't): that address is unsubscribed too. `node e2e-mail.mjs` (PORT,
  SHOTS) runs the *Sending domain* panel, Check and a send's delivery line
  in a browser against a stand-in sender.
- **Mailchimp** (optional — `MAILCHIMP_API_KEY`; INTEGRATIONS.md) —
  Settings → Services: **Check** names the audience and says Mailchimp isn't
  sending unsubscribes here yet; **Connect**, copy the signing secret it
  shows once into `MAILCHIMP_WEBHOOK_SECRET`, and **Check** passes. The row
  then asks before the first pull — *Audience ‘…’ · N people here
  unsubscribed there* — check the audience is the campaign's, and tap
  **Turn their email off here** (*Not now* turns nobody off). On a
  list of your own team's addresses: **Send to Mailchimp** says how many go
  (only the newsletter's subscribers unless you tick *Everyone…*), then
  *In Mailchimp · 3 addresses · tag “base.win: …”* — look for the tag in
  Mailchimp. Unsubscribe one address there: in a moment it is off the
  newsletter here, and **Sync again** takes it out of the tag. Unsubscribe
  another here: Mailchimp has it unsubscribed. It has not been run against
  a real Mailchimp account yet — this is that test. `node e2e-mailchimp.mjs`
  (PORT, SHOTS) runs all of it in a browser against a stand-in Mailchimp.
- **Settings → Services** (managers) — every outside service: what it's
  for, *Set up* / *Not set up* (naming the settings missing) / *Using the
  free default*. **Check** on each makes one real call: Email says whether
  the sender took the key, the domain is verified, it has a DMARC record
  and bounces come back (its *Sending domain* panel lists the DNS records,
  each *In* or *Not found yet*, with **Add domain** and **Check again**);
  Texting whether
  the number is on the Twilio account and its replies come here; Address
  lookup, the map background, the public address and the database answer
  too. *Coming in* lists the address to give Twilio; *Going out* names the
  way out to any other tool (a ladder's *Send to a web address* step) and
  opens Ladders. Staff can't open it.
- **Phone dialer (CallHub)** (optional — `CALLHUB_API_KEY`; INTEGRATIONS.md)
  — Settings → Services: **Check** says the key works but CallHub isn't
  sending results here yet; **Connect**, then **Check** passes. On a list
  of your own team's numbers (tag one *do-not-call* first): **Send to
  CallHub** says how many numbers go and how many are left out, then
  *Sending · 3 of 9*, then *Sent*. In CallHub, call from the phonebook it
  made and save a result: the call is on that person's history, and the
  list says *1 result back*; *What each result counts as* opens the table.
  Turn a row to *Do not call*: it asks first, naming the result; **Yes**
  tags those people, and putting the row back (it asks too) takes the tag
  off again — and, a few seconds later, the numbers off CallHub's `base.win`
  do-not-call list (on a list sent meanwhile, too: *1 list sent since
  follows too*).
  It has not been run against a real CallHub account yet — this is that
  test. `node e2e-callhub.mjs` (PORT, SHOTS) runs all of it in a browser
  against a stand-in CallHub.
- **Website keys** (Settings → Services) — **Make a key**: it's shown once
  to copy. Send a person in with it as the website would (INTEGRATIONS.md
  has a `curl` line): a new person appears, tagged with the source; with
  `"newsletter": true` they're on the list; with `"volunteer": true` a
  *Wants to volunteer* request waits under Today → *Needs you*. Send the
  same again with the same `Idempotency-Key`: still one person. The key's row
  says when it was last used; **Revoke** and the next send is refused (401).

- **The field's cuts** — People → Filter → **More filters**: *Last knocked*
  (Never · not in 7, 14 or 30 days), *Last outcome* (No answer, Left lit,
  Refused…), a *Turf*, *Postal code starts with*. Each narrows the list and
  shows as a chip you can take off; **Save as a list** carries them, and the
  saved list (and a blast or Calls from it) keeps them. Once the website
  has people, *Did on the website* is there too (*Signed a petition*, one
  petition by name, *Offered to volunteer*, *Anything*…) — a volunteer's
  Calls never offers the money forms. Below them, the desk's own: *Gave*
  (this year · before, not this year · never · at least $X in one year),
  *Membership*, *Shifts* (came to or missed one), *Survey answer*, *Lists*
  (on another list or not) and *Added since*. The count is the real
  number, however many; **Save these people as they are now**, beside
  *Save as a list*, keeps exactly who matches this moment.

- **Scripts** — Today → More → **Scripts**: write what to say at the door
  and on the phone; **+ First name**, **+ Your name**, **+ Campaign** fill in
  for whoever's in front of the canvasser, and the preview reads it for a
  made-up voter. **Save**; empty takes it away. A volunteer sees **Script**
  above the rating buttons on the walk list, the door card and Calls (with
  no signal too).

- **Phone banks: call backs** — Phone banks → **New phone bank**: *No
  answer: call again* (after 1–24 hours, or Never) *up to* 2–5 calls. A
  caller's **No answer** says *back on your list 6:30 p.m.*, the number leaves
  their list until then, and the bank line counts it (*1 to call back*).
  **Call back…** → *In an hour · This evening · Tomorrow morning* does the
  same at that time. The bank's page shows *call back Thu 6:00 p.m. · 1 try*.

- **The website** — open **/site/** (the campaign's own domain once
  `SITE_HOSTS` points there): the first look makes the site from the
  brand's seed (Imagine Surrey's pages as imaginesurrey.ca has them).
  Sign the SkyTrain petition or the newsletter there: the person is in
  People with *Website: petition* and *Signed: …*, matched to whoever is
  already on file by email (or name and phone, or name and postal code),
  and a ticked box puts them on the newsletter list with the words they
  saw. A shift's **Edit** → **Show on the website** lists it on the site's
  events and volunteer openings, where anyone can sign up (room is checked
  when the shift has a limit; a shift with a kind is listed once — an Event
  with the events, any other kind with the openings). Their
  `/preferences` link turns email and texts off or on in base.win itself.
  Server tests: `server/test/site-*.test.js`; in a browser:
  `e2e-site-server.mjs`.

- **Media and From addresses** — Settings → Services → Email → *From
  addresses*: add an address at MAIL_FROM's domain (another domain is
  refused) and make it the press default; a release then goes from it.
  Tag two people `media` and one `influencer` (or add them through
  `media.contact.add`): a release to Media reaches the two, to Both all
  three, never anyone tagged do-not-email or do-not-contact. Its footer
  says "Don’t want press releases? Unsubscribe"; that link takes the
  reporter off the media list only (no do-not-email, still on the
  newsletter) and their History says *Left the media list*. A volunteer
  granted Media sends releases but sees no email or phone. Server tests:
  `server/test/media.test.js` (contacts, sends to each kind, Media without
  Outreach, the press opt-out, the A/B winner and its wait, a merge) and
  `server/test/senders.test.js` (the From list, who picks, Try again and the
  winner keep the From, invites and ladders stay on MAIL_FROM). In a
  browser: `node e2e-media.mjs` (PORT, SHOTS; the stand-in sender on
  PORT+1) — contacts, Write a release, a release's page with an open, Try
  again and Copy links, a volunteer granted Media, and an A/B release in
  its wait ("Waits for the winner", no Try again), and the desk contacts
  table from 1000 to 1440 px wide with long names, outlets and phones (no
  sideways scroll, no word running into the next column); `e2e-mail.mjs` runs
  *From addresses* and Outreach → Email's From line.

- **Candidates** (Settings → Candidates) — a manager adds and invites
  candidates; each joins as a volunteer with a seat; their phone opens on
  Your day (Met someone, their booked shift, their week, Your race); the
  admin, `/api/candidates`, Path to win and the desk's ties stay closed to
  them, with People granted to the Candidates column too. Call time: New
  phone bank → *Who calls* → a candidate (only the desk with Donations);
  their Today leads with *Start call time →*; on `/call-time` a pledge over
  the room is refused in words, a pledge, *No answer* and an answer made
  offline all land, and an offline answer refused as already called drops
  off the *All done* count; the treasurer sees *Pledges from call time*
  under Needs you and *Gift in ✓* once the gift is logged; another
  candidate gets 404; a removed candidate's call time stays closed, with no
  *Reopen*.
  Server tests: `server/test/candidates.test.js` (also `banks.test.js`,
  `admin.test.js` and `twostep-grants.test.js`); in a browser:
  `e2e-candidates.mjs` (PORT, SHOTS; ports 5170–5179 in its header).

- **The campaign's brand** (Settings → Brand) — a manager's
  saved brand is what every page wears: the app's page signed in or out,
  the installed app's name and icons, the unsubscribe, receipt and lesson
  pages, a newsletter's links and the logo over it, and a new website
  until it has its own look. Server tests: `server/test/brand-save.test.js`
  (saving, the pictures and their limits, who may),
  `server/test/brand.test.js` (the page, the manifest, the public pages,
  emails), `server/test/brand-look.test.js` (any colour reads) and
  `server/test/site-follow.test.js` (the website and the brand),
  `server/test/brand-notes.test.js` (what the screen warns about: how much
  of a logo can be seen on a ground). In a browser: `e2e-brand.mjs` (the
  screen itself — SVG logos kept as PNGs, the warning, the sample, Save,
  the signed-out sign-in page, icons and manifest, and back; unsaved
  changes found again after leaving by a link, and not offered to the next
  manager to sign in on the same tab; an SVG that can't be made a
  picture refused in plain words; Imagine
  Surrey's keeps its wordmark and its website's own look) and `e2e-look.mjs`
  (five saved brands × three sidebars read on real screens for contrast,
  one primary and no sideways scroll). `e2e-site-admin.mjs` ends with the
  website following the brand, going back to the look it had, and starting
  its own look from the brand's.

- **Website (the admin)** — **Website** in the desk's menu (managers, or
  whoever a manager grants the Website area). **Overview**: live or not,
  where it is (**View site**), this week's sign-ups. **Pages → New page**:
  in its builder **+ Add a section** (Hero, Text block, Newsletter…), type
  in each one's boxes (it says *Saved* by itself), drag a section by its
  handle (or tap the handle, then *Move here*; or ⋯ → *Move up*), ⋯ →
  *Hide from the page*, ⋯ → *Delete* then **Undo**. **Preview** opens the
  draft in a new tab (and beside the editor on a wide screen). Add a
  *Petition or pledge* without picking one and **Publish**: it says which
  section and which box; pick one and publish — the page is at
  `/site/<its address>`. **Theme**: make the brand colour light (white text
  on it gets too hard to read) — *Save the look* is blocked until **Fix it**.
  **Petitions and pledges**: signatures against the goal, *See who signed*.
  A volunteer opening `/admin/website` is told it isn't theirs. Tests:
  `server/test/site-builder.test.js`, `server/test/site-website.test.js`;
  in a browser: `e2e-site-admin.mjs`.

- **Other websites** (Website → Other websites, a manager): **New website**
  "Doug Didn’t Example" at a domain; its overview is a draft with the
  checklist — Go live says what's missing; publish its home from the
  checklist's link and fill Settings → Organization → Authorized by; Go
  live. On its domain: its name, "Authorized by …", "A website by …" and
  the privacy line under the form; sign there with `?utm_source=flyer` and
  the overview counts 1 from "flyer"; People with `web=site:` finds them.
  Take it offline ("Coming soon"), delete it ("This website has closed",
  410, even at /login). Staff with Website see no Go live and no ⋯. On a
  phone, scroll a draft's overview to the end and open ⋯: Delete is clear
  of the tabs, and so is "Delete this website?". Tests:
  `server/test/site-microsites.test.js`; in a browser, with Chromium
  sending dougdidnt.test here: `e2e-microsites.mjs`.

### Volunteer (on a phone)
- Open the invite link → set a password → lands on the **Map**. Tabs:
  **Today · Map · Calls · Shifts**.
- **Today → Start canvassing** opens your walk list (doors in walking order:
  odd side up, even side back). Tap a door → **1 · 2 · 3 · 4** (each says what
  it means). **4** asks *Voting for?* — McCallum · Locke · Annis · van Vliet ·
  Randhawa · Not sure (or the list your manager set; *Not sure* is always
  last). A toast confirms; *Change* fixes a mis-tap.
- **Try again** (while a manager has a pass open) — Today says which pass
  is on (*Newton block · Persuasion · October · 38 doors left*). *No answer*
  keeps the door on the list with an amber *Try again · 1 of 2* chip and the
  count holds (*38 doors left · 1 to try again*); *Next door* goes to doors
  not knocked yet first, then the ones to try again. **Show → Try again**
  lists only those. A second *No answer* (or a talk, *Refused*, *Moved*, *No
  access*) finishes the door. With no signal the same chips show from the
  phone's copy, and an offline *No answer* reads *Try again*, never done.
- **Mainstreeting** (Today → *Mainstreeting*) — say where you are (*Newton
  bus loop*), *Start*; fill in someone you met (first and last name, phone,
  a rating, *Wants to volunteer*), *Save · next person*: the form clears,
  the place stays, *Met here today* counts them. Turn wifi off and save
  another: *Not sent yet*, and it goes once the signal is back. On their
  profile the history reads *Mainstreeting*.
- **ImagineU** (the fifth tab) — the campaign's courses; open a module,
  read, watch and listen to its materials, *Mark this module done*; each
  course shows how many of its modules you've done. A manager can see what
  you've done.
- **Calls → Your call lists** — the phone banks with numbers handed to you;
  one opens on the Calls card with its script; each call you log crosses a
  number off, and *All done* says so.
- **Fix details** — on a door card (under *More*) or a Calls card, tap *Fix
  details*: correct the name, add a phone, add an email, *Save*. It saves
  with no signal too and sends later. An email already on file shows as *On
  file* — only the office can change it.
- **Map → Show → Share my location while I'm out** — off until you turn it
  on; the phone asks for location once. While it's on, your manager's
  dashboard shows where you are, about once a minute (a green ring, *out
  now*); turn it off when you're done and you're off the map at once. It
  stays on across screens until you turn it off or sign out.
- **My people** (a quiet row on Today, *My people · 6*, and on Calls) — the
  people you know. **Add someone**: a name, a phone or an email, how you know
  them, and an optional note under *More details* (it shows on the row:
  *Neighbour · Book club*). Someone already on the list with that name and
  phone is linked, not added twice, and so is someone you added before with
  that name and email. Anyone else is new and *Brought in by* you. An email
  never links you to someone, so you can't tell whose email it is; if
  someone already has that email (or name), the desk sees *May be the same
  person as …* on both profiles. With no signal an add or a rating is saved
  on the phone (the row says *Offline*; the line turns to *✓ Added …* once
  sent); *Remove* needs signal. Tap a person → *Phone · Text · In
  person* (Phone and Text are the Calls card; In person is a talk away from
  their door) → one tap on 1–4 logs it (*✓ In person · Rated 1 · Strong
  yes*). The sample volunteer *Priya Nair* (invite `priya.nair@example.org`)
  already knows six people, and still does after *Clear sample data* →
  *Load sample data* (her own record is used again, never doubled).
- A long candidate name, or one off the list, never pushes the address or
  names aside: on the walk list and the door card's tabs the chip ends in …
  (its full words on long-press), and two people at a door who don't fit
  side by side go on two lines.
- **More** on a door: note, Call / Text (the phone's own dialer; with Twilio
  connected, the person's card on Calls), request a lawn / large sign or
  billboard (with Undo), add a person at the door.
- **Left lit** (a lit drop) — on the walk list the row under the rating
  buttons reads *No answer · Left lit · Refused · Moved · No access*. Hang
  the piece and tap *Left lit*: the door closes for everyone there, the toast
  says *Left lit*, no rating is asked and the next door opens; the door's
  *More* reads *Left lit ·* and the time. With no signal the toast says *Left
  lit · Saved offline* and it sends once when the signal is back. On the
  map's door card *Left lit* is there at the door, gone after *Call* or
  *How you reached them → Phone call*. Today's *More* then says *You 1 ·
  Team 1 door lit this week*; the profile's History says *Left lit*, never
  *Talked*.
- **Ask the office** (under *More* on a walk-list door and on the map's door
  card) — pick *Call them back · Wants to volunteer · Has a question ·
  Something else*, type what they said, *Send*: *Sent to the office*, and the
  button reads *Asked the office · 2:10 pm*. With no signal it says *Ask the
  office · Saved offline*, the strip's sheet lists *Ask the office · Wants to
  volunteer · Jasmine Wong · 2:10 pm*, and it sends once when the signal is back.
- **Calls** — one person at a time: Call or Text, then rate; *No answer*,
  *Left message* (on a call: a voicemail left — in a phone bank the number
  is done, not called back), *Refused*, *Skip*.
- **Texts** (Twilio connected) — Calls → Text: the message is filled in; edit
  it, *Send*, then *Next →*. Whoever you texted leaves the list until they
  reply; then they come back first, with their reply on the card and a blank
  reply box. Someone another volunteer (or the desk) is texting says
  *Already texting with the campaign*. New replies show as *New replies · N*
  (a count on the Calls tab, a row on Today) → **Inbox**; answer from there.
  A reply like "No thanks, stop" is flagged with *Opt out this number*.
  With no signal Send stays off (*Texts send with signal*). A profile's Call
  and Text open the same card. **Call** rings your own phone first (enter it
  once): answer, press 1, and you're connected — they see the campaign's
  number. With no signal, Call is your phone's own dialler (*No signal —
  this calls from your own number*).
- **Shifts** — the list, a day a heading; each row says what, the hours and
  where. *Count me in* is on the row (a shift at the same time as one of
  yours asks *Count me in anyway?* first); open the shift for *Can't make
  it*. A place with a pin opens a map; a Mainstreet shift you are on has
  *Start mainstreeting*, which opens Mainstreeting at its place. Under
  *You're on this shift*: *The whole time · Change my hours* — *From 4:30*,
  *Until 6*, **Save my hours**: the line and your row read *4:30–6 pm*
  (with no signal, *Not sent yet* until it's back). A drop-in shift reads
  *Drop in · 4–8 pm*, and its page *Tell us when you'll come*.
  `PORT=5153 SHOTS=/tmp/shifthours node e2e-shifthours.mjs` walks this, the
  offline cases and the desk's side (the roster, *Hours → Save hours* on a
  person, the check-in board, the website's *Drop in*).
- **Voted ✓** (once your manager turns Election day on) — on an open door of
  your walk list, the map's door card or a Calls card, one tap says this
  person has voted: the toast reads *Voted · Harjit* with *Change* (a
  take-back), the panel *✓ Voted · 9:12 a.m.* and the door's row *✓ Voted*.
  With airplane mode on the tap says *Voted · Saved offline* and the row
  *Voted · Not sent*; back online it sends once (the strip's sheet lists it
  as *Voted · Harjit · 2:14 pm* until then). With Election day off there is
  no button.
- **Signs** (from Today when there are signs to put up) — *Put up ✓*.
- **Offline**: turn on airplane mode, rate three doors (they say *Saved
  offline*), *Count me in* on a shift (*Take back* undoes it before it
  sends), add someone to *My people*, turn it off — they send once, never
  twice, and the strip says *5 sent*. The strip's *saved on this phone* chip
  lists what's waiting. Reload with no signal: the campaign's own rating
  buttons still show, and Today, Calls, Shifts and any profile you opened
  read from the phone (never with money or anyone else's email).
- Confirm a volunteer **never sees money or the supporter list**: no Donations,
  People or Outreach; typing those addresses lands back on Today. (The
  server enforces this too: their browser never receives other people's
  emails or donor tags.)
- **Today → More → All time** — under the week's calls and texts, e.g. *All
  time: 3 doors · 2 talks · 2 supporters found*: every door you've knocked
  (a door knocked twice is one), the talks, and the people you rated a yes.
  It's there with no signal too.
- **Shifts → a shift with turfs** — it says *Walk list: Newton block — Count
  me in puts it on your phone*. Tap **Count me in**: Today's *Start
  canvassing* opens Newton block and *Your next shift* reads *… · Newton
  block*. With no signal it waits on the phone (*Not sent yet*) and the turf
  arrives once it sends. *Can't make it* takes that walk list back off
  Today; a turf the desk gave you by hand stays.

### Staff
- **People** — search; **Filter** by rating, tag (media, VIP…), or volunteer
  role (incl. *Hi-rise building captain*); open a profile; add tags, roles,
  social handles. **More → Call list / Text list** opens Calls with the same
  filter; **More → Inbox** has every text conversation.
- **A profile → Details → Socials** — **+ Add**, paste
  `https://www.instagram.com/lin.example/?hl=en`: the line reads
  *@lin.example* and opens the profile. Paste `@lin`: *Which network is
  @lin on?* with a row of networks — tap **X**. Paste a post
  (`instagram.com/p/…`): *That’s a link to a post, not a profile*. Tap
  *Followers?*, type `12k`, **Save**: *12,000 followers*, and the head says
  *12k followers*. **More details** says when it was typed. × asks *Remove
  @lin? Yes · No*; removing the handle takes its count. **People → Filter**:
  *Has* · *Any social*; *Following* · *1,000+ followers* finds them, with a
  Followers column; each network is under *More filters* → *Social*.
- **Outreach → Sharing** — **New post to share**: a title, the words (the
  counter counts the *Authorized by* line and says *Under 280 fits X*), the
  page (Home, a published page or an open petition), a picture under *More
  details*; **Save post**. As a volunteer, Today shows *Share · 1 post*;
  **Share** shows *Your link* and the post: **Copy words** copies the words
  and the post's link (`/r/…?k=…`); **Share** opens the phone's share sheet.
  Open that link in a private window, go to the home page, back to the
  petition, sign: the desk's row reads *1 sign-up · 1 sharer*, Top sharers
  names the volunteer, and their *Share* reads *1 person brought in*. Close
  the petition: the row says *Page not live* and the post leaves *Share*.
  (`e2e-sharing.mjs`.)
- **A profile → History** — everything with them on one list, newest first:
  knocks and calls (*CallHub* beside a call a dialer logged), texts, emails
  (*Sent · Opened · Clicked a link*, and *Bounced* or *Marked as spam* once
  the email service reports them), website forms, gifts, memberships,
  shifts, answers, signs, voted, *Unsubscribed from email*, *Replied STOP*.
  The chips narrow it (*Doors & calls · Messages · Website · Money ·
  Shifts*); a gift on the books or an answer opens its section here, a
  shift or a text its own screen (a voided or refunded gift, or an answer
  with no signal, is plain words: nothing here to open); *Load more* brings
  the next 50. Staff denied Donations see no Money chip; a slow or failed
  read says *Loading…* or *Unavailable — Try again*, never an empty history.
- **Shifts → Week** — next week (**›**). **+** on Monday: tap *Burma
  Shave*; *Pick on the map*, tap a corner, *Use this place*; *Weekdays*;
  **Add 5 shifts** — five cards under *Early*, 6:30–8:30 am, named for the
  corner, nothing typed, and no number on them (*More → We need* sets a
  target by tap: then *0 of 4*). **+** on Saturday: *Canvass*, a turf,
  *2–5 pm* as well: a morning and an afternoon canvass, each with its turf
  chip (the turf is the place, said once). Tap a card: another day and
  **Save** moves it (or drag the card to another day — *Undo*); with
  someone on it the week says who has the old time, with **Tell them**
  (close the sheet that opens — ✕, Escape or Back — and you are still on
  the week). *Another time* opens on the usual hours (that chip goes off);
  *Starts* and *Ends* step a quarter hour either way — *6:45–8:15 am*, or
  an Event at 8 pm for *6 h*, *Ends − 15 min* four times: *1:00 am next
  day · 5 h*, its card *8 pm–1 am*. A shift the long form made at 11 pm
  opens its sheet on *11 pm* and its own length, both chosen; tap another
  length by mistake and its own can be tapped again. Tap a name in the strip of people: it stays in
  hand (*Tap each shift to put … on it*, then under the name what each tap
  did — no toast over the next card) while you tap card after card;
  **Done** puts it down. A long name on a card keeps its initial
  (*Kristo… E.*). Someone who filled in the website's volunteer form is there,
  marked *Asked*. *Every week for 4 weeks* makes a repeating slot:
  its card offers *This one · This and the following*. **More**: *Tell
  everyone on this week's shifts* shows the count first, then *Details* a
  person a row; *Remind people the evening before* is a switch (a
  manager's); *Copy to next week* asks *With the same people?*. Go a week
  further: an empty week offers **Copy last week**. On a phone it is one
  day at a time, the sheets come up from the bottom, and **People** opens
  the list as a sheet; **Back** closes a sheet, not the week. Lose the
  signal with a sheet open: the sheet keeps every choice and waits (*No
  signal — your choices stay*). A point nothing could name reads *Pinned
  place* — on its card, its own page (with *Name it*) and the website (*See
  the map*), never its coordinates; its Mainstreeting asks *Where are
  you?*. With more than 500 shifts ahead the List ends in **Show later
  shifts**.
  `PORT=4900 SHOTS=/tmp/schedule node e2e-schedule.mjs` runs all of it in a
  browser — a desk at 1440×900 and 1280×800, a laptop on Toronto time, a
  phone, and a volunteer's phone (its own server, a stand-in address
  service and texting provider) — checking that no key is pressed in the
  add sheet or while people are placed.
- **Shifts** — the long form (**New shift → More → More options**: what,
  when, where; role, end, instructions, link, turfs and *Limit sign-ups to*
  under *More details*),
  **Add volunteer**, then **Notify everyone** (email + text). Without email/text connected the
  button says *Save — nothing sends*; once connected, *Notify again* reaches
  them. Nothing on any screen claims to be sent unless it was.
  **Edit** under the title opens the shift filled in; move its time or
  place and it says *It moved — 1 person booked has the old time or place*
  with **Let them know** (the same Notify). Room for fewer people than are
  booked is refused. **Call off** asks once (and says who booked won't be
  told); the shift leaves every list, and the walk lists it put on phones
  come back off — never a turf given by hand.
- **Shifts → a shift → Crew** (the crew board) — make a shift that carries
  two turfs. *Add people* on the left lists your volunteers who aren't on it
  (someone on an overlapping shift says *Busy then: …*; someone who asked to
  volunteer at a door says so). Drag a name onto a turf: they're booked and
  that turf is the one walk list on their phone; drag them onto another
  turf, *No walk list* (a driver) or *Not placed yet* (every walk list, as
  before). No mouse? Tap a name, then *Add here* / *Move here* on a column
  (Enter and Escape work too). ⋯ on a card: *Team lead*, *Driver*, and on
  the day *Here* / *No-show* — someone *Here* keeps their spot, so a full
  shift stays full. *Split the rest evenly* places everyone not placed yet.
  Drag a card back to the left to take them off the shift — *Undo* puts
  them back as they were: where, their job, *Confirmed* or *Here*. Without
  Map & turfs, *Undo* is there only for someone not placed on a turf or on
  *No walk list*.
- **Shifts → Volunteers** — everyone who volunteers: *Asked to volunteer*
  (still waiting), *New*, *Active*, *Lapsed* (nothing for 30 days), by role
  or name. Open one: *Call*, *Text*, how many shifts they've done, and
  **Put on a shift** — the next weeks' shifts with their spots (*Busy then*
  when it clashes); a tap books them and their *Wants to volunteer* request
  is marked done.
- **People → More → Duplicates** — add two people with the same email (or
  the same name and phone): they show side by side with why. *Keep this
  one* asks once; *Merge* leaves one record with both histories (open the
  other's old link: *Merged — open their record*). *Not the same* keeps a
  pair away.
- **Donations → Stewardship** — log two gifts; both are under *To thank*.
  *Called* on one: it leaves; *Letter* on the other — To thank is empty.
  *Next step…* on a donor sets a step and date; *Done* clears it.
- **Signs** — tap *To put up* / *Up* / *Taken down* to filter; **Add a sign**
  (it needs an address); a request that never went up can be *Cancelled*.
- **Map → filter button** — *Strong yes (1)* and *Lean yes (2)* sit beside
  *Yes (1–2)*; under *Voting for*, one choice per opponent (*Voting Locke*).
  **Signs**: *Up* and *Requested* both on shows every flag (a request is a
  pale flag); turn *Requested* off and only signs up stay; turn a kind off
  (*Billboard*) and its flags go. The choice stays on that browser.
- **Map → filter button → Map** — the map opens on *Clean* (quiet streets,
  no shop icons or house numbers); *Muted* greys the standard streets (the
  doors keep their colours), *Dark* is for night; it stays on that browser.
  With Google Maps on (`GOOGLE_MAPS_TILES=1`), *Satellite* and *Terrain* are
  there too.
- **Map, zooming in** — from the whole city to a street: every door is a
  dot in its rating's colour (grey: not asked yet), no number bubbles; a
  door with a sign gets a little flag, and close in a household's size is
  on its dot; at street zoom the dots become pins. Tap a dot to open that
  door. With your whole voter file loaded (more than 5,000 people placed),
  the map opens on your list as a picture — shaded squares, darker where
  more people live, coloured as far as they've been rated — with a key and
  *Each square is a block — zoom in for doors* under the count, and **Show**
  counts what is on screen (*300,049 people*); from zoom 14 every door is a
  dot (*1,211 doors*), and a tap on one opens it. Zooming never empties the
  map: what was drawn stays until the next answer is in. **Whole list** goes
  back; over open water — and as soon as the list's last squares leave the
  screen — it says *Nobody on file here · Back to your list*. (Pick one
  rating, such as *Strong yes (1)*, over streets where nobody has it: *0
  doors*, and no such note.)
  (`node e2e-map.mjs` runs a big list in miniature through all of this in a
  browser, and through the next four; `ONLY=tiles,check node e2e-map.mjs`
  runs parts of it.)
- **Map, Google Maps refusing** (staging with `GOOGLE_MAPS_TILES=1`) — a
  key with billing off, or block `/tiles/` in the browser's network tools
  and reload: the map turns to the free map and says *Google Maps isn’t
  loading — showing the free map*; a manager's *Why?* beside it opens the
  Map check, whose top line is *Street map service — Not working · Google
  Maps* with the plain words, *Google said* and the Recipe B step. Staff and
  volunteers see no *Why?*. (`ONLY=google node e2e-map.mjs` runs this
  against a stand-in Google; `GOOGLE_PORT`, `GPORT` pick its ports.)
- **Map, the street map not loading** — block `basemaps.cartocdn.com` in
  the browser's network tools and reload: within a moment a line says *The
  street map wasn’t loading — switched to Muted* and the streets are there.
  Block `tile.openstreetmap.org` too and move the map: it goes back to
  *Clean* by itself and *The street map isn’t loading · Try again* stays
  under the count; unblock CARTO, tap it, the streets load and the line
  goes. Weak signal: on a phone that has looked at a turf, block both hosts
  and pan away — *The street map isn’t loading · Try again*, and no switch
  (the other doesn't answer either); tap it, pan back, and the turf's
  streets are still there, and in airplane mode too (and the look is still
  *Clean*). (Hosts that never answer, rather than refuse, are said the same
  way, six seconds after the map last moved over blank streets, or zoomed
  in over the blurred streets of the zoom before — and the line goes by
  itself back over the streets the phone kept, or a second after slow tiles
  have come after all.)
- **Map, many turfs** — outlines and names show at once however many turfs
  there are; tap one and its sheet opens with *Loading…* where *64 doors
  left* then appears.
- **Map, reopened with no signal** — as a volunteer on a phone, open the map
  on your turf with signal, then go into airplane mode and reopen the app:
  your doors are there, *No signal — showing the doors already loaded* sits
  above *My turf* and the zoom buttons (each still a tap away), and there is
  no *Unavailable — Try again* on *My turf*. A manager's whole voter file
  keeps no doors on the phone: there *Unavailable — Try again* says it
  alone, and once it answers again the doors it draws carry no line about
  kept ones.
- **Map → filter button → Map check** (managers) — one sheet: on file, on
  the map, not on map (and why), the placing run, outside your area, turfs,
  the street map and its tiles, this page against the server, the map's
  size. Whatever is wrong is flagged, and comes first; send a screenshot of
  it with any report that the map looks empty (on a phone it fits one
  screen).
- **Map on an older or odder screen** — a phone held sideways: nothing to
  scroll past the map. A laptop: the Show sheet scrolls inside the map to
  its last line.
- **A tab left open across a deploy** — its next answer from the server says
  so: *A new version is ready · Reload* under the nav, and the next link you
  tap loads the new page. It never shows an empty map or a blank screen
  (`node e2e-deploy.mjs`: two builds take turns on one server).
- **Map → filter button → Draw turf** — tap the corners, name it, assign a
  canvasser.
- **A profile → More details** — tap Yes/No or a choice, type the rest,
  **Save** → *✓ Saved*. **People → Filter → More filters** → e.g. *Language
  at home: Punjabi*; *More → Call list* keeps it. Volunteers see only the
  fields marked for them, read-only. Follow *Same address* to the next
  person: nothing you typed or saved goes with you.
- **Who knows whom** — **People → More → Most connected**: the sample's
  *Priya Nair* is first (*knows 6 · 1 supporter*). Open *Jasmine Wong*
  (undecided): under the rating, *Ask Priya Nair — they know each other*.
  **Knows** lists who someone knows; **+ Someone they know** → search → *how
  do they know each other?* links them both ways; *Remove? Yes · No* takes
  it off. *Sofia Petrova → Knows* says *Brought in by Priya Nair*. Someone
  tagged *do-not-contact* gets no nudge and is never the one suggested. A
  long note (a link) wraps in Knows. The sample's *Priya Nair ↔ Sofia
  Petrova* and *Gurpreet ↔ Navdeep Sandhu* are close ties: Priya's profile
  opens with *Knows Sofia Petrova Friend · Close …* under her chips (a
  do-not-contact housemate never shows on that line); *Close* in Knows
  toggles in place; *Make a list* opens *Priya Nair’s circle* with as many
  people as she knows; People → Filter → *Knows a supporter* counts what the
  server counts; a staff member denied Donations has no *Knows a donor*; the
  desk's Calls card says *Knows …*. Priya, at a walk-list door with no
  signal: More → *I know them* → *Friend* shows *You know them · Friend* at
  once and sends once when the signal is back, then says *Added to My
  people*; one the server refuses says *Not saved* and keeps saying it
  after it is dismissed from the outbox; a profile with long Surrey names, a "4 · Randhawa" tie and a
  housemate keeps its key line to two lines at 390 (`e2e-relationships.mjs`; her
  browser never gets a key, Most connected or Knows answer). Server tests:
  `server/test/relationships.test.js` (close, `relationship.update`, the key
  read, `knows=` for each role and area, Most connected's *brought in*, a
  merge, housemates), `server/test/ties-rank.test.js` (which ties come
  first) and `server/test/audience-scale.test.js` (`knows=` through indexes
  among 300,000 people).
- **Desk with no signal** — with wifi, open Today, People, a profile,
  Shifts, Signs, Donations and the Inbox. Turn wifi off and reload: each shows
  what it had and the strip says *No signal · from 2:14 pm*. Search People —
  it searches what this tab kept. A profile never opened says *No signal —
  this profile loads when you're back online*. On a profile, add a note and
  tap a rating, add a tag, remove one: *Saved on this device — sends when
  you're back online*, and History shows *Not sent yet*; a note typed on its
  own goes out when you leave the profile. *More details* shows what it had,
  read-only (*Changing these needs signal*); Knows and its nudge show from the
  kept copy, with *+ Someone they know* and *Remove* off (*Adding and removing
  need signal*). *Add person*, *Log a gift*, *Add a sign*, *New shift*, *Edit
  details*, *Get invite link*, *Clear sample data* and Profile
  fields changes say they need signal. Rating scale, Team and a shift never
  opened say *No signal — this loads…* with no time in the strip. A People or
  Calls filter on a profile field never opened with signal says *No signal —
  the list loads when you're back online*, never the whole list. Wifi back:
  each is sent once.
  - **Two tabs**: with no signal, rate someone in one tab and tag someone in
    another, close the first, reconnect: both are sent once.
  - **Wifi with no internet** (router up, uplink down): reload and you're
    still signed in, the strip saying *No answer · from 2:14 pm*; it clears
    by itself. **Server down** (502 during a deploy) in a new tab: People says
    *No answer — check your signal*, never *0 people*.
  - **Sign out**: a note still typed on a profile or door card is sent first,
    as yours; nothing stays, the next person on that computer sees none of
    it, and another open tab goes to Sign in.
- **Requests from the doors** — after a volunteer taps *Ask the office*,
  Today's *Needs you* says *1 request from the doors*; it opens the list (who,
  what it's about, what they said, *asked by Priya · Sat 2:10 pm*). *Call*,
  *Profile*, or *Done ✓* → what you did (optional) → *Done*: *✓ Done*. With
  none left: *Nothing waiting from the doors.* The *Done* pill shows who did
  each and when, with *Reopen*. A volunteer never sees what was said or who
  asked.
- **Reports → Field, by turf** (staff and managers) — pick *This week*,
  *Last 7 days*, *30 days* or *All*: by turf, the doors, how many were
  knocked (with the share and a bar), talked, yes, no answer, refused, moved,
  no access, who canvassed and the last knock; by canvasser, doors, talks,
  yes, days out and when they were last out; and a small table by day. A
  door knocked twice counts once; calls and texts never count. **Download
  CSV** gives the turfs, then the canvassers. Reload with wifi off: the last
  range you loaded shows, the strip saying *No signal · from 9:02 am*.

### Treasurer
- **Donations** — **Log a gift**; log enough to one donor to cross the annual
  limit (sample: *Arjun Mehta* is already over). Donor tiers on profiles:
  star ($1K+/yr or $100+/mo), superstar ($3K+/yr or $250+/mo). Add two
  people with one name and postal code and log $1,000 to each: the second
  says *Maybe $570.30 over* under Needs you; *Not the same person* → *Yes*
  clears it.
- **Donations → More → Receipts** — every gift gets a numbered receipt
  (`2026-0001`, no gaps) the moment it's logged, marked paid, or paid by card;
  open a gift on Donations to see *Receipt 2026-0007 · Sent*. Without email
  connected each one says *Not sent — email isn't connected* (or *No email on
  file*) — tap it, then **Print**. With email connected it goes to the donor
  once by itself a minute after the gift (the toast says *receipt emails in a
  minute*; Undo before then and nothing is sent); *Send again* resends;
  **Email 3 receipts** (the yellow button) sends the *Not sent* ones with an
  email, never one already *Sending*. A donor with no street address: Log
  a gift asks for it under *More details*; left blank, the receipt says
  **Needs address**, shows under **Donations → Needs you** (type it right there)
  and its email waits until the address is saved. Voiding a gift marks its
  receipt **VOID** (the number is kept); if the receipt was already emailed,
  Donations asks *Receipt already emailed — send a void notice?* Set the
  financial agent, the minimum gift and the footer under **More →
  Settings** (the campaign's dates under *More details*); **More →
  Disclosure** picks a period (this campaign, or a calendar year) and
  downloads contributors over $100 for a spreadsheet, with an *Over limit*
  column. Sample gifts are never in it.
- **Donations → More → Import donations** (a manager or the treasurer) — make
  a small spreadsheet of made-up gifts with another tool's own headings
  (*Transaction ID, Donor, Donor Email, Amount, Date Received, Payment
  Method, Receipt #*), two of them to one donor on file adding up past the
  limit, one from someone not on file. The columns match themselves;
  **Check** saves nothing and says the gifts, the donors found, the gifts
  to settle and who it takes over the limit; **Import** puts them on the
  books. On Donations they wear *Imported* — open one: *Imported — no
  receipt from base.win · their receipt …* — the later of the two is under
  **Needs you** as *Over limit*, and **More → Receipts** has no new number.
  The gift with no donor on file is there too (*1 imported gift needs a
  donor*): tap it, then pick the record, *Find them on file*, or *Add as a
  new person*. Import the same file again: *Nothing new*. Log one of a
  new file's gifts at the desk first (same donor, amount and day): its
  check says *1 row looks like a gift already typed in here*, and ticking
  *Leave it out* takes it off the gifts and the total at once. Add a
  *Payment Status* column (*Completed*, *Refunded*, *On hold*): *Which come
  in* opens with *On hold* to say, and the check leaves the refunded and
  on-hold rows out by their status. Leave a waiting gift out on the pile:
  Donations → More now says *1 imported gift left out*, which opens the
  pile's *Left out* list with **Bring back**. Back on the import screen,
  **Take back** (for a day) voids the lot.
- **Donations → More → Filing dates** — type *Disclosure statement due* and
  a date three weeks out, **Save dates**: Donations counts the days down
  under the big number, and Today lists it under *Coming up*. Nothing is
  there until you type it.
- **People → More → Enter a membership form** — type a paper form for a
  made-up person: a birth date 25 years ago (*the $5 youth rate applies*),
  *Canadian citizen*, a union local, a campus, *I'd like to volunteer*, *A
  sign → Window*, two languages and *Other: Tamil*, two interests, *1 year*,
  *Give once → Superstar Club*, *Cheque*, *Signed*. *Save the form* says
  what was done — a youth membership for a year, $1,429.70 to each slate, a
  window sign to put up — and *Office use: entered in base.win by you*. On
  their profile every box is a field (Tamil under *Other language*); they're
  tagged member and volunteer, on Signs and in the volunteer requests.
  *Enter another form*, type the same email: *Already on file?* →
  *That's them*; *4 years*, $20, *Cash*, *Signed*: the new term starts when
  the first ends, and *Check:* says what to look at. Pick *Credit card*: a
  note to black out the card number — there’s no box for it. **Data →
  Take data out → Members** lists every member, paper and website.
- **Online giving** (staging, Stripe in test mode — INTEGRATIONS.md): give
  on the website with Stripe's test card `4242 4242 4242 4242`. The gift
  shows on **Donations** marked *online* with its receipt, under *Online
  giving · test mode* as *Paid*; a monthly gift puts the donor under
  *Monthly donors*. Try to give more than the year's limit at once: the form
  refuses it in plain words. Log a big gift at the desk for someone, then
  give online as them: the form still goes to Stripe (it never tells a
  stranger what someone gave), and when the payment lands it is refunded
  and *Needs you* says so. Refund a payment from
  Stripe's dashboard: **Needs you** says the gift is void (*Got it* clears
  it). `node e2e-payments.mjs` (PORT, SHOTS) runs all of it in a browser
  against a stand-in Stripe.
- **Today → More → Verify the records** replays the tamper-evident log;
  **Export all data** downloads everything.
- **Donations and People with no signal** read only in the same browser tab
  (money and donor lists are never kept past the tab): close the tab, reopen
  with no signal, and Donations says *No signal*. Make a volunteer a treasurer
  while their app is open: Today's money stays in their tab; make them a
  volunteer again and, after a reload, nothing a treasurer saw is kept.

### Import your own lists
**People → More → Import & export → Import people** (or People → More → Import). A list with a *Voter ID* column fills each person's voter number (a profile's *More details*), and the same number in a later file finds the same person however the name is spelled. A later list that numbers the same people afresh is asked about in the check (*N rows match someone on file with another voter number*): they stay the people on file unless you say to take the file's numbers or to add them as new people (the arrow keys move between the answers; each one checks again with the question left in place). A CSV or an **Excel workbook (.xlsx)** both work — save a sheet from Excel or Google Sheets as .xlsx and choose it: its first sheet comes in, columns matched. Try `samples/surrey-import-test.csv` first —
fictional people at *public building* addresses (City Hall, rec centres). The
check step should report **9 new, 1 merged** (Jordan Lee appears twice with
the same email) and **1 refused** (the row with no name); Robin Kaur's rating
"7" isn't on the scale, so she comes in unrated and the check step says so.
Ratings import as codes, words or candidate names in any case (*definitely*,
*Locke*, *4b*). A list rated its own way (a 1–5, *Strong*, *Weak*) gets
**What each rating means on your scale** under the columns once a column
is matched to *Rating*: every value the column holds, most common first,
with a pick for what it is here — a 5 on the list can be a 1, a 1 can be a
candidate, and *Leave unrated* drops it; the check and the preview use your
picks. A column named like a profile field (any case, any script —
*语言*, *ਭਾਸ਼ਾ*) fills it; a bad cell (e.g. *Klingon* for *Language at home*, or
*1 2 3* for a Number) is refused by row number. A field taken off before you
tap Import is skipped; the row still comes in. The campaign's own list maps
by itself: House Number + Street Name become one address, Latitude and
Longitude a pin, Volunteer and Donor (1/0) the tags, Home Phone, Province,
House/Building Notes, Access Type, Dwelling Type, Interaction Status/Date,
Organizer, Email/SMS Opt-In, Sign, Support (1–5) and Voted the standard
profile fields of the same names. Tags like *Vol: Door Knocker* show under
**Volunteer roles** (Doorknocking guessed); set *Vol: GOTV* to Driver, import,
and the person's profile lists both roles. Import again: no role twice.
Give a row *Interaction Status* Not Home and *Interaction Date* 10/04/2026:
**Past conversations** reads it as Not home; imported, their history shows a
not-home knock on Oct 4 *From an imported list*. Set **Signs** → *Yes* to
*A lawn sign to put up*: it's on the Signs list at their address.
A First Name of *Lee Ann*: the import offers *Lee · Ann* (ticked); imported,
Lee Ann's profile has First Lee, Middle Ann. **People → Add person**: type
*Mary Anne* and Tab — First Mary, Middle Anne, with Undo; *Mary-Anne* stays
whole. **From a past election**, year 2022, a row rated 1 with Voted yes:
imported, they're tagged *Strong support 2022* and *Voted 2022*, unrated and
not marked voted.
- **A profile → More details** — *Language* taps on and off (any that
  apply: Punjabi and Hindi both on); *Notes* is a box for a long note, its
  lines kept; *Voter eligibility* is Eligible or Ineligible. Save; People →
  Filter → Language → Punjabi finds them; Data → Export → People has the
  three columns (*Punjabi; Hindi*). Their volunteer roles offer *Candidate
  aide*, *Social media team* and *Photography / videography*. A Sign (Yes/No) column shows ticked as *Sign 2022*: they
get that tag, and their Sign profile field stays empty.
Then the addresses are looked up with the BC Address Geocoder (needs
internet) — by themselves: an import that leaves addresses without a pin
starts placing them, and the import page shows it going (**Place on map** is
there where it didn't start: no background jobs, or lookups turned off). It
runs on the server: you can close the page and it keeps going. The map says
*Placing addresses · 12,400 of 150,000* where *Not on map* was, and the new
doors appear as it goes (tap it for **Stop**, or come back to Import). Everyone at one address is one lookup, and an address already
on the map is copied without a lookup. If the geocoder stops answering, the
run pauses with the reason and tries again by itself (after 15 minutes, then
less and less often) — the map says *Placing addresses paused*, and tapping
it says when the next try is; **Try now** does it at once. (A minute past
that time and still paused, it says the try *was due* at that time: it
didn't run — **Try now**.) Addresses it
can't find end up under **Not on map** for a pin by hand. Someone with no
address at all is never put on the map; the Map check counts them.

A full voter list (hundreds of thousands of people) takes a few hours. Set
`BC_GEOCODER_KEY` (a free key from the BC government's API gateway) for
higher limits, and `GEOCODE_CONCURRENCY` (default 6) to ask more at once.

To use Google Maps for the lookups instead, or for the addresses the BC
service can't place: in Google Cloud enable the **Geocoding API**, create a
key restricted to that API (and to the server's IP), and set
`GOOGLE_MAPS_SERVER_KEY` with `GEOCODER=google` (Google for everything) or
`GEOCODER_FALLBACK=google` (BC first, Google for the rest). Google charges
per lookup past its free monthly allowance — check the current pricing
before running a whole voter list through it.

For your real voters list: map its columns on the second step; re-importing
the same file never creates duplicates.

---

**Time-zone rules.** B.C. stays on UTC-7 all year from March 2026. base.win
needs a Node 22 new enough to know that, or every time after Nov 1, 2026
shows an hour off. It checks at startup: an out-of-date server logs a
warning, shows a banner on the manager's Today, and reports
`"tzdataCurrent": false` on `/api/health`. Fix it by redeploying with a
newer Node 22 image (the Dockerfile uses `node:22-alpine`, which pulls the
latest).

---

## 4 · Known limits in this build

- **Google from the installed app — device check not done yet.** The field
  app installed on a phone’s home screen shows *Open base.win in your
  browser to use Google.* instead of every Google button: Google’s page may
  open there in a separate browser whose sign-in isn’t the app’s, and
  Google refuses sign-in inside other apps’ built-in browsers. Before
  telling volunteers, on one iPhone (Safari, and installed) and one Android
  phone (Chrome, and installed), against staging with a real Google client:
  Sign in with Google, the Join tick box, Link, and one Connect — pass means
  the app opens signed in (or linked) without a second sign-in; also open an
  invite inside a social app’s browser and note what Google shows. Record
  the result here. Until the installed runs pass, the line stays
  (`googleHere()` in `web/src/components/google.js`).
  *Result: not yet run.*

- Map tiles come from CARTO (the *Clean* look the map opens on) and
  OpenStreetMap, both free and neither for heavy use; choose a provider the
  campaign has an agreement with before election week: Google Maps
  (`GOOGLE_MAPS_TILES=1` and a `GOOGLE_MAPS_SERVER_KEY` with the Map Tiles
  API enabled), Stadia Maps (`STARBASE_TILE_PROVIDER=stadia`) or any
  `{z}/{x}/{y}` provider (`STARBASE_TILE_URL`) —
  GOING-LIVE.md, section 5. The browser tests run where neither host can be
  reached, on stand-in tiles: nothing here has checked the real street map.
  If it stops loading, the map says so.
- Offline covers **field work** (knocks, new people and doors, pins, sign
  requests, shift sign-ups, *My people*) and **reading the desk**; on a
  profile, ratings, notes and tags save offline. Gifts, imports, outreach
  and other edits need signal. Receipts aren't kept offline.
- The BC municipal contribution limit is seeded at Elections BC's 2026
  figure, **$1,429.70** per contributor for the calendar year — one limit
  shared by an elector organization and its endorsed candidates (2022:
  $1,250; 2023–2025 gifts are checked against $1,250, the lower, until
  those years' figures are added). Confirm with Elections BC before filing.
- Without Twilio, calls and texts use the phone's own dialer and messages
  (no auto-dialer).
- Contribution receipts: the wording (including the *not tax-deductible*
  line), what a receipt must show, the minimum gift that gets one and the
  $100 disclosure amount are all settings — **the financial agent must
  confirm receipt contents and thresholds with Elections BC** before
  receipts go to donors or the disclosure is filed. The same goes for the
  disclosure's **period**: unset, *This campaign* is the current calendar
  year — confirm the election period with Elections BC and set it under
  Receipts → Settings → More details.

### Texting and calls — confirm with counsel

Built conservatively; the campaign should confirm these rules with counsel
(CRTC rules, the Voter Contact Registry) before texting or calling voters:

- Every text is one person tapping *Send* for one person — no bulk or
  scheduled sends, no auto-dialer.
- The first text to someone names the campaign and ends "Reply STOP to opt
  out".
- STOP, STOPALL, UNSUBSCRIBE, CANCEL, END or QUIT (punctuation and emoji
  ignored — "STOP 🙏"; clear requests such as "Please stop texting me" too)
  opts that number out at once and for good (tagged *do-not-text*); START or
  UNSTOP opts it back in, and takes off only the tag its STOP put on — a
  *do-not-text* the desk set by hand stays. A reply that only has a stop
  word in it ("No thanks, stop") is flagged in the thread; *Opt out this
  number* (any role in the thread) is the same opt-out.
- One campaign conversation per number: while someone's conversation with a
  number had a text in the last 7 days, nobody else sends another
  introduction, and replies stay in the conversation the voter last replied
  in.
- Quiet hours: texts and calls go out only 9 am–9 pm Monday to Friday and
  10 am–6 pm on weekends (the CRTC's telemarketing hours), Surrey time, by
  default — **confirm both with counsel**; managers change them under
  **Inbox → More → Texting settings**. The server refuses anything outside
  them, shift notices included (*Text not sent — quiet hours*). Shift
  notices are never texted to an opted-out or do-not-text number.
- Calls show the campaign's number, never the caller's own.
- Someone tagged *do-not-call* is never put in a phone bank, never rung
  through the campaign's number and never sent to CallHub's dialer — and
  their profile, Follow-ups (Today's card and the desk's list), Requests
  from the doors, My people, a door's card and a walk list offer no Call
  to tap — nor for anyone tagged *do-not-contact*, where the card says
  *Do not contact* instead; the People list shows the number without a
  link. (Not yet on a
  shift's sign-ups or crew board, the Volunteers roster or Stewardship: a
  volunteer's or a donor's number can still be tapped there.) A CallHub result that
  reads "do not call" tags them. The CRTC expects a
  campaign to keep and honour its own do-not-call list — **confirm what a
  dialer needs with counsel** before a calling night.
