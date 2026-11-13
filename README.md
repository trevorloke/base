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
| **Today** | Managers: the **dashboard** — every team's contacts, the chart over time, and the map of who is out where. Desk: three big numbers (doors · support · raised) and *Needs you* (with the requests from the doors canvassers sent with *Ask the office*); under *More*, **GOTV & voting days** — GOTV mode, and how many supporters have voted, by band and by turf. While GOTV mode is on, everyone's Today opens with the day's job: *N of M supporters have voted · K to go*, *Call who hasn't voted* and *Map: who hasn't voted*. Volunteers: one big *Start canvassing*, under it their walk list on a map that folds away, and their next shift. Everyone: **Follow up** — the new volunteers, website messages and new RSVPs handed to them (speed to lead: whoever knows them, else their turf's organizer, else a manager), each with a 24-hour clock, one tap to call or text, closed by logging how it went |
| **Map** | Field mode. Houses as clickable pins; tap a door → rate, log, request a sign, call/text. *Show* filters by band, by 1s or 2s on their own, and by each opponent on the Voting-for list (*Voting Locke*); its **Signs** chips show signs up and sign requests together (requests a pale flag, a billboard a bigger one) and narrow them by status and kind. Turfs and walk lists; **passes** — a sweep over every turf with a purpose (persuasion, get out the vote, lit drop, find out who's who), a universe (who to knock: a rating band, and/or a List — *List to walk* on the pass's form, or a list's *Walk*: only doors with someone on it, as the list stands at each load; the list can't be deleted while the open pass walks it) and a try rule, so a *No answer* door comes back (*Try again · 1 of 2*) until it's given up. With GOTV mode on, every door card, walk-list door and Calls card has a one-tap *Voted ✓* (offline too, sent once), and a get-out-the-vote pass drops a door once everyone there has voted; a voted file from the campaign's website comes in through People → Import |
| **Scripts** | What to say at the door and on the phone (`/scripts`, desk): shown as *Script* above the rating buttons on the walk list, the door card and Calls, the voter's and the canvasser's first names filled in, kept on the phone |
| **People** | Everyone, filterable by rating / tag / role / the campaign's own fields, and by the field's cuts (never knocked or not in 7–30 days, the last outcome, a turf, a postal code, without a tag, what they did on the website), what they gave (this year · before but not this year · never · at least $X in one year), a membership (running · lapsed), their latest answer to a survey question, a shift they came to or missed in the last N days, being on another list or not, and added since a day — saved lists, sends, phone banks, passes and Calls keep them all; a volunteer never filters by money, memberships, answers, attendance or the desk's lists (those match nobody for them — and one given the People area may not save a list by them, copy a list, or make a phone bank or a pass from a list: those stay the desk's; they change only lists they made, and a list a volunteer made names who People would show a volunteer — never by a money tag, an email or a field kept from them — wherever it is used, until the desk saves its filter). The count is the real total, however many (`GET /persons/count`, asked for apart from the names; while a new filter loads the last one's rows are dimmed and the count says *Loading…*). Beside *Save as a list* (which keeps the rule), *Save these people as they are now* makes a hand-picked list of exactly who matches that moment. Profiles with socials, roles, gifts, *More details*, who they know and one **History** — knocks and calls (a dialer's too), texts, emails with their opens and clicks (bounces and spam complaints once the email service reports them), website forms, gifts, memberships, shifts, survey answers, signs, voted, yes and no to email and texts, a merge — newest first, with chips to narrow it, each role seeing what it may; **Calls** works a list one person at a time — any filter, or a List (`/calls?list=`) — asking only for who may be called or texted (`?reach=call|text`, the one place's rule), and goes on past its first 300: the next part loads as the last runs low (`?after=`; a part already loaded is asked for again only up to where it ended, `?until=`, so nobody is pushed out), and *N to call* is the true number left; **My people** is each volunteer's own circle |
| **Shifts** | Schedule a week by tap: **Shifts → Week** lists each day's shifts from 6 am, *+* adds them — what, where, which days, when — with nothing typed and no number asked, a card moves by a drag or a tap, and a week copies to the next; tap a name and it stays in hand while you tap its shifts; notify by email + text with instructions and a link; volunteers see the list a day at a time and tap *Count me in* on the row; a shift can carry turfs; *Count me in* puts the walk list on your phone; the desk can *Edit* a shift (moved in time or place → *Let them know*) or *Call off* one, which takes back the walk lists it gave. Each shift has a **crew board**: drag volunteers on from a tray (free or busy then, asked to volunteer, new), onto its turfs — each person gets only their turf's walk list — or *No walk list*; team lead and driver; *Here* / *No-show* on the day; *Split the rest evenly*. **Shifts → Volunteers** is the roster: asked to volunteer, new, active, lapsed, by role; call, text and *Put on a shift* in a tap |
| **Donations** | Gifts (one-time / monthly), each to one slate — city council or school board — with the entity-keyed cap engine (the annual limit is per contributor per slate); receipts; donor tiers; gifts made in another tool, brought in from its file; the financial agent's filing dates, counted down — the only money base.win tracks |
| **Signs** | Billboards (4×8), large (4×4), lawn — requested → installed → removed |
| **Lists** | Saved filters (a tag, a rating band, a role, has an email…, any People filter — the new rules under *More rules*) and hand-picked lists of people: the one audience for an email or a text, a phone bank (`bank.create` with `list_id`), a pass (`list_id` on the pass), a CSV, a report. Each row has **Email · Text · Call · Walk** — a send to the list, a new phone bank from it, a pass that walks it — each with how many it reaches, and a list's page has the same four with its five numbers. Each list has its numbers — people · can be emailed · texted · called · reachable by any of the three (*Who may be emailed, texted or called*) — kept a minute (`STARBASE_LIST_COUNTS_MS`) and counted again at once when the list changes, or people change in a way a list can read (an edit or a tag, a gift, a membership, the newsletter, a STOP, an import or a merge; a list on another list follows it) — the field's stream of door and phone logs and voted marks waits for the minute; the names never wait for them (`GET /lists?counts=later`, then `GET /lists/:id/counts`, asked three at a time). People's *Save as a list* keeps the rule; *Save these people as they are now* (on People and on a list's page; `list.snapshot`) keeps exactly who a filter or a list names at that moment, as a hand-picked list — up to the whole file. Every number is the number, *Loading…* or *Unavailable — Try again* |
| **Reports** | The campaign in numbers (people by rating, tags, cities, people added by week, contacts by week, donations by month, the newsletter list, sends), each downloadable as CSV; any table as a spreadsheet; the full JSON export; Field, by turf (coverage, talks, support found, not-homes; by canvasser; CSV) |
| **Website** | The campaign's public site (managers, and whoever is granted the Website area): pages built from sections (hero, text, petition, donate, events, news…) that are added from a catalogue, dragged into order, hidden, edited in plain forms and published — the draft saves itself, *Preview* shows it, *Publish* says exactly which section needs a look; the theme (colours checked for contrast as they're picked, fonts, corners, logo); the menu, footer, announcement bar, search and sharing; news posts; petitions and pledges with their signatures. SITE.md has how it fits together |
| **Path to win** | Today → More (desk; the Data area). Each race's win number — typed in, or worked out from eligible voters × expected turnout × share needed, the campaign's own numbers (managers set them) — and the supporters to find for it; supporters found (rated 1 or 2) against that, the pace a week to election day (GOTV's, else one set here) beside the last 4 weeks', a 12-week trend from the ratings, and the turfs ranked by a score out of 100 whose parts are shown (supporters still to find = doors not yet knocked × supporters per 100 doors knocked; persuadables left; time since the last knock), on a map coloured by priority and in a list — tap one to open it on the main map. Counted in SQL, kept a minute (`STARBASE_PTW_CACHE_MS`) |
| **Outreach** | Two modules. **Email** (like Mailchimp): *Write an email* to the newsletter's subscribers or to any list, in Markdown (headings, bold, lists, links, pictures; files attached; *Send me a test*; two subject lines to test), then what went out — opens, clicks, past sends — the subscribers, and ladders (automatic emails, texts and follow-ups, started by what people do on the website, a shift booked, came to or missed, a gift, a membership, a survey; a goal — came to a shift, gave, joined, voted — takes them off; a *Send to a web address* step posts one small signed message about the person to another tool — Zapier, Make, a Slack channel — with *Send a test* to set the other end up first: INTEGRATIONS.md, *Connect anything*; Settings → Services → *Going out* points there). Ladders → Follow-ups: every open follow-up by organizer and the time to first contact. **Texting** (like CallHub): *Write a text* to any list, with the one-to-one rules (quiet hours, STOP, do-not-contact); the Inbox of replies; phone banks; texting one by one; texting settings |
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
- **Candidates**: the slate's seats — name, office (*Mayor*, *Council*),
  race (one of the slates) and email. *Invite to the app* sends a join link
  (or puts someone already on the team in the seat at once). A **Candidate**
  is a volunteer with a seat: they see what volunteers see, never money or
  gifts, and their phone opens on **Your day** — *Met someone*, their booked
  shifts, My people, and their race from Path to win. Only a volunteer can
  hold a seat: a seated candidate's role can't be changed until they're
  unlinked here, and someone who joins as staff isn't put in it (the row
  says why). Permissions has a **Candidates** column of its own, apart from
  Volunteers'; who-knows-who stays with the desk even with People granted.
