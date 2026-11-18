// Today — the first screen, one job per role.
//   Volunteer: one big yellow button — "Start canvassing" (their walk list, or
//     the map), or "Make calls" once every walk list is done (the "All done"
//     turf line still opens the walk list) — then ONE shift line: "Your next
//     shift" only when they're on it, otherwise the next open shift with
//     "5 spots left" (→ that shift, where they join it). Signs waiting to go
//     up get one row (→ Signs to put up), new replies to their texts another
//     ("2 replies" → the Inbox), and a quiet "My people · 6" (→ the people
//     they know). One line of numbers, theirs first:
//     "You 6 · Team 38 doors this week" (brief field.mine: contacts they
//     logged; field: everyone's). Calls and texts in the same shape, a quiet
//     "Signs" row (always — the sign crew's way to /signs and "Add a sign"),
//     other turfs sit under "More". With no signal, "Start canvassing" opens the walk list kept on
//     this phone (Turfs.jsx's offline copy), else the turf list.
//   Desk: a simple front page, top to bottom (what applies today — the
//     sample, GOTV, getting started, follow-ups — at the top). Three big
//     numbers: Supporters (the scale's 1s and 2s; "of 12,000 needed" when
//     Path to win has a win number and this person may open it — brief.goal;
//     a tap opens the breakdown in place: the win number's lines, then the
//     support picture, opposed by candidate), Doors this week ›, Total
//     raised › (money roles). Under them MAP's map band across the page —
//     the walk lists' outlines, folding away (with the Map area) — and, for
//     managers, "Activity ›" (the old dashboard's screen). Then "Needs you"
//     (gifts over the limit, new volunteers, short shifts, signs to put up,
//     follow-ups, letters, requests from the doors, new texts, people who
//     moved, and "Connect email" for managers while email isn't set up) —
//     name first, the amount on the right, every row a tap to where it's
//     fixed — then Coming up (the next shift, filing dates), then Go to: six
//     everyday places one tap each (components/commands.js quickFor) and
//     "All places and people", which opens the search. Under a closed
//     "More": the week's and all-time lines, their walk lists, and "Clear
//     sample data". Getting started shows only the steps not done, and only
//     while the campaign is new. The page is the window's width (layout.js
//     page--wide) so the band runs across it; everything else keeps the
//     1,200 px column (home.css).
//   Candidate (a volunteer with a seat, me.candidate): "Your day" — one
//     button, "Met someone →" (Mainstreeting), then only the rows that have
//     something (their next booked shift, "Your week · 4", "My people · 6"),
//     then Your race (supporters, needed, days left, from Path to win), and
//     canvassing, calls and signs under "More".
//   Both: "Follow up" at the top when someone's been handed to them — a new
//     volunteer, a website message, an RSVP from someone new — with what
//     they did and the 24-hour clock, opening in place to call or text and
//     log how it went (components/FollowupsToday.jsx). The desk's "Needs
//     you" counts every open follow-up and how many are overdue.
// A nearly empty campaign gets a one-click sample dataset (managers); a quiet
// "Sample data is loaded" line stays at the top while it's there. Volunteers
// never see money.
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate, useOutletContext, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { allCodes, bandOf, ratingByCode } from '@starbase/shared/scale';
import { hoursOf } from '@starbase/shared/shifthours';
import { ApiError, apiGet, apiPost, fmtMoney } from '../api.js';
import { ratingWho, useScale } from '../components/RatingButtons.jsx';
import { useFollowupCount } from '../components/LaddersCount.js';
import FollowupsToday from '../components/FollowupsToday.jsx';
import { useTextingStatus } from '../components/TextingStatus.js';
import { NeedsSignal, useOnline } from '../components/NoSignal.jsx';
import { phoneCopy, useKeepCopy } from '../components/OfflineCache.js';
import { useRequestsCount } from '../components/RequestsCount.js';
import { useLettersCount } from '../components/LettersCount.js';
import { hasArea } from '../Shell.jsx';
import { MineAllTime } from '../components/FieldReportBits.jsx';
import { turfNames } from '../components/ShiftTurfs.jsx';
import { whenText, zoneOf } from '../components/shiftTime.js';
import { daysLeft, filingDay, filingSoon } from '../components/FilingWords.js';
import './today.css';
import './candidate.css';
import { at } from '../base.js';
import { NS } from '../base.js';
import { BRAND } from '../brand.js';
import MapWindow from '../components/MapWindow.jsx';
import { useVotedMode } from '../components/Voted.jsx';
import { gotvNoteCount } from '../components/gotvNotes.js';
import './gotv.css';
import { quickFor } from '../components/commands.js';
import { guideNow, guideSoon, useGuide } from '../components/guide.js';
import { guideState } from '@starbase/shared/voteguide';
import './home.css';

const greeting = () => {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
};

const STEP_ROUTES = { person: '/people?new=1', gift: '/money?new=1' };
// Who may do each getting-started step (server/actions/index.js: person.create
// and gift.log are desk roles).
const STEP_ROLES = {
  person: ['manager', 'treasurer', 'staff'],
  gift: ['manager', 'treasurer', 'staff'],
};

const plural = (n, word, many = `${word}s`) => (n === 1 ? word : many);
const num = (n) => (Number(n) || 0).toLocaleString('en-CA');
const DAY = 86_400_000;
const withinDays = (iso, days) => new Date(iso).getTime() - Date.now() < days * DAY;

// Big-number money: whole dollars, compact past $100k so it fits a phone tile.
const fmtBigMoney = (cents) => {
  const d = Math.round((Number(cents) || 0) / 100);
  if (d >= 1_000_000) return `$${(d / 1_000_000).toFixed(d >= 10_000_000 ? 0 : 1)}M`;
  if (d >= 100_000) return `$${Math.round(d / 1000)}k`;
  return `$${d.toLocaleString('en-CA')}`;
};

