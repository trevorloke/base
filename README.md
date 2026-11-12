# base.win

**base.win** is one product for a campaign: its people, map, field, money,
outreach and website in one place — built first for **Imagine Surrey**
([ROADMAP.md](ROADMAP.md)). `server/`, `web/` and `shared/` are base.win (this
README); the website is one of the desk's areas, like People or Donations
([SITE.md](SITE.md)).

Each client runs on its own server and database, behind one front door at
base.win (`apps/door`; [setting it up](apps/door/README.md)):
`base.win/<client>` opens the campaign's public website (`/<client>/site/`),
`/<client>/field` is the volunteers' app and `/<client>/desk` the office's.
The server goes under a client's path with `BASE_PATH=/<client>` (and keeps
answering at its own address); unset, it runs at a site's root as it always
has. An old `/<client>/admin…` link goes on to `/<client>/desk…` on the
address it was opened at, never the server's own. Internal names — the
`STARBASE_*` settings, package names, the database — are unchanged, so
nothing deployed moves.

`apps/web` is Imagine Surrey's website as it runs today (Next.js, [its
README](apps/web/README.md)), until its pages move into base.win. It came in
with `git subtree` from its own repository; work done there comes in with:

```sh
git subtree pull --prefix=apps/web https://github.com/trevorloke/ImagineSurreyWebsite main --squash
```

## Two apps: the field app and the admin

One build, two apps, told apart by the address:

| | Address | Who | What |
|---|---|---|---|
| **Field app** | `/` | everyone — it is what a volunteer sees and uses | Today · Map · Calls · Shifts · ImagineU, the door card, walk lists, your call lists, your people, your texts. A manager who opens it gets exactly a volunteer's screens (and *Admin ↗* in the account menu). |
| **Admin** | `/admin/` | managers, staff, treasurers — and a volunteer given an area under Permissions | everything: the dashboard, the map with turfs, People and imports, Shifts, Donations, Signs, Outreach, ImagineU's editor and Progress, phone banks, **Settings** (members, teams, permissions), the rating scale. A plain volunteer who opens it is told it isn't theirs. |

Signing in sends each person to their app: a desk role to the admin, a
volunteer to the field app. A desk address typed into the field app
(`/people`, `/money`, an old bookmark) goes to the admin.

## The seven things a campaign does (the whole tab bar)

Every screen is built to [SIMPLE.md](SIMPLE.md): one job per screen, one yellow
button, no paragraphs, everything else one tap away.