- **Call time**: a phone bank for one candidate (New phone bank → *Who
  calls* → *Call time: <name>*, with an optional ask), made only by the
  desk holding Donations. Every number is the candidate's; their Today
  leads with *Start call time →*, and `/call-time` shows one donor at a time
  — what they gave (last gift, this year), their **room** (the year's limit
  less gifts, monthly gifts still to come and every open call-time pledge on
  the slate), the ask — and four answers: *Pledged*, *Not now*, *No answer*,
  *Left message*. Answers save offline and send later. A pledge is never a
  gift: the treasurer sees **Pledges from call time** under Donations →
  Needs you until the gift is logged (*Gift in ✓*), it's dropped, or 60 days
  pass. The call shows on the person as a call with no words; the
  candidate's note goes to Donations and the full export only. Only the
  candidate's own answer crosses a call-time number off (never a volunteer's
  call or CallHub), and call time is never sent to CallHub.
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
role's), since the area opens the desk to them, and every candidate — then sets it up at
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

### Sign in with Google

Once the campaign's Google client is set (`GOOGLE_OAUTH_CLIENT_ID`,
`GOOGLE_OAUTH_CLIENT_SECRET`; INTEGRATIONS.md), anyone on the team can link
their Google account on **Your profile** while signed in, then sign in with
Google instead of typing the password. It is an extra way in, never a
replacement: every account keeps its password, and two-step sign-in still
asks for the code. Google never opens an account on its own — an account
is found only by the link its owner made (Google's account id), never by
email — and a removed member stays out. A manager can turn Google sign-in
off, or allow only Google accounts at the campaign's Workspace domain
(their own link must be at it first), under **Settings → Services →
Google**; a manager can also unlink someone's lost Google account. Linking
and unlinking are on the event log with nothing about the Google account;
signing in is not (as with passwords). The same Google client and one
stored connection per person (`google_grants`, its token sealed with
`GOOGLE_TOKEN_KEY`) serve Gmail, Drive and Calendar: `server/lib/google/`
(the plumbing they call) and `server/ext/google/` (the one route pair
`/api/auth/google/start` and `/back`, tables, actions, Services row).
On the web: the button on Sign in, the tick box on Join, the Google card on
Your profile (`GoogleCard.jsx`), `GoogleConnect.jsx` (the one Connect piece
a Google feature puts on its own screen), the Services panel
(`GooglePanel.jsx`) and Team's *Google* chip. The installed home-screen app
shows *Open base.win in your browser to use Google.* instead of any Google
button until the phone check in TESTING.md §4 passes.

### The command bar

On the desk, **Ctrl+K** (⌘K on a Mac) or **Search** in the header opens one
box: type to jump to any screen you may open, find someone by name, email or
phone (typed any way: *604 555 0142* finds 604-555-0142), or start a common
job — *Add person, Log a gift, Enter a membership form, Draw a turf, New
shift, Write an email, Write a text*. ↑ ↓ and Enter, Esc to close; it offers
only what your areas allow (`web/src/components/commands.js`). People come
from the person search (`GET /api/search/people`, `server/ext/search`): the
start of each part of a name in any order (*kevin smith*, *smith kevin*,
*Smith, Kevin*, *kev smi*), accents and apostrophes ignored (*jose* finds
José, *dsouza* finds D'Souza), the last word of a two-part surname (*gill*
finds Sandhu-Gill), a middle name; a phone from its start with or without
its area code (*555 0142*); a house number from 3 digits (*145*), an
address (*14520 72 ave*); and, on the desk only, the start of an email,
with or without the @. It doesn't find the middle of a word (*ena* for
Lena), the second half of a hyphenated first name or of a group's name on
its own (*luc*, *society*), sound-alike spellings, or the last four digits
of a phone. Answers come A–Z by last name, 6 at a time in the bar (25 in a
picker), with how many match — or "more than 5,000" — and the next page
after the last one shown; each way in reads its own index, so a
300,000-person file answers in under 50 ms (TESTING.md). People's own box
still reads every row (any part of a name, address, phone, email or
handle); two words or more of a name now match in any order there too.
When there are more than six, the bar's last row is *See all people
matching “smith”*, which opens People with that search.

**Who do they know?** (a profile's **+ Someone they know**) uses the same
search, asked once typing pauses: a list that says how many (*2,363
people*), scrolls and loads more by itself, with each person's street, city
and phone, and *Already linked* on whoever is linked already
(`web/src/components/PersonResults.jsx`, `usePersonSearch.js`). People's
**Show more** goes past the first 300, from the server.
The other pickers use it too: a shift's **+ Add volunteer** (a drivers'
shift starts with *Has this role: Driver*), a sign's supporter and a gift's
donor show 8 at a time with **Show more** and *+ Add new person* kept at
the foot (`PersonPicker.jsx`); *Gifts that need a donor* and a list's **Add
people** scroll on, and **Add people** says *Already on the list* however
long the list is.

**A–Z by last name.** Every list of people — People, a list and its CSV,
the call list, Knows, who lives at an address, a shift's people, volunteers
and crews, the reports, a new phone bank's numbers — runs by last name,
then the whole name (`server/lib/az.js`; `azSort` in `shared/names.js`
sorts the same in the browser). Names are still written first name first.
Walk lists keep street order, the map's doors are unchanged, a bank already
made keeps its order, and the full data export stays in the order people
were added (so it re-imports cleanly).

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
- **Socials**: per-person handles for Instagram, X, TikTok, Facebook, LinkedIn,
  YouTube, Bluesky, Threads and Reddit (or any other profile link). One box
  takes a pasted link or @handle and puts it right (`shared/socials.js`: a
  post or a short link is refused in plain words; a bare @name asks which
  network); each handle opens the real profile. The desk types in a
  follower count from it (*12.4k followers*), kept only while that handle is
  on file (`ext/socials`); People filters by *Any social*, each network, and
  *Following* (1,000+ · 10,000+, the desk's only).
- **Share kits** (Outreach → *Sharing*; *Share* for everyone, from Today's
  *Share · 2 posts*): the desk writes a post once — the words, a picture, a
  page of the website, and the *Authorized by* line added to the words —
  and everyone signed in shares it with their own link
  (`/r/<code>?k=<post>`), through the phone's own share sheet (Instagram,
  TikTok, WhatsApp…) or WhatsApp · Text · Facebook · X · Email · Copy. A
  friend's sign-up on any page within 30 days credits the sharer and the
  post; the desk sees sign-ups and sharers per post and the top sharers,
  and each person sees how many people they brought in (`ext/socials`:
  share.js, share-api.js). Sign-ups are counted, never clicks.