// api.js has no DELETE helper; same error contract as apiGet/apiPost.
const apiDelete = async (path) => {
  const res = await fetch(at(`/api${path}`), { method: 'DELETE', credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error || `request failed (${res.status})`);
  return body;
};

function useToast() {
  const [msg, setMsg] = useState(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  // Long enough to read: a long message (the sample clear's) stays longer.
  const show = (text) => {
    clearTimeout(timer.current);
    setMsg(text);
    timer.current = setTimeout(() => setMsg(null), Math.min(20000, 6000 + 50 * String(text || '').length));
  };
  const clear = () => { clearTimeout(timer.current); setMsg(null); };
  return { msg, show, clear };
}

const Chevron = () => <span className="today-chev" aria-hidden="true">›</span>;

// ── Sample data (managers, empty campaign) ──
function SampleCard({ onToast }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [already, setAlready] = useState(false);
  const online = useOnline();

  const load = async () => {
    setBusy(true);
    setError(null);
    setAlready(false);
    try {
      const r = await apiPost('/data/sample');
      await queryClient.invalidateQueries();
      onToast(`Sample data loaded — ${r.people ?? 52} people, ${r.signs ?? 0} signs, ${r.gifts ?? 0} gifts`);
    } catch (e) {
      if (e.status === 409) {
        // The server found sample-tagged people. Refresh; if the brief still
        // doesn't say "loaded", offer the clear right here.
        await queryClient.invalidateQueries();
        setAlready(true);
      } else {
        setError(`Couldn’t load sample data — ${e.message}`);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card today-sample" aria-label="Sample data">
      <p className="today-sample-lede">{BRAND.sampleLede}</p>
      <div className="today-actions">
        <button type="button" className="btn btn-primary today-tap" onClick={load} disabled={busy || !online}>
          {busy ? 'Loading…' : 'Load sample data'}
        </button>
        <Link to="/people/import" className="btn btn-quiet today-tap">Import your list</Link>
      </div>
      {!online && <NeedsSignal>Needs signal</NeedsSignal>}
      {error && <p className="error" role="alert">{error}</p>}
      {already && (
        <>
          <p className="error" role="alert">Sample people are already here. Clear them first.</p>
          <SampleClear onToast={onToast} onCleared={() => setAlready(false)} />
        </>
      )}
    </section>
  );
}

// The quiet line at the top while the sample is in. Clearing it lives under
// "More" (managers).
function SampleLine({ desk }) {
  return <p className="today-sample-line">{desk ? 'Sample data is loaded' : 'Sample data · made-up voters'}</p>;
}

// "Clear sample data" → "Remove all sample data? · Clear it · Keep it", in place.
function SampleClear({ onToast, onCleared }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const online = useOnline();
  // Keep focus where the hand is: on "Keep it" when the question opens, back
  // on the link when it closes.
  const keepRef = useRef(null);
  const openRef = useRef(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirming) keepRef.current?.focus();
    else if (wasConfirming.current) openRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  const clear = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiDelete('/data/sample');
      await queryClient.invalidateQueries();
      setConfirming(false);
      onCleared?.();
      // The server says exactly what went and what stayed (and why): verbatim.
      const said = typeof r?.message === 'string' && r.message.trim() ? r.message.trim() : null;
      onToast(said || `Sample data cleared${r.cleared ? ` — ${r.cleared} people removed` : ''}`);
    } catch (e) {
      setError(`Couldn’t clear sample data — ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  if (!confirming) {
    return (
      <div className="today-actions today-sample-clear">
        <button type="button" ref={openRef} className="btn today-tap" onClick={() => setConfirming(true)} disabled={!online}>
          Clear sample data
        </button>
        {!online && <NeedsSignal>Needs signal</NeedsSignal>}
      </div>
    );
  }
  return (
    <div className="today-confirm" role="group" aria-label="Clear sample data"
      onKeyDown={(e) => { if (e.key === 'Escape' && !busy) setConfirming(false); }}>
      <p>Remove all sample data? Your own records stay.</p>
      <div className="today-actions">
        <button type="button" className="btn today-tap today-danger" onClick={clear} disabled={busy || !online}>
          {busy ? 'Clearing…' : 'Clear it'}
        </button>
        <button type="button" ref={keepRef} className="btn btn-quiet today-tap" onClick={() => setConfirming(false)} disabled={busy}>
          Keep it
        </button>
      </div>
      {!online && <NeedsSignal>Needs signal</NeedsSignal>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

// ── Support picture: bands from the doorstep scale ──
const BANDS = [
  { band: 'support', label: 'Support' },
  { band: 'undecided', label: 'Undecided' },
  { band: 'opposed', label: 'Opposed' },
];

// The campaign's scale (its words and "Voting for?" list): every code it
// has, those off the list too, in list order — then any it doesn't know.
function supportPicture(scale, ratings) {
  const counts = { support: 0, undecided: 0, opposed: 0 };
  const variants = [];
  const codes = allCodes(scale);
  for (const code of [...codes, ...Object.keys(ratings || {}).filter((c) => !codes.includes(c))]) {
    const n = Number(ratings?.[code]) || 0;
    const band = bandOf(code);
    if (!band) continue;
    counts[band] += n;
    if (band === 'opposed' && n > 0) variants.push({ code, label: ratingByCode(scale, code)?.label, who: ratingWho(scale, code), n });
  }
  // Opposed, by who they back: biggest first, "Not sure" (plain 4) last.
  variants.sort((a, b) => (a.code === '4') - (b.code === '4') || b.n - a.n);
  const total = counts.support + counts.undecided + counts.opposed;
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  return { counts, variants, total, pct };
}

function SupportBar({ pic, size }) {
  const { counts, total, pct } = pic;
  if (!total) return null;
  const summary = BANDS.map((b) => `${b.label} ${counts[b.band]} (${pct(counts[b.band])}%)`).join(', ');
  return (
    <span className={`today-bar${size === 'small' ? ' is-small' : ''}`} role="img" aria-label={summary}>
      {BANDS.filter((b) => counts[b.band] > 0).map((b) => (
        <span key={b.band} data-band={b.band} style={{ flex: `${counts[b.band]} 1 0` }} />
      ))}
    </span>
  );
}

// Where supporters stand against the win number (brief.goal, Path to win's
// numbers): above the support picture, for whoever may open Path to win.
function GoalLines({ goal }) {
  if (!goal) return null;
  if (goal.unavailable) return <p className="today-goal">Path to win: Unavailable</p>;
  if (!goal.set) {
    return goal.can_set ? (
      <p className="today-goal">No win number yet · <Link to="/path-to-win" className="today-goal__set">Set it on Path to win ›</Link></p>
    ) : null;
  }
  const days = Number(goal.days_left) || 0;
  return (
    <div className="today-goal">
      <p>
        <strong>{goal.label}:</strong> {num(goal.supporters)} of {num(goal.needed)} supporters · {goal.still > 0 ? `${num(goal.still)} to go` : 'Win number reached ✓'}
      </p>
      {days > 0 && (
        <p>{num(days)} {plural(days, 'day')} left{goal.still > 0 && goal.per_week_needed != null && <> · about {num(goal.per_week_needed)} a week to get there</>}</p>
      )}
      {goal.others > 0 && <p className="muted">+ {num(goal.others)} more {plural(goal.others, 'race')} on Path to win</p>}
    </div>
  );
}

function SupportDetail({ pic, id, goal, map }) {
  const { counts, variants, total, pct } = pic;
  const showVariants = variants.some((v) => v.code !== '4');
  return (
    <section className="card today-support" id={id} aria-label="Support breakdown">
      <GoalLines goal={goal} />
      {total === 0 ? (
        <p className="today-empty">No ratings yet — every door fills this in.</p>
      ) : (
        <>
          <SupportBar pic={pic} />
          <ul className="today-legend">
            {BANDS.map((b) => (
              <li key={b.band}>
                <span className="sw" data-band={b.band} aria-hidden="true" />
                {b.label} <span className="mono">{num(counts[b.band])}</span>
                <span className="mono pct">{pct(counts[b.band])}%</span>
              </li>
            ))}
          </ul>
          {showVariants && (
            <ul className="today-variants" aria-label="Opposed, by who they vote for">
              {variants.map((v) => (
                <li key={v.code} title={v.label}>{v.who} <span className="mono">{num(v.n)}</span></li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="today-support-foot">
        <span className="mono muted">{num(total)} rated</span>
        <span className="today-support-links">
          {map && <Link to="/map" className="today-more-link">Open the map <Chevron /></Link>}
          {goal && <Link to="/path-to-win" className="today-more-link">Path to win <Chevron /></Link>}
        </span>
      </div>
    </section>
  );
}

// ── Desk: the three big numbers ──
function Numbers({ b, pic, me }) {
  const [params, setParams] = useSearchParams();
  const open = params.get('support') === '1';
  const detailId = useId();
  const toggle = () => {
    const next = new URLSearchParams(params);
    if (open) next.delete('support'); else next.set('support', '1');
    setParams(next, { replace: true });
  };
  const doors = Number(b.field?.doors) || 0;
  // Supporters: the scale's 1s and 2s (Path to win's rule), against the win
  // number when one is set and this person may see it (brief.goal).
  const supporters = (Number(b.ratings?.['1']) || 0) + (Number(b.ratings?.['2']) || 0);
  const goal = b.goal?.set ? b.goal : null;
  const big = goal || pic.total ? num(goal ? goal.supporters : supporters) : '—';
  const label = goal ? `Supporters ${big} of ${num(goal.needed)} needed`
    : pic.total ? `Supporters ${big}` : 'Supporters — no ratings yet';
  return (
    <>
      {/* Same shape as the rows: › goes to a screen, + opens here. */}
      <div className="today-nums">
        {/* A tile goes to its screen only for someone who may open it. */}
        {hasArea(me, 'map') ? (
          <Link to="/map" className="today-num">
            <span className="today-num__n">{num(doors)}</span>
            <span className="today-num__label">Doors this week<span className="today-num__go" aria-hidden="true">›</span></span>
          </Link>
        ) : (
          <div className="today-num today-num--plain">
            <span className="today-num__n">{num(doors)}</span>
            <span className="today-num__label">Doors this week</span>
          </div>
        )}
        <button type="button" className="today-num" aria-expanded={open} aria-controls={detailId} onClick={toggle} aria-label={label}>
          <span className="today-num__n">{big}</span>
          {goal && (
            <>
              <span className="today-progress today-num__bar" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, Number(goal.pct) || 0))}%` }} /></span>
              <span className="today-num__sub">of {num(goal.needed)} needed</span>
            </>
          )}
          <span className="today-num__label">Supporters<span className="today-num__plus" aria-hidden="true" /></span>
        </button>
        {b.money && hasArea(me, 'money') && (
          <Link to="/money" className="today-num" aria-label={`Total raised ${fmtMoney(b.money.totalCents)}`}>
            <span className="today-num__n">{fmtBigMoney(b.money.totalCents)}</span>
            <span className="today-num__label">Total raised<span className="today-num__go" aria-hidden="true">›</span></span>
          </Link>
        )}
      </div>
      {open && <SupportDetail pic={pic} id={detailId} goal={b.goal} map={hasArea(me, 'map')} />}
    </>
  );
}