| Screen | What it is |
|---|---|
| **Today** | Managers: the **dashboard** — every team's contacts, the chart over time, and the map of who is out where. Desk: three big numbers (doors · support · raised) and *Needs you* (with the requests from the doors canvassers sent with *Ask the office*); under *More*, **GOTV & voting days** — GOTV mode, and how many supporters have voted, by band and by turf. While GOTV mode is on, everyone's Today opens with the day's job: *N of M supporters have voted · K to go*, *Call who hasn't voted* and *Map: who hasn't voted*. Volunteers: one big *Start canvassing* and their next shift. Everyone: **Follow up** — the new volunteers, website messages and new RSVPs handed to them (speed to lead: whoever knows them, else their turf's organizer, else a manager), each with a 24-hour clock, one tap to call or text, closed by logging how it went |
| **Map** | Field mode. Houses as clickable pins; tap a door → rate, log, request a sign, call/text. *Show* filters by band, by 1s or 2s on their own, and by each opponent on the Voting-for list (*Voting Locke*); its **Signs** chips show signs up and sign requests together (requests a pale flag, a billboard a bigger one) and narrow them by status and kind. Turfs and walk lists; **passes** — a sweep over every turf with a purpose (persuasion, get out the vote, lit drop, find out who's who), a universe (who to knock) and a try rule, so a *No answer* door comes back (*Try again · 1 of 2*) until it's given up. With GOTV mode on, every door card, walk-list door and Calls card has a one-tap *Voted ✓* (offline too, sent once), and a get-out-the-vote pass drops a door once everyone there has voted; a voted file from the campaign's website comes in through People → Import |
| **Scripts** | What to say at the door and on the phone (`/scripts`, desk): shown as *Script* above the rating buttons on the walk list, the door card and Calls, the voter's and the canvasser's first names filled in, kept on the phone |
| **People** | Everyone, filterable by rating / tag / role / the campaign's own fields, and by the field's cuts (never knocked or not in 7–30 days, the last outcome, a turf, a postal code, without a tag, what they did on the website — saved lists, blasts and Calls keep them); profiles with socials, roles, gifts, history, *More details* and who they know; **Calls** works a list one person at a time; **My people** is each volunteer's own circle |
| **Shifts** | Schedule volunteers, assign by role, notify by email + text with instructions and a link; volunteers tap *Count me in*; a shift can carry turfs; *Count me in* puts the walk list on your phone; the desk can *Edit* a shift (moved in time or place → *Let them know*) or *Call off* one, which takes back the walk lists it gave. Each shift has a **crew board**: drag volunteers on from a tray (free or busy then, asked to volunteer, new), onto its turfs — each person gets only their turf's walk list — or *No walk list*; team lead and driver; *Here* / *No-show* on the day; *Split the rest evenly*. **Shifts → Volunteers** is the roster: asked to volunteer, new, active, lapsed, by role; call, text and *Put on a shift* in a tap |
| **Donations** | Gifts (one-time / monthly), each to one slate — city council or school board — with the entity-keyed cap engine (the annual limit is per contributor per slate); receipts; donor tiers — the only money base.win tracks |
| **Signs** | Billboards (4×8), large (4×4), lawn — requested → installed → removed |
| **Lists** | Saved filters (a tag, a rating band, a role, has an email…) and hand-picked lists of people: an audience for an email or text blast, a CSV, a report; People's *Save as a list* starts one |
| **Reports** | The campaign in numbers (people by rating, tags, cities, people added by week, contacts by week, donations by month, the newsletter list, sends), each downloadable as CSV; any table as a spreadsheet; the full JSON export; Field, by turf (coverage, talks, support found, not-homes; by canvasser; CSV) |
| **Website** | The campaign's public site (managers, and whoever is granted the Website area): pages built from sections (hero, text, petition, donate, events, news…) that are added from a catalogue, dragged into order, hidden, edited in plain forms and published — the draft saves itself, *Preview* shows it, *Publish* says exactly which section needs a look; the theme (colours checked for contrast as they're picked, fonts, corners, logo); the menu, footer, announcement bar, search and sharing; news posts; petitions and pledges with their signatures. SITE.md has how it fits together |
| **Path to win** | Today → More (desk; the Data area). Each race's win number — typed in, or worked out from eligible voters × expected turnout × share needed, the campaign's own numbers (managers set them) — and the supporters to find for it; supporters found (rated 1 or 2) against that, the pace a week to election day (GOTV's, else one set here) beside the last 4 weeks', a 12-week trend from the ratings, and the turfs ranked by a score out of 100 whose parts are shown (supporters still to find = doors not yet knocked × supporters per 100 doors knocked; persuadables left; time since the last knock), on a map coloured by priority and in a list — tap one to open it on the main map. Counted in SQL, kept a minute (`STARBASE_PTW_CACHE_MS`) |
| **Outreach** | Two modules. **Email** (like Mailchimp): *Write an email* to the newsletter's subscribers or to any list, in Markdown (headings, bold, lists, links, pictures; files attached; *Send me a test*; two subject lines to test), then what went out — opens, clicks, past sends — the subscribers, and ladders (automatic emails, texts and follow-ups, started by what people do on the website, a shift booked, came to or missed, a gift, a membership, a survey; a goal — came to a shift, gave, joined, voted — takes them off). Ladders → Follow-ups: every open follow-up by organizer and the time to first contact. **Texting** (like CallHub): *Write a text* to any list, with the one-to-one rules (quiet hours, STOP, do-not-contact); the Inbox of replies; phone banks; texting one by one; texting settings |
| **ImagineU** | Training for every role: courses of modules, each module a mix of materials — notes, documents, videos, audio, pictures, links — and the marker of progress: ticked *Done*, counted per course (*2 of 5 modules done*); the desk edits in place and sees who has done what; a module marked public has a page anyone can open at `/learn/<slug>` |

Volunteers get five tabs — **Today · Map · Calls · Shifts · ImagineU** — plus
*Signs to put up* for sign crews; desk-only addresses send them back to Today.

**One campaign per deployment; setup is one-time.** Each client runs on
its own services and database. The deployment names the campaign and its
rules (`STARBASE_ORG_NAME`, `STARBASE_JURISDICTION`, `STARBASE_TZ`,
`STARBASE_CITY`, `STARBASE_SLATES`, `STARBASE_CANDIDATES` — see *Run*);
the first person to open `/signup` sets it up (name, email, password; the
campaign's name too, when the deployment left it blank) and becomes its
manager. After that sign-up is closed (`POST /api/auth/signup` → 403) and
Sign in hides the link; `GET /api/auth/setup` says which (`{ open,
organization, org }` — `organization` is the campaign's own name once it's
set up). `STARBASE_OPEN_SIGNUP=1` keeps it open — the test
suite sets it, since tests make several workspaces to check they stay
apart. `STARBASE_ENV=staging` puts a *Staging* badge on every screen and
in `/api/health`, so a test environment is never mistaken for the real one.

Managers reach **Admin** from the account menu (their initials):
- **Members**: invite volunteers and staff by email (or copy the join link
  and text it), set roles, see pending invites, and remove someone who has
  left (they are signed out everywhere at once; what they did stays on the
  record; a new invite lets them back in). Invitees open `/join/:token`, set
  a password, and land on the map (volunteers) or Today.
- **Teams**: groups of members (a neighbourhood crew, the phone bank) with
  a lead; a whole team goes onto a turf in one go (Map → turf → Add a
  canvasser → Teams). Someone removed from the campaign leaves every team.
- **Permissions**: the app is nine areas — People, Map & turfs, Shifts,
  Donations, Signs, Outreach, Data, Admin, ImagineU. Each role has its usual ones
  (`server/lib/perms.js`); a manager can take an area from a whole role or
  give one to a single person on top of their role (a volunteer who runs
  Outreach, a staffer kept out of Donations). The server decides on every action
  and read, and the app shows a person the tabs of the areas they have.
  Managers always have every area. **Volunteers' map** (same page): *Every
  door*, or *Only their turfs* — then a volunteer's phone gets only the doors
  and signs inside the turfs they walk (and their own record); the rest never
  reach it, kept copy included. A volunteer given Map & turfs sees every door.
  Call lists are scoped by phone banks, not by this.
The same menu has **Rating scale** (below); People → More has **Profile
fields** (managers), **Most connected** and **Duplicates** (desk).
**Duplicates** lists two records that look like one person — the same
email, the same phone and name, the same name at one door, or a donor and
the same first and last name in one postal code — side by side. *Keep this one* merges the other into it: its contacts, gifts and
receipts, shifts, signs, lists, answers, relationships, texts and requests
move over (where both had the same — one shift, one list — the kept one's
stays), its blanks are filled and tags joined, and an old link to it says
*Merged — open their record*. A donor made one is checked against the limit
again, and the line after *Merge* says when they are now over it — even when
a gift on the two was already flagged as possibly one donor — or only maybe
over, together with another record that may be them. The record kept takes
on the other's *Not the same* rulings, and when the merge clears a maybe
with a third record only the other one matched (a phone or address the kept
record doesn't have), the line names that record by what it shared, with a
link to it, to check. *Not the same* keeps a pair away, and a gift flagged
as possibly one donor on the two is added up again without the other.

### Two-step sign-in

Anyone can turn it on for themselves in **Your profile** (the account menu's
first item, in either app): scan the QR code with an authenticator app (or
type the key, or on the phone itself *Add it to an app on this phone*), type
the code it shows, and keep the ten **recovery codes** shown once (copy or
download) — each signs in once if the phone is lost. Sign-in then asks for
the code after the password; a code works once, five tries send you back
to the password, and ten tries in 15 minutes make the person wait (each try
counted as it comes in, so codes sent all at once don't get more). Wrong
codes also add up for the account, across sign-ins and restarts, until a
right one: twenty in a row lock the codes from the app — the answer says
so, the lock is on the event log, the person and the campaign's managers
are emailed, and the managers' Today and Settings → Members show it until a
recovery code (which still signs in) or a manager's reset unlocks it.
*More* makes new recovery codes or turns it off (each with a code).
Turning it on signs that person out on their other devices.

A manager can **require it for desk roles** (Settings → Members — their own
must be on first): every manager, treasurer and staffer — and every
volunteer given an area under Admin → Permissions (their own or their
role's), since the area opens the desk to them — then sets it up at
their next sign-in — or on their next tap, if already signed in — before
anything else (the server answers nothing else meanwhile). Other volunteers
sign in as before unless they turn it on. Someone who lost their phone: the
manager taps **Reset two-step** on their row — they're signed out everywhere
and sign in with their password (setting it up again where it's required).
The campaign's only manager, with neither phone nor recovery codes — or
someone who belongs to another campaign on the same server too, which one
campaign's manager can't clear — on the server's shell (Render → the service
→ Shell), `node scripts/reset-two-step.mjs their@email` does the same.
Turning it on or off, new recovery codes, a recovery code spent at sign-in,
a lock, a reset and the requirement are on the event log (nothing secret in it).
Keys are sealed with `STARBASE_TWO_STEP_KEY` (INTEGRATIONS.md); the tables
(`server/ext/twostep`) are never in the export. The how: `server/lib/twostep.js`.

### The command bar

On the desk, **Ctrl+K** (⌘K on a Mac) or **Search** in the header opens one
box: type to jump to any screen you may open, find someone by name, email or
phone (typed any way: *604 555 0142* finds 604-555-0142), or start a common
job — *Add person, Log a gift, Enter a membership form, Draw a turf, New
shift, Write an email, Write a text*. ↑ ↓ and Enter, Esc to close; it offers
only what your areas allow (`web/src/components/commands.js`). People come
from a quick search on the start of a name or last name, a whole email or a
phone's digits (`server/ext/search`, indexed: a few milliseconds on a
300,000-person file, against about a second for People's search of every
row), then People's own search when that finds nobody. People's search box
now matches a phone's digits however it was typed, too.

### The rating scale (door, phone, text)

`1` strong support · `2` lean support · `3` undecided · `4` opposed (unknown) ·
`4D` McCallum · `4B` Surrey Connect / Locke · `4F` Surrey First / Annis ·
`4N` SurreyNow / van Vliet · `4C` Surrey Conservatives / Randhawa
(`shared/canvass.js` — one vocabulary for server validation and the UI).
On screen the buttons read *1 Strong yes · 2 Lean yes · 3 Undecided ·
4 Opposed*; tapping 4 asks *Voting for?* with the five surnames or *Not sure*.

These are the defaults. A manager changes the words on each step and the
*Voting for?* list under **Rating scale** (account menu) — add, rename,
reorder, take off, put back — with a preview of the buttons volunteers will
see. The four steps never change, so counts, filters, ladders and the map
read the same. A code keeps its meaning forever: someone taken off the list
keeps their old ratings ("4 · Locke (off the list)") and is never offered
again. A knock tapped on a phone while they were still offered still counts,
however late it arrives (the phone sends when it was tapped); one tapped more
than a week after they came off is refused. Contacts are door, phone, text or
**in person**.

### What's tracked

- **Signs**: billboard, large, lawn, with status and location.
- **Donors**: one-time, monthly, **star** ($1K+/yr or $100+/mo), **superstar**
  ($3K+/yr or $250+/mo) — derived from real gifts, never self-declared.
- **Volunteer roles** (20): driver, scrutineer (+voting place), runner, poll
  greeter (+voting place), doorknocking, mainstreeting, phoning, data entry,
  event hosting, zone house captain, hi-rise building captain (+building),
  food, translation (+language), burmashave, community committee (+area),
  policy, administration, candidate aide, social media team,
  photography / videography.
- **Tags**: free-form, seeded with media, VIP, endorser, host, …
- **Socials**: per-person handles for Facebook, Instagram, X, TikTok, YouTube,
  LinkedIn, Bluesky.
- **Stewardship** (Donations → *Stewardship*, the desk that handles money):
  *To thank* — every gift no one has thanked, oldest first, with how long it
  has waited; *Called · Emailed · Note · Letter* marks it.
  *Next steps* — one per donor with a date (*Coffee after the debate*), the
  due ones first. *Lapsed* — gave in an earlier year, not yet this one.
  *Top donors this year* — and when each was last thanked.
- **Membership form** (People → More → *Enter a membership form*, the desk
  that handles money): the paper membership form, box for box and in its
  order. Name, gender, birth date, email, mobile, address; citizen or
  permanent resident; union member (+local); campus; volunteer, candidate
  interest, a sign (lawn, window, large, billboard); languages (one not on
  the list goes in *Other language*); interests; a 1- or 4-year membership;
  giving once or monthly — Superstar Club and Star Club amounts come from
  the year's contribution limit (2026: $1,429.70 a slate); cash, cheque,
  credit card, e-transfer or pre-authorized debit; the signed declaration
  and its date. While the name, email or phone is typed, people already on
  file are offered (*That's them* · *Not them*). *Save the form* does it all:
  the person and their profile fields, a membership (the $5 youth rate when
  they were 14 to 30 on the day signed; a renewal starts when the current
  term ends), the gifts on the right slates (Superstar splits across both),
  a monthly pledge and its first month, a volunteer request, a sign
  request, and the email/text opt-in (never re-adding someone who left the
  list). It says what to check (below the minimum, over the limit, nothing
  ticked for citizenship) and who entered it, for the form's *Office use*
  box. Card numbers and bank details are never typed — black them out on
  the paper. A website membership (the website tags it *Member (joined
  online)*) is a membership too, and **Data → Take data out → Members** lists
  both, current or lapsed.
- **Mainstreeting** (Today → *Mainstreeting*, everyone on the field
  team): meeting people where they are — an event, a bus loop, a market.
  Say where you are once (kept on the phone); then for each person first
  and last name, phone, email, postal code, how they lean, a note, *Wants
  to volunteer* and *Newsletter*; *Save · next person*. It works with no
  signal (sent once when it's back). Someone already on file is found (by
  name and phone; the desk also by email — a volunteer never on an email
  the campaign holds) and not doubled; anyone new is tagged
  *mainstreeting*. Each is a contact of its own channel, *Mainstreeting*,
  with the place — on the profile's history, in Reports (*contacts by
  week* has a Mainstreeting column; the contacts spreadsheet has the
  place) — and *Wants to volunteer* is a request for the desk.
- **First, middle and last names**, kept apart the way the campaign's lists
  keep them (First Name · Surname): *Add person* and a profile's *Edit* ask
  for all three, *+ Door* and *Add someone at this door* for first and last;
  an import keeps them as the file has them (a *Middle name* column too);
  the website sends `first_name` / `middle_name` / `last_name`. The whole
  name every screen reads follows them, and a whole name given alone is
  split first · middle · last (*Ana Maria de la Example* → Ana · Maria ·
  de la Example — a van, de, von… stays with the last name). A first name
  with a second word or an initial (*Mary Anne*, *John A.* — not
  *Mary-Anne*) goes to Middle name: by itself when you leave the First name
  field (with *Undo — it's part of the first name*), as a suggestion on a
  record already on file, as a ticked option in an import, and
  automatically from the door, mainstreeting and the website. An
  organization keeps one name. The People spreadsheet has first, middle and
  last, and the street apart from the house number.
- **A list from a past election** (Import → *From a past election*, with its
  year): nothing in it becomes today's. Ratings come in as tags with the
  year (*Strong support 2022*, *Voting Locke 2022*, *Opposed 2022*), and so
  do signs (*Lawn sign 2022*), voted (*Voted 2022*), volunteer and donor,
  roles (*Doorknocking 2022*) and talks (*Talked 2022*). Someone already on
  file keeps today's rating. Names, phones, emails and addresses come in as
  usual. Its profile-field columns are listed with a tick each: ticked, the
  value is a tag with the year (*Support 5 2022*; a Yes/No field's yes is
  *Sign 2022*, a no nothing), otherwise the field as it is — Yes/No, Number
  and Pick-one fields start ticked, text and dates (notes, a province) not.
- **Profile fields**: the campaign's own — Text · Long text · Yes/No · Pick
  one · Pick several · Number · Date (*Language at home*, *Strata council
  member*, …) — set up by a manager,
  filled in by the desk under *More details* (read-only with no signal),
  filtered, imported (column names in any script) and exported; volunteers
  see only the ones marked for them, read-only. Every campaign starts with
  Imagine Surrey's **standard fields**, named for the list's own columns so
  an import maps them by itself: Home phone, Province, House notes,
  Building notes, Access type, Dwelling type (those four shown to
  canvassers), Interaction status, Interaction date, Organizer, Email
  opt-in, SMS opt-in, Sign, Support (the list's 1–5, kept apart from the
  rating scale) and Voted — and **Voter eligibility** (Eligible ·
  Ineligible), **Language** (Pick several: English, Punjabi, Hindi,
  Mandarin, Tagalog, Cantonese, Urdu, Arabic, Korean, Spanish, Gujarati,
  Vietnamese — a starting list the desk can change) and **Notes** (Long
  text, up to 4,000 characters, its lines kept). *Profile fields → Add the
  standard fields* puts them on a campaign set up before they existed (the
  last three were added to every campaign once, by themselves; one renamed
  or taken off is never put back). The People export has a column for each
  profile field, named as the field (Pick several as *Punjabi; Hindi*), so
  it imports straight back. Every person has a
  **House number** of its own, apart from the street (the door card, the
  profile and *Add a person* ask for both; the address line reads 13450 104
  Ave, and a number typed into the street is split out). The import takes a
  **House number** column the same way, **Latitude
  / Longitude** (a pin, only where there is none), and **Volunteer / Donor**
  1/0 columns (the tags); yes/no fields and the flags read 1 and 0, yes and
  no, true and false, and a database export's t and f; a rating column
  rated some other way (a 1–5) is mapped value by value under *What each
  rating means on your scale* (a 5 there can be a 1 here); dates come in as
  spreadsheets write them (10/21/2026, 21 Oct 2026). A **House Unit**
  column is the unit; a **Home Phone** column fills its field and is the
  number to call for anyone with no mobile; and a phone number Excel has
  cut short (1.6047E+10 — its last digits are gone) is never imported:
  the column says so, and how to save it again. Tags that name a volunteer
  role (*Vol: Door Knocker*, or anything in a Tags column headed
  *Volunteer…*) are listed under *Volunteer roles*: choose the role each
  is (Door Knocker → Doorknocking is guessed; GOTV is left a tag until you
  say), and those people get it, as if added on their profile — never twice.
  A list's own history comes in too: under *Past conversations* say what
  each *Interaction Status* was (Not Home → not home at the door, Spoke →
  talked; a call's outcomes too), and it becomes that day's knock or call —
  on the map, the field report (*From an imported list*) and their history.
  Under *Signs* say what the Sign column means (a lawn sign to put up, or
  one that's up; a plain Yes stays a profile field until you say). Neither
  is ever doubled by importing the file again.
- **Fix details** wherever you meet someone — under the phone on the door
  card, on the Calls card and on the profile: a name, a phone, an email,
  saved through the offline outbox like a knock. Any role; a volunteer may
  add an email only where there is none (they never see one on file — the
  card says *On file*), the desk may change any.
- **Phone banks** (People → More, or Calls → Phone banks): a named list of
  numbers to call, made from the people list (a rating, a tag, a search —
  everyone with a phone who matches, never do-not-contact), with a script.
  The desk hands numbers to a caller, or splits them across a team, takes
  unfinished ones back, closes the bank. A caller's *Your call lists* (on
  Calls) opens each bank on the Calls card, script and all; a phone call
  they log crosses the number off, *Skip* crosses one off without a call.
- **ImagineU** (a tab for every role): the campaign's training. **Courses**
  of **modules**; a module opens with words (Markdown) and a file or link —
  a note, a document (PDF, Word, PowerPoint, Excel), a video (a YouTube or
  Vimeo link, or a short MP4), audio (MP3, M4A, WAV), a picture, contacts or
  a procedure — then holds **more materials** in order (*+ Video*,
  *+ Document*, *+ Audio*, *+ Picture*, *+ Link*, *+ Note*; files 12 MB at
  most). The module is the marker of progress: everyone ticks *Mark this
  module done*, each course shows *N of M modules done*, and the desk edits
  in place, chooses who sees each module (everyone signed in · the desk ·
  public — a page of its own at `/learn/<slug>`, its materials too) and
  reads *Progress*: who has done which. Files are served to those who may
  see the module and are not in the export (the materials' records are).
- **The dashboard** (managers, at the top of Today): contacts today, in the
  last 7 or 30 days or in all — how many, doors, calls & texts, people
  reached, support, canvassers, who is out now; a bar per day (per week on
  *All time*) stacked by outcome, Grouped and Table views; **In the field**,
  a map that stands portrait, as Surrey does, and opens on the whole city
  (the Fraser to the border, Delta to Langley) — the period's contacts (a dot at the door, coloured by outcome;
  tap one for who, the outcome, who logged it and when, with the profile
  and the map a tap away; tap a turf for its name and the map) and everyone
  who has canvassed as their initials (tap one for their day and *Only
  their contacts*) — a ring and *out now*
  while they share their location, grey at their last door otherwise — pick
  a person for their trail (today) and their numbers; **By team**, each
  team's contacts and outcomes and how many of its members are out; the
  latest twenty contacts. It refreshes itself every minute.
- **Share my location while I'm out** (the map's *Show* sheet, any role):
  off unless the person turns it on; while it's on, their phone tells the
  server where they are about once a minute or every 25 m (`field.ping`),
  and managers see them live. Off takes them off the map at once; a trail
  is kept for the day and a position only while they share it. Pings are
  not on the event log and not in the export.
- **Relationships**: who knows whom (Family · Friend · Neighbour · Work ·
  Community · Other), *brought in by*, and each volunteer's **My people** —
  add someone you know, call, text, or rate a talk in person. A profile's
  *Knows* nudges the desk ("Ask Priya Nair — they know each other"; never on
  a do-not-contact profile) and *Most connected* finds the connectors. A
  volunteer's add never matches on, or takes, an email the campaign holds, so
  a possible double is flagged to the desk (*May be the same person as …*).
- **Lit drops**: *Left lit* is its own outcome (`left_lit`) — literature
  left at a door, a visit and not a conversation. The walk list's *Left
  lit* logs it for everyone at the door in one tap (no rating asked; saved
  on the phone with no signal and sent once), and the map's door card
  offers it for the person picked, at the door only (never on a call, a
  text or the Calls card). It finishes the door like a knock but is never
  *Reached*: Today's *More* counts the doors lit this week (yours and the
  team's), Reports → *Contacts by week* has a *Lit* column, the dashboard
  colours the drops apart, and a profile's History reads *Left lit*.
- **Import & export** (People → More → *Import & export*, the Data area):
  one page for both. **In:** People from a CSV or an **Excel workbook
  (.xlsx — its first sheet; dates read as dates)**, from any spreadsheet, a
  voter file, or another tool's export (Mailchimp, NationBuilder, VAN and
  the like): the columns match themselves, nothing is saved until the
  check, and the same file twice adds no one twice; a voted file the same
  way; the website's sign-ups through its key. **Out:** each table as a
  spreadsheet — people (with *voted*, and it reads straight back in),
  contacts, gifts, volunteers and their roles, signs, shifts, subscribers,
  lists — and everything in one JSON file for a backup or a move.
- **GOTV mode** (Today → More → *GOTV & voting days*, managers): list the
  advance-voting days and election day, and GOTV mode turns itself on for
  each of them in the campaign's day (or on by hand, any day). While it's
  on: everyone can mark people *Voted ✓*; the **GOTV scripts** (Scripts →
  *Get out the vote*: door and phone) are said instead of the usual ones;
  Today opens on the supporters who still have to vote, the desk's map on
  *Yes, not voted*; People and Calls filter *Voted: Not voted yet*
  (`voted=no`, also on lists, blasts and phone banks); and *Ask the office*
  offers *Needs a ride to vote*, a request for the drivers. Shift roles
  include Driver, Scrutineer (a voting place), Runner, Poll greeter and Zone
  house captain.
- **Left message**: the phone's *Left lit* (`left_message`) — a voicemail,
  or word left with whoever answered. The Calls card offers it on a call
  (never a text, never at the door). It is not a talk; in a phone bank it
  finishes the number, so nobody gets a second voicemail from the next
  caller. The dashboard colours it apart; History reads *Left message*.

## Coverage vs. the tools it replaces

| | base.win today | Next |
|---|---|---|
| **Ecanvasser** | map canvass, door cards, household grouping, ratings, no-answer outcomes, signs at the door, place-on-map, call/text lists, turf cutting & assignment, walk lists, survey builder (door and calls), custom person fields, offline field mode, offline desk (each sign-in's last copy of every screen, money and donor lists in the tab only; ratings, notes and tags queued; one outbox across tabs) | — |
| **Action Builder** | assessments (= the rating scale, its words and Voting-for list edited per campaign), tags, roles, relational notes, relationship graph (My people, Knows with a nudge, Most connected, brought in by), event-logged every touch | — |
| **Action Network** | newsletter list + unsubscribe, press list + releases, email blasts and texts to lists, ladders of engagement, A/B subject lines with open/click tracking | the website's RSVPs and online donations (sign-ups, petitions and volunteers come in through `/in/v1/people`) |

## Public pages

The campaign's website lives elsewhere. Its server sends sign-ups,
petition signatures, volunteers and newsletter opt-ins in through
`POST /in/v1/people` with a website key a manager makes under Settings →
Services (`server/ext/intake`; the fields and answers are in
INTEGRATIONS.md, *The campaign's website*): matched only by the same
email (a visitor's typing never lands on someone else's record), never back
on the newsletter for someone who left it, a volunteer or a message filed
as a request under *Needs you*; the answer is only the person's id. Donations and RSVPs aren't
taken that way. base.win's own public pages are the ones every email needs,
no login:

- `/u/:subscriptionId` — unsubscribe from the newsletter (the link asks; one
  tap on *Unsubscribe* does it, so mail scanners never unsubscribe anyone)
- `/bu/:recipientId` — unsubscribe from an email blast to a list (the
  address is marked do-not-email everywhere)
- `/lu/:runId` — unsubscribe from a ladder's emails
- `/r/:token` — a donation receipt
- `POST /stripe/webhook` — Stripe's payment events, signed (INTEGRATIONS.md,
  *Online payments — Stripe*)
- `/learn/:slug` (and `/learn-files/:id`) — ImagineU's public lessons
- `/media/:id`, `/o/…`, `/c/…` — pictures in emails, and the open and click
  counts
- `/brand/:id` — the campaign's brand pictures (the same bytes as
  `/media/:id`, at an address the service worker keeps for no signal)
- `/api/public/twilio/…` — Twilio's webhooks, signed (INTEGRATIONS.md)

The pictures, the three unsubscribe links and the Stripe and Twilio webhooks
also answer on the campaign's website domain (SITE.md); the others don't.

A gift is logged at the desk (Donations → Log a gift) to one slate — city
council or school board (`shared/canvass.js` SLATES) — and the annual limit
is checked per contributor per slate.

Gifts and membership dues paid online come through the website's donate and
join forms and Stripe's own checkout page (`server/ext/payments`): what no
one may give is refused before the page opens, and the donor's own limit is
checked when the payment lands (over it, refunded through Stripe and
flagged for the treasurer; over only with another record that may be the
same donor — the same name, and postal code, phone or address — logged and
flagged for the treasurer to decide, as is a cheque logged at the desk
after it; *Not the same person* on the flag keeps the records it names
apart one at a time, and the flag is checked again then and whenever a gift
on the other record leaves the books or comes back); each
payment becomes a gift through the same path as the desk's, marked online,
with its receipt; a monthly gift is a pledge, each month its own gift.


## Placing people on the map (geocoding)

Addresses are looked up with the BC Address Geocoder (`server/lib/geocode.js`;
`GEOCODER=bc|google|nominatim|off`, `BC_GEOCODER_KEY`, `GEOCODE_MIN_SCORE`).
Google's Geocoding API is the other option (`GOOGLE_MAPS_SERVER_KEY`, a key
with only that API enabled and restricted to the server's IP; lookups are
biased to Surrey and limited to BC, and only a rooftop or street-number
match counts). `GEOCODER_FALLBACK=google` keeps the free BC service first
and asks Google only for addresses it can't place. **Place on
map** starts a background run (`server/ext/geocoding`, a job like ladder
emails): rounds of 120 people, one lookup per address (a household shares
it), pins already on file at the same address copied, `GEOCODE_CONCURRENCY`
lookups at once (default 6). A lookup that fails while others work is tried
3 times, then set aside for a pin by hand; a round where every lookup fails
counts as an outage (nobody's tries are spent), backs off
(`GEOCODE_BACKOFF_MS`, default 30 s × rounds in a row) and after 5 such
rounds pauses the run with the reason. `GET /api/geocode/status` reports
progress; the page shows it and works out the time left. With
`STARBASE_JOBS=off` the page falls back to looking up batches itself.

**Typing an address** (`server/ext/addresses`, `web/src/components/AddressField.jsx`):
the map's *+ Door*, People → *Add person*, a profile's *Edit* and *Add a sign*
share one Address box. From the third character it offers up to five doors
(`GET /api/address/suggest`): the campaign's own doors that match first,
then the address service's (BC's autocomplete, or Google/Nominatim — only
real civic addresses, in the campaign's box). A pick fills the address, unit,
city and postal code and drops the pin there (the map goes to it); a typed
address nobody picked is looked up when it's saved. A person saved with an
address and no pin anyway (a few at a time — an import is the background
run's) is placed just after the save: a pin copied from a door on file at
that address, or the geocoder's; one it can't place is set aside for a pin by
hand. Fixing an address puts the person back in the queue. With no signal
the box is a plain field and the pin is a tap. `GEOCODE_ON_SAVE=off` turns
the lookup on save off.

## Sending email and text

A newsletter or press release is written in Markdown: the message field
has the editor's toolbar (bold, italic, heading, link, list, picture) and a
*Preview* that is the email's layout. A picture is kept in the database and
served at `/media/:id`, cached a year. Up to five files (PDF, pictures, Word, Excel, PowerPoint, .ics,
.txt, .csv; 5 MB each) go with every copy; *Send me a test* emails the
writer a copy first, untracked and off the record. Each email carries a
plain-text part alongside the HTML.

**Emails and texts to a list.** Outreach → Email → *Write an email*, *To* a list, sends to a
list (Lists: a saved filter or a hand-picked list): everyone on it with an
address who may be emailed — never do-not-email, do-not-contact or an
address that unsubscribed — each copy with its own unsubscribe link
(`/bu/<recipient>`, which tags the address do-not-email). Outreach →
Texting sends one text to everyone on a list with a number that can be
texted, through the campaign's Twilio number, by the one-to-one rules:
never a number that replied STOP, do-not-text or do-not-contact; the
campaign named in the text; "Reply STOP to opt out" on each; inside quiet
hours (a text sent at night waits, and the send job sends it when texting
opens); each filed in the Inbox as the sender's conversation, so replies
and STOP land where the desk reads them. Managers, staff and treasurers
(the outreach area) send; volunteers never. Confirm bulk texting with
counsel before the first send: the texting module was built for
one-to-one texts, and election texting rules are the campaign's to meet.

Set `STARBASE_PUBLIC_URL` (e.g. `https://starbase.imaginesurrey.ca`) so links
in outbound mail — newsletter unsubscribe footers, invite links, the
pictures in a message — point at the public host. Every newsletter and ladder email ends with "Sent by <campaign>"
and the reader's own unsubscribe link, and carries `List-Unsubscribe` /
`List-Unsubscribe-Post` headers so mail apps show their own Unsubscribe
button. Someone who unsubscribed can only rejoin by signing up again — the
desk can't add them back. Ladder emails go only to addresses on the list as
subscribed. Shift messages render in campaign time
(`America/Vancouver` unless `settings.tz` says otherwise).

Provider-pluggable, no SDKs: `RESEND_API_KEY` (+ `MAIL_FROM`) for email,
`TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` for SMS. Without
them, blasts and shift notifications are recorded as **queued** per recipient
— nothing is lost; connect the provider and resend. A newsletter or press
send commits its list first and claims each email before it goes, outside
the campaign lock; the tap sends for a few seconds and a background send
job sends the rest ("Sending · 40 of 340"), so a big list never keeps the
person waiting and a crash mid-send leaves who got it, who might ("not
sure" — Try again, same key) and who hasn't yet (the job carries on by
itself); shift emails carry a key per
person and round, so Notify again after a crash isn't a second copy. Without Twilio, calling
and texting use `tel:` / `sms:` links (the phone's own dialer and messages)
with one-tap logging; with it, texts and calls go through the campaign's
number — from Calls, the profile and the door card alike, and shift notices
keep the same opt-outs and quiet hours (setup and the compliance notes are
in TESTING.md).

## Map tiles and offline field mode

The map draws OpenStreetMap tiles unless these say otherwise (read on each
request to the signed-in `GET /api/map/config`, so a restart applies them).
OpenStreetMap's volunteer-run servers are not for heavy use — a large team in
election week should switch to a paid provider.

| Variable | What for | Default |
|---|---|---|
| `STARBASE_TILE_URL` | tile template, `https://…/{z}/{x}/{y}.png` (`{s}` optional; an API key can ride in the query string) | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` |
| `STARBASE_TILE_ATTRIBUTION` | the provider's credit line (text and links) | the OpenStreetMap credit (none for another provider unless set) |
| `STARBASE_TILE_MAX_ZOOM` | deepest zoom the provider serves, 1–22 | `19` |

A bad value falls back to the default (and logs once); desk roles see which
tiles took on the map's filter sheet (*Map tiles: OpenStreetMap — custom
address ignored*).

**The map's look** is each person's own (Show → *Map*, kept on that
browser): *Clean* (the default on the standard tiles: CARTO's light map of
the same OpenStreetMap streets, without shop icons, parking lots or house
numbers — `STARBASE_TILE_CLEAN=off` leaves it out; check CARTO's terms for
your volume); *Standard*; *Muted* (grey streets, so the doors stand out) and
*Dark* (for night), drawn over any tiles; and with Google Maps on, its
other looks too — *Satellite*, *Terrain* (or *Streets*), each through the
same key.

**Doors on the map.** From street zoom (18) every door is a pin, with its
household and sign flags. Further out every door is a small dot in its
band's colour (support, undecided, opposed; slate grey for not asked yet),
drawn on canvas tiles so a whole voter file pans smoothly; at 16 a door
with a sign flies a little flag, at 17 a household's size is on its dot. A
tap near a dot opens that door (or zooms in, further out). Up to
`STARBASE_MAP_ALL` (5,000) located people the map loads them all at once
(and keeps a copy on the phone); a bigger list loads by the part of the map
in view (up to 8,000 at a time), and from further out as patches of people:
a grey disc for the people there, a coloured disc inside it for the share
rated. It opens fitted to where your voters live. Turfs and walk lists read
only the people inside each turf.

**Google Maps** instead: `GOOGLE_MAPS_TILES=1` with a `GOOGLE_MAPS_SERVER_KEY`
that has the **Map Tiles API** enabled (`GOOGLE_MAPS_TILE_TYPE` roadmap |
satellite | terrain). Google hands tiles out against a session, so the map
draws `/tiles/{z}/{x}/{y}.png` from base.win (signed in), which fetches
each tile from Google with a session it keeps for everyone and renews
(`server/lib/gtiles.js`, served by `server/ext/offline`), credited to
Google, up to zoom 22; the service worker keeps the ones a phone has drawn
as with any provider. Google bills per tile past its free allowance, and its
terms have their own rules on attribution and caching — check them before
election week. The service worker
keeps the tiles a phone has already looked at (about 1,500, oldest out), so a
turf viewed with signal still draws offline; it never fetches tiles ahead.

With no signal, field work saves on the phone and sends once, in order, when
the signal is back: knocks, new people and doors (staff), dropped pins, sign
requests and their Undo, and *Count me in* / *Can't make it*. The map's doors,
the Calls list, shifts and walk lists keep their last loaded copy on the
phone for a day ("Offline copy"). With signal a screen always asks the server
first, so a copy never hides a knock. Sign-out forgets them, and so does a
sign-in the server says is over. Anything the server
refuses on the way is kept and listed under the strip's "saved on this phone"
chip ("this device" on a computer) with the reason — *Try again* or
*Dismiss*.

Desk screens keep the last copy each sign-in loaded — Today, People and its
search, profiles opened, Shifts, Signs, Calls, Donations (desk roles), the Inbox —
and the strip says when it's from (*No signal · from 2:14 pm*). On a profile,
a rating with its note and tags put on or taken off save on this device and
send once; every other write says it needs signal (*Adding people needs
signal*). Copies are keyed to the person, campaign and role. They are a day
old at most (older ones are dropped when the app opens) and are forgotten at
sign-out (in every open tab), when the session ends, and when the person's
role changes. On a desk sign-in, Today, profiles, Donations and People lists (they
carry donor tags) are kept for that browser tab only; the map's doors and the
Calls list stay in the browser for a day. Wifi with no internet, or the server
restarting (502/503), reads as *No answer*: the app stays signed in on its kept
copies and asks again every 15 s. Two tabs share one outbox. Sign-out sends a
note still typed on an open card first; after sign-out nothing is saved on the
computer. A screen never loaded on this device says *No signal — this loads
when you're back online.*

## The look and the brand

The app has one look, for every campaign: a light, neutral workspace — a
sidebar on a hairline, flat cards, Inter throughout, sentence-case labels,
one focus ring, and a dark mode that is dark, not a darker brand — in which
the campaign's logo and one colour do the branding. The campaign leads (its
logo in its own colours, or its initials on the brand colour and its name);
base.win is the small line under it, and at the foot of sign-in. On a phone
the top bar and the tab bar are light and the tab you are on is the brand
colour; a desk role with more than five places gets four tabs and *More*.
Phones keep 48px controls everywhere; a desk with a mouse gets 40px
controls and 44px table rows.

Colour has roles (`web/src/app.css`: page, card, panel, line, text, quiet,
accent, tint, side-…, inverse), and every shade is worked out from one brand
colour by one rule (`shared/brand-look.js`): the fill is the colour exactly
as chosen; the text on it, the brand as words (4.5:1) and as an edge or
focus ring (3:1), its tints and the sidebar are derived, and each pair is
checked — over 5,000 colours in `server/test/brand-look.test.js`, and on the
real screens (`e2e-look.mjs`: both built-in brands, then a manager's saved
brand — a yellow, a red, a pale pink, near-black and Imagine Surrey's navy,
each with every sidebar and an uploaded logo, light and dark). The older
variable names (`--mark`, `--paper`, `--ink`, `--navy`, `--gold`…) stay, as
aliases of the roles. Rating colours, status colours and the map's pins are
data: no brand recolours them.

A campaign starts from one of two built-in brands, set by `STARBASE_BRAND`
(`shared/brand.js`, `server/lib/brand.js`): **`imagine-surrey`** — Surrey
Navy `#003979` with marigold `#ffc72c` as the second colour, Imagine
Surrey's wordmark as the logo, training called *ImagineU* — or **`base`**,
base.win's own (indigo, no logo, training called *Training*; nothing names
Imagine Surrey), for staging and any other campaign. Both are data through
the same rule. Unset, it's worked out so nothing changes by accident:
`base` on staging (`STARBASE_ENV=staging`) or for a campaign named anything
but Imagine Surrey, Imagine Surrey's otherwise.

Once a manager saves the campaign's own brand (**Settings → Brand**;
`server/ext/brand`), that is the look, whatever `STARBASE_BRAND` says: one
colour and maybe a second, the sidebar (light, the brand colour or dark),
corners, the heading face, a logo, a logo for dark backgrounds, a square
mark and the app icons made from it (without one, the icons of the brand it
started from), what training is called and the name under the home-screen
icon (base.win until it's changed). It is kept in
the campaign's settings (`workspaces.settings.brand`); `brand.save` is the
manager's and its event carries picture ids, never bytes; `brand.picture`
takes a JPG, PNG or WebP within each picture's limits, its type and size
read from the file itself (the browser turns an SVG into a PNG first: an
SVG is never stored); `brand.reset` goes back to the brand the campaign
started from. Any colour is saved: its shades are worked out readable.

The screen (`web/src/components/BrandSettings.jsx`, a tab beside Campaign)
shows a live sample beside the form — the desk and the phone, in light and
in dark, drawn from the same shades — and says what only a person can
decide (`brand-notes.js`): a pale colour gets dark text on its buttons, the
colour darkens where it is words, it sits close to a rating's colour, or
most of a logo can't be seen where it will sit (counted from its pixels on
each ground: a warning with the remedy, never a refusal). Pictures are made
ready in the browser (`brand-pictures.js`): an SVG is drawn to a PNG, a
logo is shrunk to 1,024 px and 512 KB, the mark is padded square and the
four app icons are drawn from it. **Save** is live at once (there is no
draft: the sample is the preview). Changes not yet saved are kept for the
browser's tab, as that person's, so leaving by a link and coming back
finds them, with **Discard them**; signing out forgets them, and the next
person to sign in on that tab never sees them. A campaign still on a
built-in brand
keeps that brand's logo — the first save uploads it as the campaign's own.
**Use the website's colours and logo** fills the form from Website → Theme
(a website with its own look); **Back to …'s look** is `brand.reset`.

The server writes the brand into the app's page ahead of the stylesheets,
so it never paints in another look — signed out too, so sign-in wears it:
its shades (a block with no addresses in it), `window.__BRAND__` (the
logos, the sidebar, what training is called), the logo asked for early,
its icons, the browser's bar colours, the tab's title and the name under
the home-screen icon; the install manifest says the same. It is read once a
minute and at once after a save, and checked on the way out: colours are
six-digit hex, choices come from fixed lists, pictures are ids and words
are escaped, so nothing saved can put markup, script or CSS into a page.
The app's public pages (unsubscribe, the receipt page, a ladder's
unsubscribe, public lessons) wear it too — its logo over its name, a rule
and the button in its colour — and so do a newsletter's links (the brand
as words, 4.5:1 on white), with the logo over the letter when a manager
turns that on (a PNG or JPG, the campaign's name as its words). A new
website follows the brand until it's given its own look (SITE.md).

Inter is self-hosted under `web/public/fonts/` as one variable file per
script (Latin and Latin Extended, SIL Open Font License); Barlow Condensed
is there too, as a heading face (`--font-display`; both built-in brands use
Inter), and Montserrat is declared from the website's own file. The
service worker keeps the fonts and the campaign's logo with the build, so
the field app opens with no signal looking like itself; the logo's alt text
is the campaign's name.

## Architecture

**Five primitives** — Person (first-class table, real FKs) · Record
(schema-typed rows from one registry) · View · Action (the only write path) ·
Signal. **One event log underneath**: every mutation is one transaction —
typed table writes + event append + hash-chain advance commit together or not
at all (one exception: an email open or click is written on its recipient's
row without the campaign's write lock, and a job puts the first of each on
the log within a minute). The `events` table is the sync protocol (`GET /api/events?since=`),
the audit trail (`GET /api/audit/verify`), and the public API. `GET /api/export`
returns every campaign table (each feature's too), event log included — never
sign-ins or a link's secret token. Money is integer cents; donors are
foreign keys; the cap engine sums `SUM(amount_cents)` per `person_id` per
calendar year per slate against `cap_rules(jurisdiction, year)` — Imagine
Surrey defaults to `bc-municipal` (LECFA); the slates (city council, school
board) are `SLATES` in `shared/canvass.js`.

Database: PGlite (embedded, real Postgres) — in-memory for tests, file-backed
via `STARBASE_DATA=./data`; hosted Postgres via `DATABASE_URL` in v0.3.
Tenancy is a membership (`user × workspace × role`: manager / treasurer /
staff / volunteer). **Volunteers** can rate doors, log calls and texts, drop
pins, request signs, add a new housemate (name and phone) at a door in
their turf, and keep *My people* (the people they know: add, call or text,
or rate a talk in person). The server never shows them money (profiles return no
gifts, totals, or donor tier; Today has no money), and refuses them the gift
ledger, exports, the raw event log, the audit replay, and the subscriber,
signature, and blast lists.

**What faces the internet** (`server/lib/guard.js`): request bodies are
capped (256 KB; 16 MB for a CSV import, 4 MB for a picture); the address
a request is from is the entry `STARBASE_TRUSTED_PROXIES` hops from the
right of `X-Forwarded-For` (default 1 — one proxy, as on Render), never
what the sender wrote — behind the base.win door, the visitor's address
as the door says it, believed only with the key the door and the server
share (`BASE_DOOR_KEY`, apps/door/README.md); public writes are limited to 30 per 10 minutes per
address and sign-in to 30 tries per address and 10 failures per email per
15 minutes (two-step codes: 5 tries per sign-in, 10 per person in 15 minutes, and 20 wrong in a row lock the account's app codes); a cookie-carrying write must be the app's own (JSON, same
origin — a form on another host, even under the campaign's domain, can't
post with it; the session cookie is `SameSite=Strict`); and every answer carries
`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and a
referrer policy. The event log keeps no sign-in or invite secrets
and no image bytes.

## Run

### One deployment per client

Everything a deployment knows about its campaign comes from the
environment (`server/lib/org.js`); the code names no client.

| Variable | What it sets | Default |
|---|---|---|
| `STARBASE_ORG_NAME` | the campaign's name until it's set up: shown on sign-in and taken by the first sign-up (after that, sign-in shows the campaign's own name, which a manager can change in Settings → Campaign) | blank: the first sign-up names it |
| `STARBASE_JURISDICTION` | `bc-municipal`, `bc-provincial` or `federal` — which contribution-limit rules apply (`cap_rules`) | `bc-municipal` |
| `STARBASE_TZ` | the campaign's time zone (shifts, receipts, quiet hours, the campaign's day) | `America/Vancouver` |
| `STARBASE_CITY` | the city new addresses default to | `Surrey` |
| `STARBASE_PROVINCE` | two letters, for geocoding | `BC` |
| `STARBASE_GEO_BOUNDS` | `lat,lng\|lat,lng`, the box address lookups and suggestions are kept to (BC, Google, Nominatim) | Surrey's |
| `STARBASE_SLATES` | `code:Label,code:Label` — the slates a gift can go to, each its own annual limit | `council:City council,school_board:School board` |
| `STARBASE_CANDIDATES` | `4D:Name:Label;4B:Name` — the opposed candidates a new rating scale starts with (the desk edits them after) | Imagine Surrey's |
| `STARBASE_ENV` | `production` or `staging` — said on screen and at `/api/health` | from `NODE_ENV` |
| `STARBASE_BRAND` | `imagine-surrey` or `base` — the brand a campaign starts from, until a manager saves its own in Settings → Brand (*The look and the brand*, above) | `base` on staging or for another campaign; else Imagine Surrey's |
| `SITE_HOSTS` | the campaign's own domains (`imaginesurrey.ca,www.imaginesurrey.ca`): the website at `/` there, nothing of the app — written with a final dot too (`imaginesurrey.ca.`), it's the same domain (SITE.md) | blank: the website is at `/site/` only |
| `APP_HOSTS` | the app's other addresses on this server (`starbase.imaginesurrey.ca` once base.win is the public one): never made a website domain, so the app keeps answering there (SITE.md) | blank |
| `SITE_SECRET` | signs the website's preview and email-preference links (16+ characters) | blank: one is made and kept in the database |

Two environments per client: **staging** deploys every push to `main`,
**production** deploys the `production` branch, which the *Promote to
production* workflow (GitHub → Actions) fast-forwards to `main` once CI is
green there. `render.yaml` holds the pair for one client; another client is
another pair with its own names and values (GOING-LIVE.md, *A new client*).


Taking it live for the campaign, step by step: [GOING-LIVE.md](GOING-LIVE.md).
Every outside service (email, texting, address lookup, map tiles, hosting),
its settings and where each key comes from: [INTEGRATIONS.md](INTEGRATIONS.md);
**Settings → Services** checks each one live.

```sh
cd starbase
npm install
npm test                 # server suite, in-memory Postgres, no setup
node e2e.mjs             # browser journey against a running server (see header)
npm run build            # web → web/dist
STARBASE_DATA=./data node server/index.js   # API + web on :3200
```

```
shared/registry.js     schema registry (DDL + zod + UI hints from one source)
shared/canvass.js      ratings, channels, signs, roles, tags, tiers
server/lib/events.js   runAction: the transactional event-log spine
server/lib/cap.js      entity-keyed contribution-cap engine
server/lib/notify.js   email/SMS adapters (Resend/Twilio via fetch)
server/actions/        the Action registry (index.js core, field.js field+outreach)
server/routes/         auth · api (reads) · public (unsubscribe pages)
server/ext/site/render the public website's pages (shared/site/components, site.css; SITE.md)
web/                   Vite + React 19 + react-router + TanStack Query + Leaflet
```

⚠️ `cap_rules` is seeded with Elections BC's 2026 local-elections limit,
$1,429.70 per contributor for the calendar year (one limit for an elector
organization and its endorsed candidates together), and 2022's $1,250.
Confirm the figures with Elections BC before a filing relies on them.
