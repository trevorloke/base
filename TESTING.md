# Testing Starbase

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

1. Open **http://localhost:3200/signup** and set up Starbase for Imagine
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
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | SMS shift alerts; texting and calling from the app through the campaign's number | optional — without it, Calls opens the phone's own Messages and dialer |
| `GOOGLE_MAPS_SERVER_KEY` | Google geocoding (`GEOCODER=google` or `GEOCODER_FALLBACK=google`) and Google Maps tiles (`GOOGLE_MAPS_TILES=1`) | optional — the free BC geocoder and OpenStreetMap tiles work without it |

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
  `/admin/` (the brand reads *Starbase Admin*): every screen below. Your
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
  filter is on) — a saved filter counts who matches as you pick (and how
  many can be emailed or texted); a hand-picked list takes people by name.
  A list has *Download CSV*, *Email this list* and *Text this list*.
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
- **Outreach → Ladders** (automatic emails & follow-ups) — email steps go
  only to people who said yes to email (the newsletter); everyone else shows
  *Email skipped — didn't ask for email*.
  *+ First name* / *+ Campaign* fill in. The email's unsubscribe link asks
  first; once someone unsubscribes, **Email → More → Subscribers** can't
  add them back — only they can, by signing up again.
- **Email & texting** (the *Connect* links on Shifts, Receipts and Ladders,
  or Today → More) — whether email and texting are connected, and the
  Imagine Surrey website address the public pages link back to.
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
  phone bank*: a name, *Undecided* under *Who to call* (the count updates as
  you filter), a script, *Make the bank*. On the bank: *Hand out* three
  numbers to a volunteer (or a team — split evenly), watch *Callers* fill;
  *Take back* unfinished ones; *Close*. On the volunteer's phone, Calls
  says *Your call lists 1*; tapping through opens the bank on the Calls
  card with the script; each call they log crosses a number off, *Skip*
  (on the bank page) crosses one off without a call.
- **Settings → Members** — invite a volunteer and a staff member; change a role; remove one (their phone is signed out at once).
- **Settings → Teams** — make a team, put two people on it, name a lead; on the map, add the whole team to a turf.
- **Passes** (Turfs → *Pass: none ›*) — **Start a pass**: a name, *What
  for* (Persuasion · Get out the vote · Lit drop · Find out who's who), *Who*
  (All doors · Not rated yet · Undecided or not rated · Yes (1–2) · Everyone
  but opposed) and *Tries* (2). Every turf's *doors left* changes the moment
  it starts: doors knocked before are back on the lists, doors outside the
  universe leave them. The pass's card counts *doors knocked · talked · yes*
  as the team works; **End this pass** (asks in place) puts every knocked
  door back to done, and starting another pass ends the open one.
- **Settings → Permissions** — untick Donations for Staff and watch a staffer's Donations tab go; tick Outreach for one volunteer and watch them get it. Under **Volunteers' map** pick *Only their turfs*: a volunteer's map now shows just the doors inside the turfs they walk (no turf: *No turf yet*), and *Every door* brings the rest back.
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
- **Shifts → New shift → More details → Turfs** — tap one or more turfs
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

- **Settings → Services** (managers) — every outside service: what it's
  for, *Set up* / *Not set up* (naming the settings missing) / *Using the
  free default*. **Check** on each makes one real call: Email says whether
  Resend took the key and the sender's domain is verified; Texting whether
  the number is on the Twilio account and its replies come here; Address
  lookup, the map background, the public address and the database answer
  too. *Coming in* lists the address to give Twilio. Staff can't open it.
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
  saved list (and a blast or Calls from it) keeps them.

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
  events, where anyone can sign up (room is checked). Their
  `/preferences` link turns email and texts off or on in base.win itself.
  Server tests: `server/test/site-*.test.js`; in a browser:
  `e2e-site-server.mjs`.

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
- **Shifts** — *Count me in* on an open shift; *Can't make it* to drop out.
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
- **Shifts** — **New shift** (what, when, where, how many; role,
  instructions and link under *More details*), **Add volunteer**, then
  **Notify everyone** (email + text). Without email/text connected the
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
  the day *Here* / *No-show*. *Split the rest evenly* places everyone not
  placed yet. Drag a card back to the left to take them off the shift —
  *Undo* puts them back where they were.
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
  the city view shows patches of people instead — grey for how many live
  there, colour for the share rated — and **Show** counts people in view
  (*300,049*); zoom in and it loads the doors where you're looking.
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
  long note (a link) wraps in Knows.
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
  star ($1K+/yr or $100+/mo), superstar ($3K+/yr or $250+/mo).
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
- **Today → More → Verify the records** replays the tamper-evident log;
  **Export all data** downloads everything.
- **Donations and People with no signal** read only in the same browser tab
  (money and donor lists are never kept past the tab): close the tab, reopen
  with no signal, and Donations says *No signal*. Make a volunteer a treasurer
  while their app is open: Today's money stays in their tab; make them a
  volunteer again and, after a reload, nothing a treasurer saw is kept.

### Import your own lists
**People → More → Import & export → Import people** (or People → More → Import). A CSV or an **Excel workbook (.xlsx)** both work — save a sheet from Excel or Google Sheets as .xlsx and choose it: its first sheet comes in, columns matched. Try `samples/surrey-import-test.csv` first —
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
Then **Place on map** looks the addresses up with the BC Address
Geocoder (needs internet). It runs on the server: you can close the page and
it keeps going (come back to Import or the map to see how far it's got, or
**Stop** it). Everyone at one address is one lookup, and an address already
on the map is copied without a lookup. If the geocoder stops answering, the
run pauses with the reason; **Carry on** resumes it. Addresses it can't find
end up under **Not on map** for a pin by hand.

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

**Time-zone rules.** B.C. stays on UTC-7 all year from March 2026. Starbase
needs a Node 22 new enough to know that, or every time after Nov 1, 2026
shows an hour off. It checks at startup: an out-of-date server logs a
warning, shows a banner on the manager's Today, and reports
`"tzdataCurrent": false` on `/api/health`. Fix it by redeploying with a
newer Node 22 image (the Dockerfile uses `node:22-alpine`, which pulls the
latest).

---

## 4 · Known limits in this build

- Map tiles come from OpenStreetMap; very large teams should switch to a paid
  tile provider before election week: Google Maps (`GOOGLE_MAPS_TILES=1` and
  a `GOOGLE_MAPS_SERVER_KEY` with the Map Tiles API enabled) or any
  `{z}/{x}/{y}` provider (`STARBASE_TILE_URL`) — see the README.
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