// ── Desk: Needs you ──
// Every row is a tap to the screen where it's dealt with (no rows that open
// in place). Name first, the amount on the right — as on Money. The only
// reason a gift is flagged is the contribution limit (server/lib/gifts.js),
// so it says so in plain words — the same label as Money.
const OVER_LIMIT = 'Over limit';
// People who signed up on the public volunteer form (/v/…) carry this tag
// until someone follows up (server/routes/public.js).
const PROSPECT_TAG = 'volunteer-prospect';
const PROSPECT_MAX = 100;

function LinkRow({ to, state, main, chip, chipCls = 'chip', end, title }) {
  return (
    <li className="today-need">
      <Link to={to} state={state} className="today-row" title={title}>
        <span className="today-row__main">{main}</span>
        {chip && <span className={chipCls}>{chip}</span>}
        {end && <span className="today-row__end mono">{end}</span>}
        <Chevron />
      </Link>
    </li>
  );
}

// A screen opened from here says so on its back link ("← Today").
const FROM_TODAY = { from: { to: '/', label: 'Today' } };

// Letters to the editor (ext/letters): always there for a writer, with
// the campaign's replies they haven't read (brief.letters).
function LettersRow({ b }) {
  const n = Number(b.letters?.unseen) || 0;
  return <LinkRow to="/letters" main={n > 0 ? <>Your letters · <strong className="mono">{n}</strong> {n === 1 ? 'reply' : 'replies'}</> : 'Letters to the editor'} />;
}

// "Where to vote" (VG): the first row while the voter guide is published
// and not over, on a GOTV day or with the first voting day two weeks off.
// Reading it here also keeps the guide on the phone for when signal drops.
function useGuideOut() {
  const g = useGuide({ side: true }).data;
  if (!g || g.status === 'not_out' || !g.times) return null;
  const now = guideNow(g);
  const st = guideState(g.times, now, g.places);
  if (st.state === 'not_out' || st.state === 'over') return null;
  return { g, now };
}
function VoteInfoRow({ b }) {
  const out = useGuideOut();
  if (!out) return null;
  if (!b.voted?.on && !guideSoon(out.g, out.now)) return null;
  return <LinkRow to="/vote-info" state={FROM_TODAY} main="Where to vote" />;
}
// On a voting day the same tap sits in the GOTV card, above the map.
function GotvVoteLink() {
  return useGuideOut() ? <Link to="/vote-info" state={FROM_TODAY} className="btn today-gotv__btn">Where to vote</Link> : null;
}

// ── GOTV mode (ext/voted): on by hand, or by itself on an advance-voting day
// and election day. The day's one job, for everyone: the supporters who
// haven't voted yet — call them, or find their doors.
const GOTV_CALLS = '/calls?rating=1,2&voted=no';
function GotvCard({ v }) {
  const mode = useVotedMode();
  const left = Math.max(0, (Number(v.supporters) || 0) - (Number(v.supporters_voted) || 0));
  const pct = v.supporters ? Math.min(100, Math.round((v.supporters_voted / v.supporters) * 100)) : 0;
  const day = v.voting_day === 'election' ? 'Election day' : v.voting_day === 'advance' ? 'Advance voting' : 'GOTV';
  // Kept to their own turfs and phone bank, with neither (ext/voted scope).
  const noList = mode?.status?.has_list === false;
  return (
    <section className="today-gotv" aria-label="Get out the vote">
      <span className="eyebrow">Get out the vote · {day}</span>
      {mode?.practice && <span className="chip gv-practice">Practice</span>}
      {noList && <p className="today-gotv__n">No one on your list yet — ask the office for a turf or calls.</p>}
      <p className="today-gotv__n">
        <strong className="mono">{num(v.supporters_voted)}</strong> of {num(v.supporters)} supporters have voted
        {left > 0 && <> · <strong className="mono">{num(left)}</strong> to go</>}
      </p>
      <span className="today-progress today-gotv__bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
      <div className="today-gotv__acts">
        <Link to={GOTV_CALLS} className="btn today-gotv__btn">Call who hasn’t voted <span aria-hidden="true">→</span></Link>
        <Link to="/map?show=gotv" className="btn today-gotv__btn">Map: who hasn’t voted</Link>
        <GotvVoteLink />
      </div>
    </section>
  );
}

// "5 spots left" — the same words as the Shifts screen.
const spotsLeft = (n) => `${n} ${plural(n, 'spot')} left`;