- **Stewardship** (Donations → *Stewardship*, the desk that handles money):
  *To thank* — every gift no one has thanked, oldest first, with how long it
  has waited; *Called · Emailed · Note · Letter* marks it.
  *Next steps* — one per donor with a date (*Coffee after the debate*), the
  due ones first. *Lapsed* — gave in an earlier year, not yet this one.
  *Top donors this year* — and when each was last thanked.
- **Gifts made in another tool** (Donations → More → *Import donations*, or
  Import & export; managers and the treasurer): a CSV or Excel file of
  donations taken elsewhere. No tool's column names are assumed — a column
  is matched by what its heading means, then by its values, and you correct
  it; a way of paying or a slate it can't read is asked about (the limit is
  per slate), and with no slate column it says every gift goes to the first
  slate. The check saves nothing and says the gifts and their total, the donors
  found, the gifts to settle, what is already here, what can't come in, and
  anyone the file would take over the year's limit. Each gift then goes
  through the same path as one typed at the desk, oldest first, so the limit
  counts it and the gift that crosses it is flagged — but it is quiet: no
  receipt number is used and nothing is emailed (the other tool's receipt
  number is kept as text), no ladder starts (one whose goal is *Gave* counts
  it by the day it was given), and it is not in *To thank*. It counts in the
  totals, donor tiers, *Lapsed* and the disclosure, and wears *Imported*.
  The donor is found by the same email, else the same first and last name
  with the same phone, postal code or street; no sure record, or more than
  one, and the gift waits under **Needs you** (*12 imported gifts need a
  donor*) for a person to pick the record, find someone else, add a new
  person or leave it out (listed at the pile's foot, *Left out · 3*, to
  bring back whenever; Donations → More leads there — *3 imported gifts
  left out* — once nothing else waits). The gift's number in the other tool — or, without
  one, donor, amount, date and how it was paid, as the file writes it — is
  kept on it, so the same file twice adds nothing. A row with the same
  donor, amount and day as a gift already on the books another way (typed
  at the desk, given online) is pointed out in the check (*1 row looks like
  a gift already typed in here*), with *Leave it out*; one gift on the
  books answers for one row, however many calls the file comes in by. A
  *Payment status* column brings in only the payments that went through:
  refunded, failed or pending ones are left out, and a word it doesn't
  know (the other tool's *Posted*, say) is asked about and left out until
  you say it comes in. Without one, take
  refunded payments out of the file first; a gift refunded after it came
  in stays on the books until it is voided. An import can be taken back
  whole for a day.
- **Filing dates** (Donations → More → *Filing dates*, managers and the
  treasurer): two dates the financial agent types in, each a name and a day
  (*Disclosure statement due*). Donations counts down to each under the big
  number; Today lists the ones within 30 days for the desk that handles
  money. base.win knows no law's dates: what is due and when is the
  financial agent's to confirm and enter.
- **Donations says how it stands**: the big number is *Raised this year*,
  added up by the server; it, *Needs you* and the gift list say *Loading…*
  while a read is out and *Unavailable — Try again* when one failed — never
  a dash or a block that isn't there.
- **Voter number** (a profile's *More details*, the desk): the number a list
  of electors gives each voter. People → Import fills it from a *Voter ID*
  column and matches on it first — the same number is the same person
  however the name and address are written (three or more letters and
  digits with a digit among them: a yes/no or 1/0 column is never read as
  one, and rows that share a number are pointed out before the check). A
  row found by email, or by name with phone or street, on someone with
  another number — a list numbered afresh, a number typed wrong — is
  counted in the check, which asks: the same people, keeping the numbers on
  file (as it does unless told) or taking the file's, or new people (never
  for a row with the same email). It is in the People spreadsheet and the
  full export, a merge keeps it, and a volunteer never receives it.
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
  numbers to call, with a script — made from a List (*From a list*, or a
  list's *Call*: the server reads the list itself, however many; someone
  who leaves it — voted, re-rated, do-not-contact — leaves the calls not
  yet made at once, a call already logged stays; the bank's page says how
  many left, and *Add who joined since* — `bank.topup` — brings them in),
  or from the people list by hand (*Pick people*: a rating, a tag, a
  search; 5,000 at a time). A bank's numbers show 2,000 at a time.
  Only people who may be called are in it (a number, never do-not-contact
  or do-not-call).
  A list can't be deleted while an open bank calls it (close the bank first);
  a closed bank whose list was deleted keeps its numbers and stays closed.
  The desk hands numbers to a caller, or splits them in turn across a team
  (one write, however many), takes unfinished ones back, closes the bank. A
  caller's *Your call lists* (on Calls) opens each bank on the Calls card,
  script and all — 500 numbers at a time, the next coming in as these are
  called, *N to call* the whole of what is theirs; a phone call they log
  crosses the number off, *Skip* crosses one off without a call. The list
  ends on the server's word (*N of N done · All done*); a last call made
  with no signal waits (*1 call saved on this phone — your list finishes
  when you’re back online*) and ends the same way once it has sent.
- **Do not call**: the tag `do-not-call` (among the suggested tags) is
  someone who asked not to be phoned. They are never put in a phone bank,
  left off the Calls list for a call, never rung through the campaign's
  number and never sent to the dialer, and no screen that reaches voters
  offers a Call to tap for them; texts, email and the door are untouched
  (`do-not-contact` stops all of them, and offers no Call either).
- **A dialer for a room of callers (CallHub)**: with CallHub connected, a
  list's page and a phone bank's page have **Send to CallHub** — the phone
  numbers, names and cities go to a CallHub phonebook in the background
  ("Sending · 850 of 2,000"), and every call's result comes back onto the
  person as a phone call, crossing the number off an open phone bank. What
  each of CallHub's results counts as is filled in by pattern and yours to
  correct (a change that would tag people do-not-call, take that tag off
  again or rate them asks first, and putting it back undoes it — on the
  lists sent since that copied it, too); a rating comes only from a survey
  answer someone mapped
  (`server/ext/callhub`; INTEGRATIONS.md, *Phone dialer — CallHub*, says
  how to set it up and what is not yet confirmed against a real account).
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
  a do-not-contact profile) and *Most connected* finds the connectors (and
  how many new people each added — not Share's "brought in", which counts
  website sign-ups by their link). A tie can be marked **close**
  (`relationship.update` also changes its kind or note; a blank note clears
  it). The desk reads the two ties that matter for up to 20 people at once
  (`GET /api/relationships/key`: close first, then supporters, then family to
  other — `shared/ties.js`; never someone asked not to be contacted), and
  People, lists and sends can pick people by who they know (`knows=supporter
  · donor · volunteer · any · person:<id>`; the desk's with People only —
  *donor* also needs Donations — and never a volunteer's, even granted
  People; a list the desk saved is read whole). Most connected and the key
  read are the People area's; My people is in no area. On screen: a desk
  profile shows the ties that matter in one line under its chips ("Knows
  Sofia Petrova Friend · Close · 4 more · Same address: …"; on a phone two
  lines at most, long names cut with "…"), and the desk's Calls card does too; Knows has *Close* on each row and *Make
  a list* ("<Name>’s circle"); People's filter and a list's rules have
  *Knows* (*Knows a donor* only with Donations). Everyone sees *You know them
  · Friend* on a profile, the Calls card, the map's door and the walk list,
  and can tap *I know them* (under More at a door) — saved on the phone with
  no signal, sent once (one refused says *Not saved*, also once dismissed). A volunteer's add
  never matches on, or takes, an email the campaign holds, so a possible
  double is flagged to the desk (*May be the same person as …*).
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
  way; gifts made in another tool, from its file (*Import donations*); the
  website's sign-ups through its key. **Out:** each table as a
  spreadsheet — people (with *voted* and the voter number, and it reads
  straight back in), contacts, gifts (which came from a file, and the other
  tool's receipt number), volunteers and their roles, signs, shifts,
  subscribers, lists — and everything in one JSON file for a backup or a
  move.
- **GOTV mode** (Today → More → *GOTV & voting days*, managers): list the
  advance-voting days and election day, and GOTV mode turns itself on for
  each of them in the campaign's day (or on by hand, any day). While it's
  on: everyone can mark people *Voted ✓*; the **GOTV scripts** (Scripts →
  *Get out the vote*: door and phone) are said instead of the usual ones;
  Today opens on the supporters who still have to vote, the desk's map on
  *Yes, not voted*; People and Calls filter *Voted: Not voted yet*
  (`voted=no`, also in a saved list — and so in its email or text, the
  phone bank made from it and a pass that walks it); and *Ask the office*
  offers *Needs a ride to vote*, a request for the drivers. Shift roles
  include Driver, Scrutineer (a voting place), Runner, Poll greeter and Zone
  house captain.
- **Scheduling by tap** (Shifts → **Week**, the desk's): each day is a
  list of its shifts in start order — *Early* (before 9), *Morning*,
  *Afternoon*, *Evening* — any number to a part, and a card shows the kind,
  the place, the hours and who is on it (*2 on* — nothing asks how many
  people, and no shift is given a number: *3 of 4* shows only once someone
  taps a target). **+** on a day (or *New shift*)
  opens one sheet where nothing is typed: **What** (a tile a kind) →
  **Where** (turfs for a canvass, places used before, or *Pick on the map*)
  → **Which days** (several, or *Weekdays*) → **When** (the kind's usual
  hours already chosen; several at once, or *Another time* by tap) →
  **Repeat** (*Just this week*, *Every week for 4 weeks*, *Every week until
  election day* when one is set) → *Add 5 shifts*. A name, instructions, a
  link, *We need* (a target by tap — what the kind usually wants is only
  the first number offered), *Limit sign-ups to* and *Show on the website*
  sit under *More*, with the long form as *More options*. A point nothing
  could name reads *Pinned place* — on its card, its chip and its own page,
  with *Name it* — never its coordinates. Tap a card to change its
  day, time or place, *Tell them*, put it *On the website* or *Call off* —
  for a repeating slot, *This one* or *This and the following* — or drag it
  to another day (*Undo*). **People** are a strip across the top of the
  week (on a phone a sheet): everyone with a volunteer role or sign-in, who
  asked to volunteer — the website's form among the ways — or was on a
  shift. Tap a name and it stays in hand while you tap as many cards as you
  like (*Done* puts it down), or drag it onto a card. **More** on the week: *Tell everyone on this
  week's shifts* (the count first, then how each person's message went),
  *Remind people the evening before* (a switch, off until a manager turns
  it on) and *Copy to next week*; an empty week offers *Copy last week*.
  Each copy asks *With the same people?*. A week that hasn't loaded says
  *Loading…*, one that can't says *Unavailable — Try again*. **Back**
  closes a sheet, not the week, and a sheet keeps its choices through a
  lost signal (it waits for the signal to save).
  The **List** (a volunteer's whole Shifts tab; past 500 shifts ahead it
  ends in *Show later shifts*) is grouped by day; a row
  wears its kind's mark and says the hours and the place, with *Count me
  in* on the row itself — asked about first when it overlaps a shift they
  are on, never refused. A place with a pin opens a map, and a Mainstreet
  shift has *Start mainstreeting*, which opens Mainstreeting with its place
  filled in (at a point nobody has named yet it asks *Where are you?*).
- **Scheduling, underneath** (`server/ext/schedule`): a shift has a
  **kind** — Canvass, Phone bank, Mainstreet, Burma Shave, Lit drop, Signs,
  Event, Office, Other (`shared/shiftkinds.js`) — that brings its usual
  hours (Burma Shave 6:30–8:30 am, Mainstreet 7–9 am, …), and a **place**
  saved once and picked again (`GET /api/places`: this kind's most used
  first). A point tapped on the map is named by the server: the nearest
  corner, else the nearest address (the BC Address Geocoder), else the
  nearest door on file (for the desk only), else its coordinates (said as *Pinned place* on
  every screen and in made names until someone names it; an email or text
  gives its map link instead, the website *See the map*) — a geocoder that
  is slow or down never holds a save. A shift's name is made from the two ("Burma
  Shave — King George Blvd & 88 Ave") unless one is typed. `shift.createMany`
  makes every chosen day in one write — at one time or several (`slots`) —
  and can repeat it weekly (200 shifts and 26 weeks a call; a day that
  already has that kind at that place and time is skipped and said so); `shift.copyWeek` copies a week — the same
  local times, turfs, target, limit and on-the-website — with its people as
  plain bookings when asked, never those who declined or didn't show; a
  repeating slot is changed or ended from one of its shifts
  (`shift.series.update` / `.cancel`: this one and the following). There is
  **no maximum** unless one is set: a shift may carry a target (*need*)
  that never refuses anyone — never given unasked — and Today's *Needs you*
  lists the shifts short of it (the brief's `shortShifts`). The shifts list
  answers what is coming up (`GET /api/shifts`; past ones a page at a time
  with `?past=1`), and the week's read (`GET /api/shifts/board`) brings the
  people to put on shifts, website sign-ups among them. A shift may be
  said by its **length** (`minutes`, a quarter hour to a day; a longer
  shift the long form made keeps its length when its start moves) in place
  of its end — elapsed time, and the only way past midnight (an end before
  the start is a typo, refused) — and marked **Drop in any time**
  (`drop_in`: words only; booking and counting are as for any shift). A
  booking may carry **its own hours** inside its shift (`arrive_at`,
  `leave_at`: the plan, not who came; both null is the whole shift):
  `shift.hours` for the volunteer's own (also saved offline),
  `shift.setHours` for the desk. They are cleared when a booking comes
  back after *Can't make it* or a no-show, narrowed or cleared when the
  shift's times change, shown only to the person and the desk (`GET
  /api/shifts` as `my_arrive_at`/`my_leave_at`, a shift's page, the crew
  board), and every notice says each person's own hours
  (`shared/shifthours.js`). On screen: *Another time* steps the start and
  the end a quarter hour at a time (up to 16 hours, past midnight sent as
  a length), and a card says when a shift ends on a later day ("8 pm–1 am
  next day"); *Change my hours* under *You're on this shift* (through the
  outbox: a second save replaces the waiting one, a *Count me in* taken
  back takes its hours along, and "not on this shift" on replay is
  dropped); *Hours → Save hours* in the desk's person sheet; the roster and
  check-in board show each person's hours; and a drop-in shift reads
  *Drop in* on the list and the website. These writes, every

  screen that shows or takes a shift's time and every shift notice work on
  the campaign's clock — B.C. on UTC−7 all year from March 2026, by rule
  (`shared/dayparts.js`), whatever a phone's or a server's own time-zone
  data says.
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
| **Action Network** | newsletter list + unsubscribe, press list + releases, email blasts and texts to lists, ladders of engagement, A/B subject lines with open/click tracking; the website's own forms, RSVPs (to a public shift) and online donations | events to RSVP to apart from shifts |

## Calendars

Anything dated can go into Google, Outlook or Apple Calendar: a shift, the
voting days, a filing date and the website's events. *Add to calendar*
offers Google, Outlook, or a file every calendar app opens (a link that
needs no sign-in, good for 10 minutes and 3 opens). Shift emails — the
notice, the week's notice and the evening-before reminder — carry the same
file for that person's own shifts; texts don't change.

Each person can also put **their own shifts** in their calendar once, from
their profile: a secret calendar link their app checks by itself (Google
every 8–24 hours, Apple as often as they choose). It holds their booked
shifts (no instructions or Details links — the link lives in another
company's calendar and may be forwarded), the voting days, and for the
people who handle money the filing dates; who they are is checked on every
fetch, so taking someone off the campaign empties it. Google adds such
links only on a computer, so on a phone the app emails the link instead.
The link is kept as it is in the database (the person needs it again on
another device), so a backup carries live links: **Make a new link** on
the profile ends the old one, for a leaked link or a lost backup alike. The
data export leaves the links out. The website serves its Events list as
`<site>/events.ics` (SITE.md). Nothing to set up: no keys or accounts.

## Public pages

The campaign's website is base.win's own (the **Website** area; SITE.md):
served at `/site/` and on the campaign's own domain, each of its forms —
newsletter, petition, pledge, volunteer, RSVP, contact, join, donate —
makes a person and a typed action in one write. A website still kept
somewhere else can send sign-ups, petition signatures, volunteers and
newsletter opt-ins in through `POST /in/v1/people` with a website key a
manager makes under Settings → Services (`server/ext/intake`; the fields
and answers are in INTEGRATIONS.md, *The campaign's website*): matched
only by the same email (a visitor's typing never lands on someone else's
record), never back on the newsletter for someone who left it, a
volunteer or a message filed as a request under *Needs you*; the answer
is only the person's id. Donations and RSVPs aren't taken that way. Beside
the website, base.win's public pages are the ones every email needs, no
login:

- `/u/:subscriptionId` — unsubscribe from the newsletter (the link asks; one
  tap on *Unsubscribe* does it, so mail scanners never unsubscribe anyone)
- `/bu/:recipientId` — unsubscribe from an email blast to a list (the
  address is marked do-not-email everywhere)
- `/lu/:runId` — unsubscribe from a ladder's emails
- `/r/:token` — a donation receipt
- `POST /stripe/webhook` — Stripe's payment events, signed (INTEGRATIONS.md,
  *Online payments — Stripe*)
- `POST /hooks/mail/<sender>` — the email sender's delivery events
  (delivered, bounced, spam complaints), signed (INTEGRATIONS.md, *Email*)
- `POST /hooks/mailchimp/<key>` — Mailchimp's unsubscribes and dead
  addresses; only a hint, base.win reads the member itself (INTEGRATIONS.md,
  *Mailchimp*)
- `POST /hooks/callhub/<key>` — each call's result from CallHub's dialer;
  the address's last part, made from the API key, is its lock
  (INTEGRATIONS.md, *Phone dialer — CallHub*)
- `/learn/:slug` (and `/learn-files/:id`) — ImagineU's public lessons
- `/media/:id`, `/o/…`, `/c/…` — pictures in emails, and the open and click
  counts
- `/brand/:id` — the campaign's brand pictures (the same bytes as
  `/media/:id`, at an address the service worker keeps for no signal)
- `/api/public/twilio/…` — Twilio's webhooks, signed (INTEGRATIONS.md)

The pictures, the three unsubscribe links and the Stripe, Twilio, CallHub,
email sender's and Mailchimp's webhooks also answer on the campaign's website
domain (SITE.md); the others don't.

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
`GEOCODER=bc|nominatim|off`, `BC_GEOCODER_KEY`, `GEOCODE_MIN_SCORE`).
Google no longer places pins (its terms let a Google pin be kept 30 days
only and not on another map): `GEOCODER=google` places with B.C. and
`GEOCODER_FALLBACK=google` is ignored, each said once and on Settings →
Services. Google's address suggestions (`server/lib/places.js`) only with
`ADDRESS_SUGGEST=google`: the words a person picks, placed by B.C.
(INTEGRATIONS.md, *Address lookup*). A list is placed by a
background run (`server/ext/geocoding`, a job like ladder emails). An import
that leaves addresses without a pin starts it by itself, in the import's own
write; **Place on map** and the map's *Look up addresses* start it by hand.
It works in rounds of 120 people, one lookup per address (a household shares
it), pins already on file at the same address copied, `GEOCODE_CONCURRENCY`
lookups at once (default 6). A lookup that fails while others work is tried
3 times, then set aside for a pin by hand; a round where every lookup fails
counts as an outage (nobody's tries are spent), backs off
(`GEOCODE_BACKOFF_MS`, default 30 s × rounds in a row) and after 5 such
rounds pauses the run with the reason. A paused run tries again by itself:
one round after 15 minutes (`GEOCODE_RETRY_MS`), then after twice as long
each time lookups still don't answer, up to six hours (**Carry on** does it
now, **Stop** calls it off). A paused run with no try to come — paused by an
older release, or its try never ran — gets one when the server starts.
`GET /api/geocode/status` reports progress and, while paused, when the next
try is (`retryAt`); a minute past that time and still paused, the map and
the Map check say it *was due to try again*. The page shows the progress
and works out the time left. The desk's map shows the run without opening
anything — *Placing addresses · 12,400 of 150,000* where *Not on map* was,
*Placing addresses paused* while it waits to try again — and draws what it
has placed as it goes. Nobody is placed by guessing: a person with no
address stays off the map (the Map check counts them). With
`STARBASE_JOBS=off` nothing starts by itself, and the page falls back to
looking up batches itself.

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

**Templates.** A campaign keeps its own email templates (Outreach → Email)
and release templates (Media): a name, a subject and a message, no From,
To or files (those are chosen at send). Anyone at the desk who may send
that kind may save, change, copy and remove them, with Undo; a save made
over a newer change is refused with who changed it and when. Every
campaign also has thirteen ready-made ones built into base.win
(`shared/email/starters.js`): four newsletters first (monthly, a short
update, an issue spotlight, looking back and ahead), then an invitation, a
volunteer call-out, a donation ask, a thank-you, a campaign statement and a
welcome, the two voting-day reminders last, and a press release. They state
no fact about any campaign: what is specific to it is a placeholder in
[square brackets], and an email started from a template can't go out with
one of that template's placeholders (or any ready-made one's) still in it:
*Fill in the [ ] parts first*. A link with no address is refused too. They are
reached from "Start from" at the top of every email and release, the
**Templates** row under Lists (Media: beside Write a release) and the
command bar; "Save as template" sits under the message, and a past email has
**Use again** (tapped with no signal, it loads once signal is back). A
manager can hide a ready-made template. **[first name]** and
**[campaign]** fill themselves in on every newsletter, email and release:
the subscriber's or person's first name ("JOHN" is greeted "John"; none:
"friend"), put in after the message is laid out, so a name is only ever
words. Every newsletter, email to a list, release and test ends with the
campaign's mailing address, an email or phone, and "Authorized by …" from
Website → Settings, as far as they are set.

**Emails and texts to a list.** Outreach → Email → *Write an email*, *To* a list, sends to a
list (Lists: a saved filter or a hand-picked list): everyone on it who may
be emailed (below), each copy with its own unsubscribe link
(`/bu/<recipient>`, which tags the address do-not-email). Outreach →
Texting sends one text to everyone on a list who may be texted, through
the campaign's Twilio number, by the one-to-one rules: the campaign named
in the text; "Reply STOP to opt out" on each; inside quiet
hours (a text sent at night waits, and the send job sends it when texting
opens); each filed in the Inbox as the sender's conversation, so replies
and STOP land where the desk reads them. Managers, staff and treasurers
(the outreach area) send; volunteers never. Confirm bulk texting with
counsel before the first send: the texting module was built for
one-to-one texts, and election texting rules are the campaign's to meet.

**Media.** Reporters and influencers are people tagged `media` or
`influencer` (any capitals), so People, lists, exports and History keep
working; `server/ext/media` adds their outlet, beat and a note. A release
goes to Media, Influencers or Both (`media.send`), skips anyone tagged
do-not-email or do-not-contact, and ends with "Don’t want press releases?
Unsubscribe" (`/bu/<recipient>`, and the `List-Unsubscribe` headers): that
link takes the address off the media list only — not the newsletter, no
do-not-email tag, nothing to Mailchimp — and the desk can't add them back.
Media is its own area (Settings → Permissions): staff and treasurers have
it, and anyone denied Outreach keeps it until a manager denies it too. A
volunteer granted Media writes, tests and sends releases and sees names,
outlets, beats, notes and socials — never an email or a phone — and can't
add or edit contacts. Video is a link (YouTube, Vimeo, Drive), never a file.
The **Media** tab (after Outreach) has Releases — the contacts, the last
release and how many opened it, Write a release (To, From, pictures,
files) — Contacts (why someone won't get releases; a contact's handles open
their profile, to message them) and each release's page: who got it,
opened it or bounced, Try again, and Copy links (the video, the Drive
folder) to paste into a message to an influencer.

**Media's outlets and lists.** An outlet is a paper, station or show with
its letters and op-ed address or web form, its length limits (in words or
characters), whether it wants a letter only for itself, local writers
only, no candidates, a word about working with a campaign, and what it asks
a writer for (phone, address); "I checked these today" stamps its rules.
The list starts empty and only the desk edits it (`media.outlet.save`,
`.remove`); anyone holding Media reads it. Contacts link to an outlet by
its name, any capitals, and a rename carries them. A contact may be on
**Op-ed editors**, **Letters editors** and **Show hosts** (hosts and
producers: radio, TV, podcasts), any or all; only contacts still on the
media list count. A release's *Only:* sends to some of the lists — it
narrows the audience, never widens it — and the desk can copy a list's
emails, only those a release may reach (`GET /api/media/contacts?list=…&emails=1`).

**Letters to the editor and op-eds** (`server/ext/letters`). A volunteer
writes a letter or an op-ed, picks up to three papers that take it and
sends it to the campaign; it goes through the phone's outbox
(`myletter.submit`), and a paper removed meanwhile is dropped, never a
refusal. The desk (staff and managers with Media, never a volunteer
whatever they were granted: the queue holds writers' addresses and phones)
writes notes and suggests edits (`letter.*`); the writer keeps their words
or takes changes, and only they can say "This is my final text" (Ready).
They send it themselves, from their own email — base.win never sends a
letter for them — and say so (`myletter.sent`, always recorded; sent
while an exclusive paper still had it, the desk sees which). A paper that
didn't print it sends it back to Ready for another. The event log holds
which draft was agreed (its sha256), never a letter's words; the export
leaves the sign-off out; the sign-off is read from the writer's own record
and kept on a letter only where they changed it, and the address and phone
typed for it go 30 days after it closes (at once when withdrawn).
Talking points for writers: `letter.points`; the wait before another paper
(10 days by default): `letter.settings`, managers. A writer whose letter
repeats eight words in a row (twenty Chinese characters) of the talking
points or a press release of the last 60 days is told "These words are the
campaign's — say it your way" (`campaign_words`; never a block); the desk
also sees other writers' letters of the last 60 days that share such a run
(the same paper or newsroom first), and how much of a letter is the
campaign's suggested words (`campaign_share`; kept on the letter when the
writer agrees, never on the log). After the desk suggests, writes, declines
or marks it published, the writer gets one email, "The campaign replied
about your letter" — the link, never the letter's words, a note or a
paper's name — at most one an hour, unless they turned it off on the
letter; with no email connected nothing is sent. Counting, the comparison
and the email link are `shared/letters.js`, shared with the field app.

On screen: the field app's **Letters** (a Today row, "Your letters · 1
reply" when the campaign wrote back; `/letters`): *Write a letter* (Letter
or Op-ed, the papers with each one's rules, the count against its limit, a
headline idea, the sign-off under *More details*), a letter's page (each
suggested change marked in place with *Take* or *Leave*; *Keep mine*;
*This is my final text*, which says how much of it is the campaign's words
when that's 20% or more), and *Send it* — it copies the text and opens the
writer's own email with the paper's address, a subject they can change and
the agreed text (the text alone when the link would be too long), or the
paper's web form; then *I sent it*. What's typed is kept on the phone for
that sign-in (two weeks) until the server has it, and sign-out counts an
unsent letter. The desk: Media → **Letters** (the queue, a letter in place:
*Suggest an edit*, notes, *Assign to…*, *Decline*, *They told us they sent
it*, *Published: paste the link*; *Ideas for writers* under More), Media →
**Outlets**, "N letters" in Today's *Needs you*, and *Write a letter* in
the command bar; Settings → Campaign → *Wait before another paper*.

**From addresses.** Settings → Services → Email → *From addresses*: a
manager adds up to ten addresses at MAIL_FROM's own domain (a name and an
address; anything else is refused) and picks the default for email and
for press releases. With none, everything goes from MAIL_FROM, as before.
Managers, staff and treasurers may pick another From on a send, the
campaign's own MAIL_FROM included (always a choice); anyone else always
gets the default. A send keeps its From (Try again, the A/B winner).
Invites, shift notices, receipts, two-step and ladder emails stay on
MAIL_FROM.

Set `STARBASE_PUBLIC_URL` (e.g. `https://starbase.imaginesurrey.ca`) so links
in outbound mail — newsletter unsubscribe footers, invite links, the
pictures in a message, calendar links — point at the public host. Every newsletter and ladder email ends with "Sent by <campaign>"
and the reader's own unsubscribe link, and carries `List-Unsubscribe` /
`List-Unsubscribe-Post` headers so mail apps show their own Unsubscribe
button. Someone who unsubscribed can only rejoin by signing up again — the
desk can't add them back. Ladder emails go only to addresses on the list as
subscribed (below). Shift messages render in campaign time
(`America/Vancouver` unless `settings.tz` says otherwise).

Email hears back. The email sender (Resend, or SendGrid with
`MAIL_PROVIDER=sendgrid`) posts what happened to each email to
`/hooks/mail/<sender>`, signed: a send's row then says *Delivered 1,180 of
1,200 · 12 bounced · 1 spam complaint*, an address that bounced for good or
reported spam goes on the campaign's suppression list — no list, newsletter
or ladder emails it again — and a complaint ends that person's consent too.
**Settings → Services → Email** carries the sender's *Sending domain*: its
DNS records with Copy and *In / Not found yet*, the DMARC record base.win
looks up itself, *Add domain* and *Check again*. INTEGRATIONS.md has the
setup and what is not confirmed against a real account.

| Setting | For |
|---|---|
| `MAIL_PROVIDER` | `resend` or `sendgrid`; unset, whichever has its key (Resend first) |
| `RESEND_WEBHOOK_SECRET` | Resend's delivery events (the webhook's signing secret) |
| `RESEND_REGION` | where *Add domain* makes the domain at Resend (default `us-east-1`) |
| `SENDGRID_API_KEY`, `SENDGRID_WEBHOOK_PUBLIC_KEY` | sending through SendGrid, and its delivery events |

Mailchimp, for a campaign that builds its emails there (optional —
`server/ext/mailchimp`): a list's page has **Send to Mailchimp**, which
makes the list a tag of the campaign's Mailchimp audience. By default only
the addresses subscribed to the newsletter here go, one tick widens it to
everyone on the list who can be emailed, and only the email, first and last
name leave — never a rating, a tag, a note, an address or money. Nobody
already in the audience is changed, and a no in either place is a no in
both: unsubscribed and cleaned come back (Mailchimp's webhook at `POST
/hooks/mailchimp/<key>` — the address's last part is made from the API key,
and it answers on the campaign's website domain too — plus a nightly pull
and *Pull now*), and an unsubscribe, a do-not-email tag or a dead address
here unsubscribes the member there. The first pull from an audience turns
off here everyone on file who ever left it, so until someone taps *Turn
their email off here* it only counts, and asks — the audience and how many
people — whenever a count finds someone; the yes is for the numbers it
showed. Someone who leaves there after the first count is turned off here
all the same, by the webhook or the next pull. **Settings → Services →
Mailchimp** has *Check*, *Connect* and *Pull
now*. INTEGRATIONS.md has the setup and what is not confirmed against a real
account.

| Setting | For |
|---|---|
| `MAILCHIMP_API_KEY` | the Mailchimp account's key (its ending names the account's server) |
| `MAILCHIMP_AUDIENCE_ID` | which audience, when the account has more than one |
| `MAILCHIMP_WEBHOOK_SECRET` | optional: the signing secret *Connect* shows once |

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
in TESTING.md). A dialer is optional too: `CALLHUB_API_KEY` (and
`CALLHUB_API_BASE` when the account's API is on another host) turns on
*Send to CallHub*; without it the button is not there and nothing else
changes.

**A week's shifts in one message.** `shift.tellWeek` tells everyone on a
week's shifts at once: one email and one text a person, listing their own
shifts still to come (`GET /api/schedule/week` gives the count first). The
tap only queues it: a background job sends, outside the campaign lock, each
email with its own key, and keeps how each went — on the notice and on each
booking, where a shift's page shows it. **Reminders the evening before**
are off until a manager turns them on (`shift.reminders`). Then everyone
booked for tomorrow gets one reminder at 6 pm on the campaign's clock (an
hour before texts stop when they stop by 6, as on weekends), once per
booking, never someone who can't make it. Both keep the texting rules, and
leave the email out for *do-not-email* and *do-not-contact*, and for an
address that bounced for good or reported spam (the row says so). With
neither email nor texting connected an evening reminds nobody and marks
nobody as reminded; with `STARBASE_JOBS=off` notices and reminders wait.

### Who may be emailed, texted or called

One place decides (`server/lib/reach.js`), and everything asks it: an email
or a text to a list, the newsletter, a press release, a ladder's steps, a
shift's email and text, the calendar link someone asks for, a phone bank, and a list's own numbers (can be emailed · texted · called ·
reachable by any). Each channel is a list of reasons not to. The senders
differ, as they always have: an email to a list goes to everyone on it who
hasn't said no; the newsletter and a ladder's emails go only to people who
said yes. Whether a send to a list should need a yes too is the
campaign's call, and its counsel's — the code only keeps the rules as they
are, in one place. The screen says so where the choice is made: an email
*To* a list reads "This goes to everyone on the list who hasn't said no;
the newsletter goes only to subscribers." Calls asks the same place who
may be called or texted (`GET /persons?reach=call|text`).

| Channel | Never, whoever sends | And for some senders |
|---|---|---|
| **Email** | no address; an address that bounced for good or reported spam (the suppression list, until the desk lifts it) | **To a list**: never an address that left the newsletter (its own unsubscribe link, or the desk's *Remove*), do-not-email or do-not-contact — everyone else on it. **A ladder**: the same, and only an address on the newsletter list as subscribed. **The newsletter**: only an address on its list as subscribed (a list of addresses: it reads no tags). **A press release**: anyone on the media list (tagged media or influencer, any capitals) with an address, not do-not-email or do-not-contact — someone who left the newsletter still gets releases (they leave the media list by a release's own link, and stay off it: a tag put back, a merge or a new record with that address doesn't send them another). **A shift's email** (a week's notice, a reminder, *Notify*): anyone booked on it with an address, not do-not-email or do-not-contact — leaving the newsletter doesn't stop it. **A calendar link they asked for**: to their own address, whatever their tags |
| **Text** | do-not-contact; do-not-text; no number, or one that can't be dialled; a number that replied STOP | As it goes out (a list's text, a ladder's, a shift's notice or reminder): a number that asked to stop in words ("please stop texting me"), until it texts START. **A ladder**: also someone whose last word on a website form was no to texts, and a number a teammate is texting now |
| **Call** (a phone bank, Calls, and every Call link on a screen) | no number; do-not-contact; do-not-call | — |

A do-not tag counts whatever its capitals. An email or a text to a list
goes once to an address or a number, however many people on it share it
(and a list's numbers count it so). A new reason is one line in its
channel, and every send, count and phone bank follows it. Shift notices and
reminders (`server/ext/schedule`) and the one-shift *Notify* leave out an
address that bounced or reported spam too.

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
| `STARBASE_TILE_PROVIDER` | a provider by name: `stadia` (Stadia Maps' Alidade Smooth — its address, credit and zoom 20 filled in; `STARBASE_TILE_URL` wins over it) | — |
| `STARBASE_TILE_KEY` | the named provider's key, added as `?api_key=` (phones can see it — use only where the provider can't be told the campaign's own web address) | — |
| `STARBASE_TILE_CARTO_KEY` | the campaign's free CARTO basemap key: the *Clean* look is offered (and the map opens on it) only with it, and it is added to every CARTO address (phones can see it) | — (no Clean) |
| `STARBASE_TILE_CLEAN` | `off`: never offer CARTO, key or not (the free map behind Google stays, OpenStreetMap's) | — |
| `GOOGLE_MAPS_SERVER_KEY` | Google's key (Map Tiles API, Places API (New)): Google is the map whenever it is set. **Before this goes to staging, tell us Google or the free map for canvassing. With a key already set, Google becomes the map and phones stop keeping street maps offline.** | — |
| `GOOGLE_MAPS_TILES` | `off` keeps the free map with a key set (`1` also turns Google on) | unset: on with a key |
| `GOOGLE_TILES_DAILY_MAX` | Google tiles a day (the campaign's day); then the free map until midnight | none |
| `ADDRESS_SUGGEST` | `google` (only after counsel's written yes and with Google's logo in the build), `bc`, `nominatim`, `off` | unset: `GEOCODER`'s suggester, never Google |
| `GOOGLE_PLACES_DAILY_MAX`, `GOOGLE_PLACES_PER_PERSON` | Google address asks a day, and per person | `300`, `50` |

A bad value falls back to the default (and logs once); desk roles see which
tiles took on the map's filter sheet (*Map tiles: OpenStreetMap — custom
address ignored*).

**When the street map isn't loading** the map says so. It listens to its
tiles: a view where most of them failed, or six seconds with not one (or,
six seconds after the map last moved, tiles still out and not one street of
that zoom on screen — a host that never answers keeps the earlier view
open; back over streets the phone kept, or once slow tiles have come after
all, that is taken back), and —
once in a page's life — it switches to its other provider by itself (the
*Clean* look's CARTO ↔ the standard tiles) with a line under the count
saying it did (*The street map wasn’t loading — switched to Muted*), but
only if that provider answers (one tile asked of it first): with weak
signal neither does, and the street map the phone kept stays drawn. If the
other doesn't answer, or there is no second provider (a campaign's own,
Google's has the free map: below), *The street map isn’t loading* stays
under the count with one tap: *Try again*, or *Try Clean* / *Try Muted*
only when that provider has just answered. A manager also gets a quiet
*Why?* there, which opens the Map check.
**When the street map loads but shows no streets** — a provider that answers
every tile with the same notice picture (CARTO without a key: "API KEY
REQUIRED"; a lapsed account; a block) — the page finds it once its first
tiles are in: it asks two of that provider's tiles for one place, far apart
in zoom (`tileProbe.js`, once per address per page, from the browser's
cache where it has them, never Google's), and the same picture is a notice.
The map then switches by itself as above (*The street map wasn’t showing
streets — switched to Muted*) or says *The street map isn’t showing
streets* (`data-tiles="notice"`), and the Map check names it and shows the
tile under the map's middle as this phone got it.
**With Google Maps on, volunteers keep streets while Google is down:** the
map turns to the free map by itself (*Google Maps isn’t loading — showing
the free map*) and back once Google answers: CARTO's with its key,
otherwise OpenStreetMap's, always there. The free map is never a look to
pick. A provider of
the campaign's own has none: election-week traffic is never sent back to
the free tiles. The person's own choice of look is only changed by their
tap, and a look tapped there only once its streets come. The streets a
phone keeps are its pick's, so the pick is what the map draws with no
signal, and what it goes back to when the look it switched to stops
loading too (that is the signal, not a provider) or the pick answers again
— asked every minute, and when signal comes back.
Behind the tiles is the app's paper, not grey. A big list's answers for a
view (`/api/map/density`, `/api/map/doors?bbox`) come gzipped — the
far-out picture of a rated city list is a megabyte of numbers, about a
fifth of that over the wire. Choose the provider before election week:
[GOING-LIVE.md](GOING-LIVE.md), section 5.

**The map's look** is each person's own (Show → *Map*, kept on that
browser, and only when they tap one): *Standard* (what the map opens on);
*Clean* (only with `STARBASE_TILE_CARTO_KEY`, and then the map opens on it:
CARTO's light map of the same OpenStreetMap streets, without shop icons,
parking lots or house numbers — `STARBASE_TILE_CLEAN=off` leaves it out;
check CARTO's terms for your volume; a phone that saved Clean draws
Standard while it isn't offered); *Muted* (grey streets, so the doors stand out) and
*Dark* (for night), drawn over any tiles; and with Google Maps on, its
other looks too — *Satellite*, *Terrain* (or *Streets*), each through the
same key.

**On a desk the Map fills the window** beside the menu: no margins and no
frame (1208 × 900 at 1440 × 900); the menu keeps its words. A phone's Map
was already full-bleed and is unchanged.

**The front page's map** (`MapWindow`, one row that folds and opens it in
place, kept per browser and open the first time). On field Today, under the
one big button, a volunteer or candidate with a walk list with doors left
sees that turf's doors (a dot in the household's colour) and their turfs'
outlines, read by `GET /api/map/doors?mine=1` — only the doors inside the
caller's own turfs and their own record, by the turfs' boxes and the email
index, never a count over the whole list — and kept on the phone. (The
rest of a volunteer's Today counts nothing over the list either: their
`/api/brief` leaves out the people total, the support picture and, off a
voting day, the voted totals; on one, the GOTV card's numbers are counted
once per campaign and shared for half a minute, and a vote mark counts them
again at once.) The
desk's Today has a full-width band of every turf's outline
(`/api/turfs?outline=1`, nobody read). Either is a picture to glance at: it
never takes the page's swipe, the whole of it opens the Map (*Open the
map*), its map (and Leaflet) loads only while open, and a load that fails
says *Unavailable — Try again* in the box, never taking Today down. It
draws the Map's own look, but never Google's billed tiles: over Google, the
free map. One line under it says when the street map isn't loading or
shows a notice, or that there is no signal.

**Doors on the map.** From street zoom (18) every door is a pin, with its
household and sign flags; one zoom further out a door with room around it
already has its pin. Further out every door is a small dot in its band's
colour (support, undecided, opposed; slate for not asked yet, dark enough
to read on any base map, and from zoom 14 every dot wears a white ring),
drawn on canvas tiles so a whole voter file pans smoothly; at 16 a door
with a sign flies a little flag, at 17 a household's size is on its dot. A
tap near a dot opens that door (or zooms in, further out). Up to
`STARBASE_MAP_ALL` (5,000) located people the map loads them all at once
(and keeps a copy on the phone). A bigger list is asked for by the part of
the map on screen (the screen and 15% more, counted first): from zoom 14
door by door — the people themselves where they fit (2,400 in a view, 8,000
at street zoom), else every door a dot (up to 25,000), else patches and
*Zoom in to see each door* — and from further out as a picture: every patch
with people in it a shaded square, darker the more people, in the colour of
support only as far as the people there are rated. Under the count a key
names the colours and says what a mark is (*Each square is a block — zoom
in for doors*); the count says *people* or *doors* and counts what is on
screen. While an answer is on its way what was drawn stays, with *Loading…*
beside the count; one that doesn't come says *Unavailable — Try again* (not
on *My turf*: a volunteer's own doors come whole, and the list's answers
aren't drawn there).

The map opens on the campaign's own list: where its people are inside the
campaign's area (`STARBASE_GEO_BOUNDS`) when most of them are, else the
middle of the list — a few addresses in another city don't zoom it out to
the province. **Whole list** goes back there from anywhere, and a view
with nobody on screen says *Nobody on file here · Back to your list* (one
rating picked and none of it there is *0 doors*, not that). A
link to one person (`/map?person=…`) always shows that door and its card,
however busy the place. Turfs and walk lists read only the people inside
each turf. The map asks for turfs as names and outlines
(`GET /api/turfs?outline=1`) and for one turf's counts when its sheet opens
(`GET /api/turfs/:id`: *Loading…* until they are in, never *No doors* on
the way) — with 158 turfs over 300,000 people the outlines answer in 6 ms,
where every turf counted took 3.6 s and held the outlines up. (A
volunteer's own few turfs still come whole, and stay on the phone.)

**Map check** (managers: Show → *Map check*; `GET /api/map/check`,
`server/ext/mapcheck`). One sheet with what the map is drawn from: people on
file, on the map and not (waiting for a pin; with no address), the placing
run, how many live outside the campaign's area, the turfs, the street map in
use and how many of its tiles loaded and failed, this page's build against
the server's, the map's size on screen. The line that applies is flagged, so
a screenshot of it says which trouble a map has.

Older browsers: every `dvh` height in the map's sheet has the same in `vh`
before it, and the sidebar's room and the map's width come from classes the
shell sets (`web/src/layout.js`) as well as `:has()`.

**Google Maps** instead: whenever a `GOOGLE_MAPS_SERVER_KEY` with the **Map
Tiles API** enabled is set, unless `GOOGLE_MAPS_TILES=off`
(`GOOGLE_MAPS_TILE_TYPE` roadmap | satellite | terrain). Before this goes to
staging, tell us Google or the free map for canvassing. With a key already
set, Google becomes the map and phones stop keeping street maps offline;
set `GOOGLE_MAPS_TILES=off` to keep the free map. Google hands tiles out against a session, so the map
draws `/tiles/{z}/{x}/{y}.png` from base.win (signed in), which fetches
each tile from Google with a session it keeps for everyone and renews
(`server/lib/gtiles.js`, served by `server/ext/offline`), credited to
Google, up to zoom 22, with Google's own cache header (made private). The
service worker does not keep them (Google's terms allow no offline use), so
with no signal a Google map shows the doors on a blank background. Today's
Google calls are counted in `google_usage` (`server/lib/gusage.js`: a date,
a kind, a number; kept across restarts) for the daily ceilings and
Settings → Services. When Google refuses, its words are kept in plain ones
with the setup step that fixes them (`server/lib/googleerr.js`, shown by
Settings → Services → Map background → Check), and no call goes to Google
for a minute (tiles answer 503). Google bills per tile past its free allowance, and its
terms have their own rules on attribution and caching — check them before
election week. For the free providers, the service worker
keeps the tiles a phone has already looked at (about 1,500, oldest out), so a
turf viewed with signal still draws offline; it never fetches tiles ahead. A
tile it can't fetch and never kept is a failed tile, as without the worker —
not a blank square that counts as loaded.

With no signal, field work saves on the phone and sends once, in order, when
the signal is back: knocks, new people and doors (staff), dropped pins, sign
requests and their Undo, *Count me in* / *Can't make it* and a volunteer's
own hours on a shift. The map's doors,
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
| `SITE_SECRET` | signs the website's preview and email-preference links (16+ characters); each campaign's signing secret for a ladder's *Send to a web address* step is made from it, so changing it changes that secret and breaks those links in every email already sent — to change only the signing secret, the step's *Make a new secret* (INTEGRATIONS.md) | blank: one is made and kept in the database |

Two environments per client: **staging** deploys every push to `main`,
**production** deploys the `production` branch, which the *Promote to
production* workflow (GitHub → Actions) fast-forwards to `main` once CI is
green there. `render.yaml` holds the pair for one client; another client is
another pair with its own names and values (GOING-LIVE.md, *A new client*).

**A page open across a deploy.** Every `/api` answer names the web build the
server hands out (`X-Build`; `/api/health` shows it as `build`). A page that
sees a name that is not its own says *A new version is ready · Reload*
under the nav, and its next link is a full page load; one just opened and
not yet touched (the page a phone kept while the server was slow) takes the
new page by itself. A screen whose file is gone — a missing `/assets` file
is a 404 — reloads the page once, and one that cannot load at all says
*This screen didn't load · Reload* with the nav still there: never a blank
page. The service worker keeps the files of the build before for a day, so
a tab that hasn't caught up can still open its screens.


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
