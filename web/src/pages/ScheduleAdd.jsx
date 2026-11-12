// Shifts → Week → "+": the one sheet that makes shifts, and nothing in it
// has to be typed.
//
//   What        tiles, one a kind of shift (shared/shiftkinds.js). The kind
//               brings its usual hours, its name and the role it prefers.
//   Where       chips — turfs, places used before, or a point on the map
//               (ScheduleWhere.jsx).
//   Which days  the seven days of the week on screen, several at once, and
//               "Weekdays".
//   When        the kind's usual hours, the first already chosen; or
//               another time by tap (ScheduleWhen.jsx).
//   Repeat      Just this week · Every week for 4 weeks · Every week until
//               election day, when the campaign has set one (GET
//               /voted/status).
//   "Add 5 shifts" — one write (shift.createMany): all of them or none.
//
// Nothing asks how many people, and no shift is given a number: "More"
// (closed) holds what is typed or rare — a name, instructions, a link, "We
// need" (a target that never turns anyone away, by tap; what the kind
// usually wants is only the first number offered), "Limit sign-ups to",
// "Drop in any time" and "Show on the website". "More options" there is the long form
// (/shifts?new=1).
import { useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { addDays, spanWords, weekdayIndex } from '@starbase/shared/dayparts';
import {
  MAX_SHIFTS, MAX_WEEKS, SHIFT_KINDS, madeTitle, repeatDays, shiftKind,
} from '@starbase/shared/shiftkinds';
import { apiGet, action } from '../api.js';
import { NeedsSignal, useOnline } from '../components/NoSignal.jsx';
import { KindIcon, kindVars } from '../components/ShiftKind.jsx';
import { normalizeLink } from '../components/shiftLink.js';
import NeedChips from './ScheduleNeed.jsx';
import Sheet from './ScheduleSheet.jsx';
import When, { timeInput, timesOf, whenFor } from './ScheduleWhen.jsx';
import Where, { NOWHERE, whereInput, whereName } from './ScheduleWhere.jsx';
import { dayWords, daysWords, plural } from './ScheduleWords.js';

// A whole number 1 or more from a box, null when it's empty, NaN otherwise.
const wholeOf = (v) => {
  const t = String(v ?? '').trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 1 && n <= 999 ? n : NaN;
};

export default function ScheduleAdd({ me, days, today, day = null, onClose, onAdded }) {
  const moreId = useId();
  const canMap = (me?.areas ?? []).includes('map');
  // What may still be scheduled from this week: today and after.
  const open = days.filter((d) => d >= today);
  const [kindCode, setKindCode] = useState(null);
  const [tiles, setTiles] = useState(true);
  const [where, setWhere] = useState(NOWHERE);
  const [picked, setPicked] = useState(() => (day && open.includes(day) ? [day] : []));
  const [when, setWhen] = useState(null);
  const [repeat, setRepeat] = useState('once');
  const [more, setMore] = useState(false);
  const [f, setF] = useState({ name: '', instructions: '', link: '', capacity: '', public: false, drop_in: false });
  const [need, setNeed] = useState(null); // no target until someone taps one
  const [busy, setBusy] = useState(false);
  const sending = useRef(false); // a second tap before the button greys out
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF((cur) => ({ ...cur, [k]: e.target.value }));
  const voted = useQuery({ queryKey: ['voted', 'status'], queryFn: () => apiGet('/voted/status'), staleTime: 60_000, meta: { side: true } });

  const kind = shiftKind(kindCode);
  const pickKind = (k) => {
    setKindCode(k.code);
    setTiles(false);
    setError(null);
    if (k.code === kindCode) return;
    // Its own usual hours and places — and no target: that is never assumed.
    setWhen(whenFor(k));
    setWhere(NOWHERE);
    setNeed(null);
  };

  // ── Which days ──
  const toggleDay = (d) => setPicked((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort()));
  const weekdays = open.filter((d) => weekdayIndex(d) < 5);
  const allWeekdays = weekdays.length > 0 && weekdays.every((d) => picked.includes(d));
  const toggleWeekdays = () => setPicked((cur) => (allWeekdays
    ? cur.filter((d) => !weekdays.includes(d))
    : [...new Set([...cur, ...weekdays])].sort()));

  // ── Repeat ──
  const first = picked[0] || open[0] || days[0];
  const electionDay = voted.data?.election_day || null;
  // Offered when it makes at least one more week, and no more than a call may.
  const untilElection = electionDay && electionDay >= addDays(first, 7) && electionDay <= addDays(first, MAX_WEEKS * 7 - 1);
  const repeatInput = repeat === 'weeks4' ? { weeks: 4 } : repeat === 'election' && untilElection ? { until: electionDay } : null;

  const times = when ? timesOf(when) : [];
  const count = repeatDays(picked, repeatInput).length * times.length;
  const tooMany = count > MAX_SHIFTS;
  const title = kind ? (f.name.trim() || madeTitle(kind.code, whereName(where))) : null;
  const summary = kind && count > 0
    ? [title, daysWords(picked), times.map((t) => spanWords(t.start, t.end)).join(' and '),
      repeatInput?.weeks ? 'every week for 4 weeks' : repeatInput ? `every week until ${dayWords(electionDay).md}` : null].filter(Boolean).join(' · ')
    : null;

  // A signal blip keeps every choice made here; adding waits for the signal.
  const online = useOnline();
  const submit = async () => {
    const capacity = wholeOf(f.capacity);
    if (Number.isNaN(capacity)) { setMore(true); setError('Limit sign-ups to: a whole number, 1 or more'); return; }
    if (sending.current) return;
    sending.current = true;
    setError(null);
    setBusy(true);
    try {
      const res = await action('shift.createMany', {
        kind: kind.code,
        days: picked,
        ...(times.length === 1 ? timeInput(times[0]) : { slots: times.map(timeInput) }),
        ...(repeatInput ? { repeat: repeatInput } : {}),
        ...whereInput(where),
        ...(f.name.trim() ? { name: f.name.trim() } : {}),
        ...(f.instructions.trim() ? { instructions: f.instructions.trim() } : {}),
        ...(normalizeLink(f.link) ? { link: normalizeLink(f.link) } : {}),
        ...(need ? { need } : {}),
        ...(capacity ? { capacity } : {}),
        ...(f.public ? { public: true } : {}),
        ...(f.drop_in ? { drop_in: true } : {}),
      });
      onAdded(res);
    } catch (e) {
      setError(e.message);
      setBusy(false);
      sending.current = false;
    }
  };

  const foot = (
    <>
      {summary && <p className="sch-summary" aria-live="polite">{summary}</p>}
      {tooMany && <p className="sch-note" role="status">That would make {count.toLocaleString('en-CA')} shifts — {MAX_SHIFTS} at most at a time.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {!online && <NeedsSignal className="sch-note">No signal — your choices stay; add when it’s back</NeedsSignal>}
      <button type="button" className="btn btn-primary ops-tap sch-go" disabled={busy || !kind || count === 0 || tooMany || !online} onClick={submit}>
        {busy ? 'Adding…' : count > 0 ? `Add ${plural(count, 'shift')}` : 'Add shifts'}
      </button>
    </>
  );

  return (
    <Sheet title="Add shifts" onClose={onClose} foot={foot}>
      <section className="sch-sec" aria-label="What">
        <h3 className="sch-label">What</h3>
        {tiles || !kind ? (
          <div className="sch-tiles" role="group" aria-label="Kind of shift">
            {SHIFT_KINDS.map((k) => (
              <button key={k.code} type="button" className="sch-tile" style={kindVars(k)} aria-pressed={k.code === kindCode} onClick={() => pickKind(k)}>
                <KindIcon kind={k} />
                <span>{k.label}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="sch-what">
            <span className="sch-what__kind" style={kindVars(kind)}><KindIcon kind={kind} />{kind.label}</span>
            <button type="button" className="btn btn-quiet sch-what__change" onClick={() => setTiles(true)}>Change</button>
          </div>
        )}
      </section>

      {kind && !tiles && (
        <>
          <section className="sch-sec" aria-label="Where">
            <h3 className="sch-label">Where</h3>
            <Where kind={kind} value={where} onChange={setWhere} canMap={canMap} />
          </section>

          <section className="sch-sec" aria-label="Which days">
            <h3 className="sch-label">Which days</h3>
            <div className="sch-chips sch-daychips" role="group" aria-label="Days">
              {days.map((d) => {
                const w = dayWords(d);
                return (
                  <button key={d} type="button" className="sch-chip sch-daychip" aria-pressed={picked.includes(d)} disabled={d < today}
                    aria-label={w.long} onClick={() => toggleDay(d)}>
                    <span>{w.wd}</span><b>{w.num}</b>
                  </button>
                );
              })}
            </div>
            {weekdays.length > 1 && (
              <div className="sch-chips">
                <button type="button" className="sch-chip" aria-pressed={allWeekdays} onClick={toggleWeekdays}>Weekdays</button>
              </div>
            )}
          </section>

          <section className="sch-sec" aria-label="When">
            <h3 className="sch-label">When</h3>
            <When kind={kind} value={when} onChange={setWhen} many />
          </section>

          <section className="sch-sec" aria-label="Repeat">
            <h3 className="sch-label">Repeat</h3>
            <div className="sch-chips" role="group" aria-label="Repeat">
              <button type="button" className="sch-chip" aria-pressed={!repeatInput} onClick={() => setRepeat('once')}>Just this week</button>
              <button type="button" className="sch-chip" aria-pressed={repeat === 'weeks4'} onClick={() => setRepeat('weeks4')}>Every week for 4 weeks</button>
              {untilElection && (
                <button type="button" className="sch-chip" aria-pressed={repeat === 'election'} onClick={() => setRepeat('election')}>
                  Every week until election day · {dayWords(electionDay).md}
                </button>
              )}
            </div>
          </section>

          <button type="button" className="disclose sch-more" aria-expanded={more} aria-controls={moreId} onClick={() => setMore((v) => !v)}>More</button>
          {more && (
            <div id={moreId} className="sch-more__body">
              <div className="field">
                <label htmlFor="sch-name">Name</label>
                <input id="sch-name" className="input" maxLength={300} placeholder={madeTitle(kind.code, whereName(where))} value={f.name} onChange={set('name')} />
                <span className="ops-meta">Left empty, it’s named for you</span>
              </div>
              <div className="field">
                <label htmlFor="sch-instructions">Instructions</label>
                <textarea id="sch-instructions" className="input" rows={3} placeholder="What to bring, who to ask for, parking…"
                  value={f.instructions} onChange={set('instructions')} />
              </div>
              <div className="field">
                <label htmlFor="sch-link">Link</label>
                <input id="sch-link" className="input" type="text" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  placeholder="Turf map, sign-up doc, call script" value={f.link} onChange={set('link')} />
              </div>
              <section className="sch-sec" aria-label="We need">
                <h3 className="sch-label">We need</h3>
                <NeedChips kind={kind} value={need} onChange={setNeed} />
              </section>
              <div className="field">
                <label htmlFor="sch-capacity">Limit sign-ups to</label>
                <input id="sch-capacity" className="input mono" type="number" min="1" step="1" inputMode="numeric" placeholder="No limit"
                  value={f.capacity} onChange={set('capacity')} />
              </div>
              <label className="ops-check">
                <input type="checkbox" checked={f.drop_in} onChange={(e) => setF((cur) => ({ ...cur, drop_in: e.target.checked }))} />
                <span><b>Drop in any time</b><span className="ops-meta">People come and go between these hours</span></span>
              </label>
              <label className="ops-check">
                <input type="checkbox" checked={f.public} onChange={(e) => setF((cur) => ({ ...cur, public: e.target.checked }))} />
                <span><b>Show on the website</b><span className="ops-meta">Anyone can see it there and sign up</span></span>
              </label>
              <Link to="/shifts?new=1" className="sch-options">More options</Link>
            </div>
          )}
        </>
      )}
    </Sheet>
  );
}