function NeedsYou({ b, me }) {
  // New volunteers from the public form. Under ['persons'], so the People
  // screen's edits (taking the tag off) refresh the count.
  const prospects = useQuery({
    queryKey: ['persons', 'prospects'],
    queryFn: () => apiGet(`/persons?tag=${PROSPECT_TAG}&limit=${PROSPECT_MAX}`),
  });
  const newVols = prospects.data?.persons?.length ?? 0;
  const followups = useFollowupCount(); // ladder follow-ups for staff
  const requests = useRequestsCount(); // asked for at the doors (ext/requests)
  // Letters and op-eds volunteers sent in (ext/letters): the desk's, with Media.
  const letters = useLettersCount(hasArea(me, 'media'));
  // Texts waiting to be read: replies to yours, and numbers that wrote in.
  const newTexts = Number(useTextingStatus(me).data?.unread) || 0;
  // Each row only for someone who may open its screen (the server sends
  // none of these without the area; this keeps an older brief honest too).
  const flagged = hasArea(me, 'money') ? (b.flagged ?? []) : [];
  // Shifts in the next week short of the people they want: by their target
  // (which never turns anyone away), or by their limit on an older shift —
  // the server's list (brief.shortShifts). An older server sends none: then
  // the limit alone, from the next shifts.
  const shortShifts = (b.shortShifts ?? (b.shifts ?? [])
    .filter((s) => s.capacity && (Number(s.filled) || 0) < s.capacity && withinDays(s.starts_at, 7))
    .map((s) => ({ ...s, short: s.capacity - (Number(s.filled) || 0) })))
    .slice(0, 2)
    .filter(() => hasArea(me, 'shifts'));
  const tz = zoneOf(me);
  const signs = hasArea(me, 'signs') ? Number(b.signs?.requested) || 0 : 0;
  const shownFlags = flagged.length > 3 ? flagged.slice(0, 2) : flagged;
  const moreFlags = flagged.length - shownFlags.length;
  // Email not set up: the managers' to-do (Settings → Services). Texting is
  // optional — a campaign that never texts is never asked to.
  const connectEmail = me?.role === 'manager' && Boolean(b.providers) && !b.providers.email;
  // People who moved, waiting for a new address (ext/moves: People holders).
  const moved = Number(b.moved?.open) || 0;
  // The campaign's replies to letters this person wrote (brief.letters).
  const replies = Number(b.letters?.unseen) || 0;
  const empty = !flagged.length && !newVols && !shortShifts.length && !signs && !followups.n && !newTexts && !requests.n && !letters.n
    && !connectEmail && !moved && !replies;

  return (
    <section className="today-section" aria-labelledby="today-needs-h">
      <h2 className="today-h" id="today-needs-h">Needs you</h2>
      {(b.serverWarnings ?? []).map((w) => <p key={w} className="banner today-warning" role="alert">{w}</p>)}
      {empty ? (
        // Don't say "All caught up" before the volunteer count is in.
        prospects.isPending || followups.pending || requests.pending || letters.pending ? <p className="today-empty" aria-hidden="true">&nbsp;</p> : <p className="today-empty">All caught up.</p>
      ) : (
        <ul className="today-rows">
          {shownFlags.map((g) => (
            <LinkRow key={g.id} to={`/money?gift=${encodeURIComponent(g.id)}`} title={g.flag_reason || undefined}
              main={g.donor} chip={OVER_LIMIT} chipCls="chip chip-warn" end={fmtMoney(g.amount_cents)} />
          ))}
          {moreFlags > 0 && (
            <LinkRow to="/money" main={<><strong className="mono">{moreFlags}</strong> more {plural(moreFlags, 'gift')}</>}
              chip={OVER_LIMIT} chipCls="chip chip-warn" />
          )}
          {newVols > 0 && (
            <LinkRow to={`/people?tag=${PROSPECT_TAG}`}
              main={<><strong className="mono">{newVols >= PROSPECT_MAX ? `${PROSPECT_MAX}+` : newVols}</strong> new {plural(newVols, 'volunteer')}</>} />
          )}
          {shortShifts.map((s) => (
            <WhenRow key={s.id} to={`/shifts/${s.id}`} title={s.title} when={s.starts_at} tz={tz} warn
              extra={s.need ? `${Number(s.filled) || 0} of ${s.need} — ${s.short === 1 ? 'one' : s.short} more` : spotsLeft(s.short)} />
          ))}
          {signs > 0 && (
            <LinkRow to="/signs" main={<><strong className="mono">{signs}</strong> {plural(signs, 'sign')} to put up</>} />
          )}
          {followups.n > 0 && (
            <LinkRow to="/follow-ups" state={FROM_TODAY} main={<><strong className="mono">{followups.n}</strong> {plural(followups.n, 'follow-up')}</>}
              chip={followups.overdue > 0 ? `${followups.overdue} overdue` : null} chipCls="chip chip-danger" />
          )}
          {letters.n > 0 && (
            <LinkRow to="/media/letters" state={FROM_TODAY} main={<><strong className="mono">{letters.n}</strong> {plural(letters.n, 'letter')}</>} />
          )}
          {replies > 0 && (
            <LinkRow to="/letters" main={<><strong className="mono">{num(replies)}</strong> {plural(replies, 'reply', 'replies')} to your letters</>} />
          )}
          {requests.n > 0 && (
            <LinkRow to="/requests" state={FROM_TODAY} main={<><strong className="mono">{requests.n}</strong> {plural(requests.n, 'request')} from the doors</>} />
          )}
          {newTexts > 0 && (
            <LinkRow to="/inbox" state={FROM_TODAY} main={<><strong className="mono">{newTexts}</strong> new {plural(newTexts, 'text')}</>} />
          )}
          {moved > 0 && (
            <LinkRow to="/people?moved=open" main={<><strong className="mono">{num(moved)}</strong> moved — {moved === 1 ? 'needs' : 'need'} an address</>} />
          )}
          {connectEmail && <LinkRow to="/settings/services" main="Connect email" />}
        </ul>
      )}
    </section>
  );
}

// ── Coming up: one line each ──
// Two-line row: a small kicker, the title, the time. `fill` is a short plain
// count on the right ("12 going"); `extra` rides on the time line ("5 spots
// left", amber when `warn`) so a long title keeps the full width. Never a
// bare "3/8". The time is the campaign's (components/shiftTime.js).
function WhenRow({ to, kicker, title, when, tz, fill, extra, warn }) {
  return (
    <li className="today-need">
      <Link to={to} className="today-row">
        <span className="today-row__main">
          {kicker && <span className="today-row__kicker">{kicker}</span>}
          <span className="today-row__title">{title}</span>
          <span className="today-row__when">
            {whenText(when, tz)}
            {extra && <> · <span className={`today-row__extra${warn ? ' is-warn' : ''}`}>{extra}</span></>}
          </span>
        </span>
        {fill && <span className="today-fill mono">{fill}</span>}
        <Chevron />
      </Link>
    </li>
  );
}

// Desk: the campaign's next shift. Short shifts are already in "Needs you",
// so this is just what and when.
function ShiftRow({ shift, tz }) {
  if (!shift) return <LinkRow to="/shifts?add=1" main={<span className="muted">No shifts planned</span>} chip="Plan one" />;
  return <WhenRow to={`/shifts/${shift.id}`} kicker="Next shift" title={shift.title} when={shift.starts_at} tz={tz} />;
}

// ── Volunteer: which shifts am I on? ──
// GET /api/shifts marks each shift the caller is on (s.mine: their own
// supporter record, matched by login email, holds an active spot) — the same
// query (and key) as the Shifts screen. Only an older server leaves it out;
// then this falls back to finding their own record by email and reading its
// shifts.
const byStart = (a, b) => new Date(a.starts_at) - new Date(b.starts_at);
function useMyNextShift(me) {
  const shiftsQ = useQuery({ queryKey: ['shifts'], queryFn: () => apiGet('/shifts') });
  const rows = shiftsQ.data?.shifts;
  const marked = Array.isArray(rows) && rows.every((s) => typeof s.mine === 'boolean');
  const legacy = shiftsQ.isError || (shiftsQ.isSuccess && !marked);

  const email = String(me?.user?.email || '').trim().toLowerCase();
  const search = useQuery({
    queryKey: ['persons', 'search', email],
    queryFn: () => apiGet(`/persons?q=${encodeURIComponent(email)}&limit=8`),
    enabled: legacy && !!email,
  });
  const self = (search.data?.persons ?? []).find((p) => String(p.email || '').toLowerCase() === email);
  const person = useQuery({
    queryKey: ['person', self?.id],
    queryFn: () => apiGet(`/persons/${self.id}`),
    enabled: legacy && !!self,
  });

  const now = Date.now();
  const upcoming = (s) => new Date(s.starts_at).getTime() >= now;
  if (!legacy) {
    const next = shiftsQ.isSuccess ? (rows.filter((s) => s.mine && upcoming(s)).sort(byStart)[0] ?? null) : null;
    return { ready: shiftsQ.isSuccess, next };
  }
  const ready = !email || search.isError || (search.isSuccess && (!self || !person.isPending));
  const next = (person.data?.shifts ?? [])
    .filter((a) => a.status !== 'declined' && upcoming(a))
    .sort(byStart)[0] ?? null;
  return { ready, next };
}

// One line: the shift they're booked on — or, if none, the next shift that
// still needs people ("5 spots left" → that shift, where "Join" is). Never
// someone else's shift dressed up as theirs.
function VolunteerShiftRow({ shifts, me, turfs }) {
  const { ready, next } = useMyNextShift(me);
  const tz = zoneOf(me);
  if (!ready) return <li className="today-need today-row--wait" aria-hidden="true" />;
  // The shift's walk lists (brief.shiftTurfs): "Saturday canvass · Newton block".
  const names = (s) => turfNames(turfs?.[s.id] || []);
  if (next) {
    // Their own hours when they're doing only part of it (shared/shifthours.js).
    return <WhenRow to={`/shifts/${next.id}`} kicker="Your next shift" title={next.title} when={hoursOf(next, next).starts_at} tz={tz} extra={names(next) || undefined} />;
  }
  const open = shifts.find((s) => !s.capacity || (Number(s.filled) || 0) < s.capacity);
  if (!open) return <LinkRow to="/shifts" main={<span className="muted">No open shifts</span>} />;
  const left = open.capacity ? open.capacity - (Number(open.filled) || 0) : 0;
  return (
    <WhenRow to={`/shifts/${open.id}`} kicker="Open shift" title={open.title} when={open.starts_at} tz={tz}
      extra={[left ? spotsLeft(left) : null, names(open)].filter(Boolean).join(' · ') || null} />
  );
}

// ── Getting started: only the steps left, only while the campaign is new ──
function GettingStarted({ steps, role, navigate }) {
  return (
    <section className="card today-steps" aria-labelledby="today-steps-h">
      <h2 className="today-h" id="today-steps-h">Getting started</h2>
      <ul className="today-rows">
        {steps.map((s) => {
          const can = (STEP_ROLES[s.key] ?? []).includes(role);
          return (
            <li key={s.key} className="today-step">
              <span>{s.label}</span>
              {can
                ? <button type="button" className="btn today-tap" onClick={() => navigate(STEP_ROUTES[s.key])}>Do it</button>
                : <span className="muted today-step-who">A manager adds this</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── Walk lists (doors left from the shared ['turfs'] cache) ──
function useTurfStats(enabled) {
  const turfsQ = useQuery({ queryKey: ['turfs'], queryFn: () => apiGet('/turfs'), enabled });
  return Object.fromEntries((turfsQ.data?.turfs ?? []).map((t) => [t.id, t]));
}
// Every walk list knocked: each has 0 doors left (and there were doors).
const allTurfsDone = (turfs, statsById) => {
  if (!turfs.length) return false;
  const ds = turfs.map((t) => doorsLeft(statsById[t.id]));
  return ds.every((d) => d && d.left === 0) && ds.some((d) => d.doors > 0);
};
const doorsLeft = (stats) => {
  if (!stats) return null;
  const doors = Number(stats.doors) || 0;
  const done = Math.min(doors, Number(stats.doorsDone) || 0);
  // again: doors to try again in the open pass (ext/passes) — still in "left".
  return { doors, done, left: doors - done, pct: doors ? Math.round((done / doors) * 100) : 0, again: Number(stats.doorsAgain) || 0 };
};
// The map window's row: "North block · 1,204 doors left".
const leftLabel = (d) => {
  if (!d) return null;
  if (d.doors === 0) return 'No doors yet';
  return d.left === 0 ? 'All done' : `${d.left} ${plural(d.left, 'door')} left${d.again > 0 ? ` · ${d.again} to try again` : ''}`;
};

function TurfRows({ turfs, statsById }) {
  return (
    <ul className="today-rows">
      {turfs.map((t) => (
        <LinkRow key={t.id} to={`/turfs/${t.id}`} main={t.name} chip={leftLabel(doorsLeft(statsById[t.id]))} />
      ))}
    </ul>
  );
}

// ── No signal: the walk list kept on this phone ──
// Turfs.jsx keeps each walk list it loads (key below, one day, wiped on sign
// out) so /turfs/:id opens with no signal. With the brief offline, Today
// reads those keys to send "Start canvassing" to the most recently loaded
// one — never to an empty map. Read only; Turfs.jsx owns the format.
const FIELD_CACHE = `${NS}field:v1:`;
const FIELD_TTL = 24 * 3600 * 1000;
function cachedWalkList(me) {
  if (!me?.user?.id || !me?.workspace?.id) return null;
  const prefix = `${FIELD_CACHE}${me.workspace.id}:${me.user.id}:walk:`;
  let best = null;
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      const v = JSON.parse(localStorage.getItem(k) || 'null');
      if (!v?.data?.turf || !(Date.now() - v.at < FIELD_TTL)) continue;
      if (!best || v.at > best.at) best = { id: k.slice(prefix.length), at: v.at, name: v.data.turf.name };
    }
  } catch { return null; }
  return best;
}

function NoSignalToday({ me }) {
  const field = me.role === 'volunteer';
  const walk = field ? cachedWalkList(me) : null;
  return (
    <div className={`today${field ? ' today--field' : ''}`}>
      <span className="eyebrow">{greeting()}</span>
      <h1>{me.workspace.name}</h1>
      <p className="today-offline" role="status">
        {walk ? 'No signal — your walk list still works.' : 'No signal — this fills in when you’re back online.'}
      </p>
      {field && (
        <section className="today-go" aria-label="Canvass">
          <Link to={walk ? `/turfs/${walk.id}` : '/turfs'} className="btn btn-primary today-start">
            Start canvassing <span aria-hidden="true">→</span>
          </Link>
          {walk?.name && <p className="today-go__meta"><span className="today-go__turf">{walk.name}</span></p>}
        </section>
      )}
    </div>
  );
}

// ── Desk: Go to ──
// The places used every day, one tap each (commands.js QUICK, cut to six by
// this person's areas), and one button that opens the search for every
// other place and every person (the header's command bar, CommandBar.jsx).
function GoTo({ me, nav, b }) {
  const places = quickFor(me, nav ?? [], b);
  return (
    <section className="today-section today-goto" aria-labelledby="today-goto-h">
      <h2 className="today-h" id="today-goto-h">Go to</h2>
      {places.length > 0 && (
        <ul className="today-goto__grid">
          {places.map((p) => (
            <li key={p.to}>
              <Link to={p.to} className="today-goto__i"><span>{p.label}</span><Chevron /></Link>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn today-goto__search" aria-haspopup="dialog"
        onClick={() => window.dispatchEvent(new Event('base:search'))}>
        All places and people
      </button>
    </section>
  );
}

// Quiet disclosure at the bottom. Its contents aren't rendered until opened.
function More({ children }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <section className="today-morebox">
      <button type="button" className="today-morebox__toggle disclose" aria-expanded={open} aria-controls={id}
        onClick={() => setOpen((v) => !v)}>
        More
      </button>
      {open && <div className="today-morebox__body" id={id}>{children}</div>}
    </section>
  );
}

// "You 6 · Team 38 doors this week": their own count first, then everyone's
// (the brief's field.mine and field). The noun follows the team number
// (many: its plural when adding an s won't do — "doors lit").
function MineLine({ you, team, noun, many, small }) {
  const t = Number(team) || 0;
  return (
    <p className={`today-mine${small ? ' is-small' : ''}`}>
      <span className="today-mine__pair">You <strong className="today-mine__n">{num(you)}</strong></span>
      <span className="today-mine__dot"> · </span>
      <span className="today-mine__pair">Team <strong className="today-mine__n">{num(t)}</strong></span>
      {' '}<span className="today-mine__what">{plural(t, noun, many)} this week</span>
    </p>
  );
}

// ── Volunteer Today ──
function VolunteerToday({ b, me }) {
  const myTurfs = b.myTurfs ?? [];
  const statsById = useTurfStats(myTurfs.length > 0);
  // Start where there are doors left; otherwise the first turf; else the map.
  // Every walk list done: the one button turns to the phones.
  const done = allTurfsDone(myTurfs, statsById);
  const firstOpen = myTurfs.find((t) => (doorsLeft(statsById[t.id])?.left ?? 1) > 0) ?? myTurfs[0];
  const d = firstOpen ? doorsLeft(statsById[firstOpen.id]) : null;
  const others = done ? myTurfs : myTurfs.filter((t) => t !== firstOpen);
  const f = b.field ?? {};
  const mine = f.mine ?? {};
  const signs = Number(b.signs?.requested) || 0;
  const replies = Number(useTextingStatus(me).data?.unread) || 0; // replies to their texts
  // GOTV active for them (On, or Practice and they practise), and on duty at a voting place.
  const vm = useVotedMode();
  const duty = vm.on ? vm.status?.on_duty : null;
  const unsentNames = gotvNoteCount(me);

  return (
    <div className="today today--field">
      <span className="eyebrow">{greeting()}</span>
      <h1>{me.workspace.name}</h1>
      {b.sampleLoaded && <SampleLine />}
      {vm.on && b.voted && <GotvCard v={b.voted} />}
      {/* The people they're to reach within the day (speed to lead). */}
      <FollowupsToday me={me} />

      {duty ? (
        <>
          {/* On duty: entering names is the day's one job (the one primary);
              their canvass stays one quiet tap under it. */}
          <section className="today-go" aria-label="Who voted">
            <Link to="/gotv" className="btn btn-primary today-start">Enter who voted <span aria-hidden="true">→</span></Link>
            <p className="today-go__meta"><span className="today-go__turf">{duty.place?.name || 'Pick the voting place on each sheet'}</span></p>
          </section>
          {unsentNames > 0 && <ul className="today-rows"><LinkRow to="/gotv" main={`You have ${unsentNames} ${unsentNames === 1 ? 'name' : 'names'} not sent`} /></ul>}
          {firstOpen && (
            <ul className="today-rows">
              <LinkRow to={`/turfs/${firstOpen.id}`} main={`Your turf: ${firstOpen.name}${d ? ` · ${d.doors} ${d.doors === 1 ? 'door' : 'doors'}` : ''}`} />
            </ul>
          )}
        </>
      ) : done ? (
        <section className="today-go" aria-label="Calls">
          <Link to="/calls" className="btn btn-primary today-start">
            Make calls <span aria-hidden="true">→</span>
          </Link>
          {/* Still the way back to the walk list: re-check a door, open a profile. */}
          <Link to={myTurfs.length === 1 ? `/turfs/${myTurfs[0].id}` : '/turfs'} className="today-go__meta today-go__link">
            <span className="today-go__turf">{myTurfs.length === 1 ? myTurfs[0].name : `${myTurfs.length} walk lists`}</span>
            <span className="today-go__done">— All done <span aria-hidden="true">✓</span></span>
            <Chevron />
          </Link>
        </section>
      ) : (
        <section className="today-go" aria-label="Canvass">
          <Link to={firstOpen ? `/turfs/${firstOpen.id}` : '/map'} className="btn btn-primary today-start">
            {/* GOTV mode on (b.voted) is the day's job too, pass or not. */}
            {b.pass?.kind === 'gotv' || b.voted?.on ? 'Get out the vote' : 'Start canvassing'} <span aria-hidden="true">→</span>
          </Link>
          {firstOpen ? (
            <div className="today-go__meta">
              <span className="today-go__turf">{firstOpen.name}</span>
              {b.pass && <span className="muted"> · {b.pass.name}</span>}
              {d && <span className="mono">{leftLabel(d)}</span>}
              {d && d.doors > 0 && <span className="today-progress" aria-hidden="true"><span style={{ width: `${d.pct}%` }} /></span>}
            </div>
          ) : (
            <p className="today-go__meta muted">No walk list yet — pick a door on the map.</p>
          )}
        </section>
      )}
      {/* Names written at a voting place, still on this phone after the
          day's duty: judged by their own day on Who voted. */}
      {!duty && unsentNames > 0 && <ul className="today-rows"><LinkRow to="/gotv" main={`You have ${unsentNames} ${unsentNames === 1 ? 'name' : 'names'} not sent`} /></ul>}
      {/* Their walk list on a map that folds away (only with doors left). */}
      {firstOpen && !done && <MapWindow me={me} turfId={firstOpen.id} />}

      <ul className="today-rows today-next">
        <VoteInfoRow b={b} />
        <VolunteerShiftRow shifts={b.shifts ?? []} me={me} turfs={b.shiftTurfs} />
        {signs > 0 && (
          <LinkRow to="/signs" main={<><strong className="mono">{signs}</strong> {plural(signs, 'sign')} to put up</>} />
        )}
        {replies > 0 && (
          <LinkRow to="/inbox" state={FROM_TODAY} main={<><strong className="mono">{replies}</strong> {plural(replies, 'reply', 'replies')}</>} />
        )}
        {/* The people they know (brief.myPeople), to reach in person, by call or text. */}
        <LinkRow to="/mainstreet" main="Mainstreeting" />
        <LinkRow to="/my-people" state={FROM_TODAY}
          main={<>My people{b.myPeople ? <> · <strong className="mono">{b.myPeople}</strong></> : null}</>} />
        {/* Posts to share with their own link (brief.share, ext/socials). */}
        {Number(b.share?.kits) > 0 && (
          <LinkRow to="/share" state={FROM_TODAY}
            main={<>Share · <strong className="mono">{b.share.kits}</strong> {plural(b.share.kits, 'post')}</>} />
        )}
        <LettersRow b={b} />
      </ul>

      <MineLine you={mine.doors} team={f.doors} noun="door" />

      <More>
        <MineLine you={mine.calls} team={f.calls} noun="call" small />
        <MineLine you={mine.texts} team={f.texts} noun="text" small />
        {Number(b.inPerson?.week) > 0 && <MineLine you={b.inPerson.mine} team={b.inPerson.week} noun="in-person talk" small />}
        {Number(f.lit) > 0 && <MineLine you={mine.lit} team={f.lit} noun="door lit" many="doors lit" small />}
        <MineAllTime all={f.mine_all} />
        {/* Always here, signs waiting or not: the sign crew's way to Add a sign. */}
        <ul className="today-rows">
          <LinkRow to="/signs" main="Signs" />
        </ul>
        {others.length > 0 && (
          <>
            <h3 className="today-subh">{done ? 'Your walk lists' : 'Your other walk lists'}</h3>
            <TurfRows turfs={others} statsById={statsById} />
          </>
        )}
      </More>
    </div>
  );
}

// ── Candidate Today (me.candidate: a volunteer with a seat, ext/candidates) ──
// Their day: what they're booked on, "Met someone" (Mainstreeting), the
// people they know, and how their race stands. A row shows only when it has
// something; the race says Loading… or Unavailable, never a made-up 0.
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const WEEK = 7 * DAY;
// A race's number fits its tile on a phone: 100,000 and up reads "123K" or
// "1.2M" (the whole number is the tile's label and title).
const raceNum = (n) => (Number(n) >= 100_000
  ? Number(n).toLocaleString('en-CA', { notation: 'compact', maximumFractionDigits: 1 })
  : num(n));
// No copy on this phone and no signal to read one: the fetch waits (or,
// opened with no signal, fails).
const waitsForSignal = (q, online) => !q.data && (q.fetchStatus === 'paused' || !online);
function YourRace({ home, offline }) {
  if (offline) return <p className="muted cand-race" role="status">Your race: No signal</p>;
  if (home.isPending) return <p className="muted cand-race">Loading…</p>;
  const race = home.data?.race;
  if (home.isError || race?.unavailable) {
    return (
      <p className="cand-race cand-race__fail" role="status">
        <span className="muted">Your race: Unavailable</span>
        <button type="button" className="btn today-tap" onClick={() => home.refetch()} disabled={home.isFetching}>Try again</button>
      </p>
    );
  }
  if (!race) return null;
  const tiles = [
    ['Supporters', race.supporters],
    ['Needed', race.supporters_needed],
    ...(race.days_left != null ? [['Days left', race.days_left]] : []),
  ];
  return (
    <section className="cand-race" aria-label={`Your race: ${race.label}`}>
      <p className="cand-race__cap">Your race · {race.label}</p>
      <div className="today-nums">
        {tiles.map(([label, n]) => (
          <div key={label} className="today-num">
            <span className="today-num__n" title={num(n)}><span aria-hidden="true">{raceNum(n)}</span><span className="cand-sr">{num(n)}</span></span>
            <span className="today-num__label">{label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function CandidateToday({ b, me }) {
  // The same copy Call time keeps, so with no signal the day still opens.
  const home = useQuery({ queryKey: ['candidate-home'], queryFn: () => apiGet('/candidate/home'), ...phoneCopy(me, 'calltime-home') });
  useKeepCopy(me, 'calltime-home', home);
  const offline = waitsForSignal(home, useOnline());
  const { ready, next } = useMyNextShift(me);
  const shiftsQ = useQuery({ queryKey: ['shifts'], queryFn: () => apiGet('/shifts') });
  const now = Date.now();
  const week = (shiftsQ.data?.shifts ?? []).filter((s) => s.mine && new Date(s.starts_at).getTime() >= now
    && new Date(s.starts_at).getTime() < now + WEEK).length;
  const tz = zoneOf(me);
  const myTurfs = b.myTurfs ?? [];
  const turfStats = useTurfStats(myTurfs.length > 0);
  const candTurf = allTurfsDone(myTurfs, turfStats) ? null
    : myTurfs.find((t) => (doorsLeft(turfStats[t.id])?.left ?? 1) > 0) ?? null;
  const first = firstName(me.user?.name);
  // Call time (ext/candidates): while there are donors to call, it's the day's one button.
  const ct = home.data?.calltime;
  const calling = Number(ct?.left) > 0;
  // "5 to call · 2 lists": the first list's card counts only its own.
  const lists = (ct?.banks ?? []).filter((x) => Number(x.left) > 0).length;
  const money = (c) => fmtMoney(c).replace(/\.00$/, '');
  return (
    <div className="today today--field today--candidate">
      <span className="eyebrow">{greeting()}{first ? `, ${first}` : ''}</span>
      <h1>Your day</h1>
      {b.sampleLoaded && <SampleLine />}
      {b.voted?.on && <GotvCard v={b.voted} />}
      <FollowupsToday me={me} />

      {home.isPending && !offline ? (
        // Not "Met someone" first and call time a moment later: a quick tap
        // would go to the wrong place.
        <section className="today-go" aria-label="Loading">
          <button type="button" className="btn btn-primary today-start" disabled>Loading…</button>
        </section>
      ) : calling ? (
        <section className="today-go" aria-label="Call time">
          <Link to="/call-time" className="btn btn-primary today-start">
            Start call time <span aria-hidden="true">→</span>
          </Link>
          <p className="today-go__meta cand-go__meta">
            {num(ct.left)} to call{lists > 1 ? ` · ${num(lists)} lists` : ''}{Number(ct.pledged_week_cents) > 0 ? ` · ${money(ct.pledged_week_cents)} pledged this week` : ''}
          </p>
        </section>
      ) : (
        <section className="today-go" aria-label="Met someone">
          <Link to="/mainstreet" className="btn btn-primary today-start">
            Met someone <span aria-hidden="true">→</span>
          </Link>
          {/* No signal: Call time keeps its own list on the phone. */}
          {offline && (
            <p className="today-go__meta"><Link to="/call-time" className="btn today-tap">Call time</Link></p>
          )}
          {/* Call time couldn't be read: said, never silently gone. */}
          {home.isError && !offline && (
            <p className="today-go__meta cand-race__fail" role="status">
              <span className="muted">Call time: Unavailable</span>
              <button type="button" className="btn today-tap" onClick={() => home.refetch()} disabled={home.isFetching}>Try again</button>
            </p>
          )}
        </section>
      )}
      {candTurf && <MapWindow me={me} turfId={candTurf.id} />}

      <ul className="today-rows today-next">
        <VoteInfoRow b={b} />
        {calling && <LinkRow to="/mainstreet" main="Met someone" />}
        {!ready && <li className="today-need today-row--wait muted" role="status">Loading…</li>}
        {ready && next && (
          <WhenRow to={`/shifts/${next.id}`} kicker="Your next shift" title={next.title} when={hoursOf(next, next).starts_at} tz={tz}
            extra={turfNames(b.shiftTurfs?.[next.id] || []) || undefined} />
        )}
        {week > 0 && (
          <LinkRow to="/shifts" main={<>Your week · <strong className="mono">{num(week)}</strong></>} />
        )}
        {Number(b.myPeople) > 0 && (
          <LinkRow to="/my-people" state={FROM_TODAY}
            main={<>My people · <strong className="mono">{num(b.myPeople)}</strong></>} />
        )}
        {/* Their own link and the posts to share with it (ext/socials), as on a volunteer's day. */}
        {Number(b.share?.kits) > 0 && (
          <LinkRow to="/share" state={FROM_TODAY}
            main={<>Share · <strong className="mono">{num(b.share.kits)}</strong> {plural(Number(b.share.kits), 'post')}</>} />
        )}
        <LettersRow b={b} />
      </ul>

      <YourRace home={home} offline={offline} />

      <More>
        <ul className="today-rows">
          <LinkRow to={myTurfs.length === 1 ? `/turfs/${myTurfs[0].id}` : myTurfs.length ? '/turfs' : '/map'} main="Start canvassing" />
          <LinkRow to="/calls" main="Calls" />
          <LinkRow to="/signs" main="Signs" />
        </ul>
      </More>
    </div>
  );
}

// ── Desk Today ──
// Top to bottom: the name; what applies today (the sample, GOTV, getting
// started, follow-ups); three numbers; the walk lists' map across the page
// (MAP's band, with the Map area) and, for managers, "Activity ›" under it;
// Needs you; Coming up; Go to; a closed More. No primary button.
function DeskToday({ b, me, nav, toast }) {
  const navigate = useNavigate();
  const isManager = me?.role === 'manager';
  const myTurfs = b.myTurfs ?? [];
  const peopleTotal = Number(b.people?.total) || 0;
  const offerSample = isManager && !b.sampleLoaded && peopleTotal < 5;
  const scale = useScale();
  const pic = supportPicture(scale, b.ratings);
  const statsById = useTurfStats(myTurfs.length > 0);
  const f = b.field ?? {};

  // Only the steps left; the card goes once they're done, or the campaign
  // has five people (it's past the first day by then).
  const stepsLeft = (b.activation?.steps ?? []).filter((s) => !s.done);
  const showSteps = !b.activation?.complete && peopleTotal < 5 && stepsLeft.length > 0;

  return (
    <div className="today today-desk">
      <span className="eyebrow">{greeting()}</span>
      <h1>{me.workspace.name}</h1>

      {offerSample && <SampleCard onToast={toast.show} />}
      {b.sampleLoaded && <SampleLine desk />}
      {b.voted?.on && <GotvCard v={b.voted} />}
      {showSteps && <GettingStarted steps={stepsLeft} role={me?.role} navigate={navigate} />}
      {/* Their own people to reach within the day, before the numbers. */}
      <FollowupsToday me={me} />

      <Numbers b={b} pic={pic} me={me} />

      {/* MAP's band: the walk lists' outlines, across the page, folding away.
          The rest of the old dashboard (who is out, the chart, the teams) is
          the Activity screen, one tap under it for managers. */}
      {hasArea(me, 'map') && <MapWindow me={me} shape="band" />}
      {isManager && (
        <p className="today-under-band">
          <Link to="/activity" className="today-more-link">Activity <Chevron /></Link>
        </p>
      )}

      <NeedsYou b={b} me={me} />

      {/* Nothing of theirs to come (no Shifts, no filing dates): no heading over an empty list. */}
      {(hasArea(me, 'shifts') || (b.filing ?? []).length > 0) && (
      <section className="today-section" aria-labelledby="today-next-h">
        <h2 className="today-h" id="today-next-h">Coming up</h2>
        <ul className="today-rows">
          {hasArea(me, 'shifts') && <ShiftRow shift={(b.shifts ?? [])[0]} tz={zoneOf(me)} />}
          {/* The financial agent's filing dates within 30 days (ext/filingdates; money roles):
              what is due, its day under it (as a shift's time is), so a phone shows both whole. */}
          {(b.filing ?? []).map((d) => (
            <LinkRow key={`${d.name}|${d.due_on}`} to="/money"
              main={<><span className="today-row__title">{d.name}</span><span className="today-row__when">{filingDay(d.due_on)}</span></>}
              chip={daysLeft(d.days)} chipCls={filingSoon(d.days) ? 'chip chip-warn' : 'chip'} />
          ))}
        </ul>
      </section>
      )}

      <GoTo me={me} nav={nav} b={b} />

      <More>
        <p className="today-fieldline mono">
          This week: {num(f.calls)} {plural(Number(f.calls) || 0, 'call')} · {num(f.texts)} {plural(Number(f.texts) || 0, 'text')}
          {Number(b.inPerson?.week) > 0 && <> · {num(b.inPerson.week)} in person</>}
          {b.money && <> · {fmtMoney(b.money.weekCents)} raised</>}
        </p>
        <p className="today-fieldline mono">
          In all: {num(peopleTotal)} people
          {b.money && <> · {num(b.money.gifts)} {plural(b.money.gifts, 'gift')} · {fmtMoney(b.money.totalCents)}</>}
        </p>
        {myTurfs.length > 0 && (
          <>
            <h3 className="today-subh">{myTurfs.length === 1 ? 'Your walk list' : 'Your walk lists'}</h3>
            <TurfRows turfs={myTurfs} statsById={statsById} />
          </>
        )}
        {b.sampleLoaded && isManager && <SampleClear onToast={toast.show} />}
      </More>
    </div>
  );
}

export default function Today() {
  const { me, nav } = useOutletContext();
  const toast = useToast();
  const brief = useQuery({ queryKey: ['brief'], queryFn: () => apiGet('/brief') });

  // No signal: the query is paused (react-query knew it was offline) or the
  // fetch itself failed (a TypeError, not an ApiError). Either way it refetches
  // by itself once the phone is back online (main.jsx + react-query).
  const noSignal = !brief.data && (
    (brief.isPending && brief.fetchStatus === 'paused')
    || (brief.isError && !(brief.error instanceof ApiError))
  );
  if (noSignal) return <NoSignalToday me={me} />;
  if (brief.isError && !brief.data) {
    return (
      <div className="today">
        <p className="error" role="alert">Couldn’t load Today — {brief.error.message}</p>
        <button type="button" className="btn today-tap" onClick={() => brief.refetch()}>Try again</button>
      </div>
    );
  }
  // isPending, not isLoading: a query paused offline is pending but not
  // fetching, and brief.data would be undefined below.
  if (brief.isPending) return <p className="muted">Loading…</p>;
  const b = brief.data;
  const desk = me?.role !== 'volunteer';

  return (
    <>
      {desk ? <DeskToday b={b} me={me} nav={nav} toast={toast} />
        : me?.candidate ? <CandidateToday b={b} me={me} /> : <VolunteerToday b={b} me={me} />}
      {toast.msg && (
        <div className="toast today-toast" role="status">
          <span>{toast.msg}</span>
          <button type="button" className="btn" onClick={toast.clear}>OK</button>
        </div>
      )}
    </>
  );
}
