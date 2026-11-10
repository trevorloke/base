// Shifts → Week → tap a card: the shift, changed where you see it. The week
// stays put under the sheet, and nothing here has to be typed.
//
//   Day     the seven days of the week on screen — or drag the card itself
//           to another day (ShiftsBoard.jsx)
//   Time    the kind's usual hours, or another time by tap
//   Place   turfs, places used before, or a point on the map
//   More    "We need": how many people it wants — a target that never
//           turns anyone away — by tap
//   Save    one write: shift.update — or, for a repeating slot set to "This
//           and the following", shift.series.update (the ones changed on
//           their own are left alone)
// and under them: Tell them (shift.notify — emails and texts everyone on
// it), On the website (shift.public), Call off (shift.delete, or for the
// following ones shift.series.cancel: those nobody is on), Open shift (its
// own page: the crew, statuses, instructions).
//
// Nobody is told about a change by itself: after a move the week says how
// many have the old time, with "Tell them".
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { dayOf } from '@starbase/shared/dayparts';
import { kindOf } from '@starbase/shared/shiftkinds';
import { action } from '../api.js';
import { NotifyChip, notifySummary } from '../components/NotifyWords.jsx';
import { turfNames } from '../components/ShiftTurfs.jsx';
import Sheet from './ScheduleSheet.jsx';
import When, { timesOf, whenFor } from './ScheduleWhen.jsx';
import Where, { wherePatch } from './ScheduleWhere.jsx';
import { countWords, dayWords, peopleWords, plural, shiftClock, shiftSpan } from './ScheduleWords.js';

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
// "We need": the targets offered by tap (its own, when it is another number, joins them).
const NEEDS = [1, 2, 3, 4, 5, 6, 8, 10];

// Where the shift is now, as the Where chips read it. Words that are only
// its turfs' names are the turfs, not a place of their own.
const whereOf = (shift, turfs) => ({
  turfs: turfs.map((t) => ({ id: t.id, name: t.name })),
  place: shift.place_id ? { id: shift.place_id, name: shift.location || 'Saved place' } : null,
  words: !shift.place_id && shift.location && !same(shift.location, turfNames(turfs)) ? shift.location : null,
});

// turfs: the shift's own, or null when they couldn't be read — then they
// are not offered, so a save never changes what it can't see.
export default function ScheduleShift({
  me, shift, on = [], turfs = [], days, today, tz, tell = false, providers = null, onClose, onChanged, onGone,
}) {
  const kind = kindOf(shift);
  const canMap = (me?.areas ?? []).includes('map') && turfs !== null;
  const day0 = dayOf(shift.starts_at, tz);
  const at0 = shiftClock(shift, tz);
  const over = new Date(shift.ends_at || shift.starts_at) < new Date();
  const [where0] = useState(() => whereOf(shift, turfs ?? []));
  const [scope, setScope] = useState('one');
  const [day, setDay] = useState(day0);
  const [when, setWhen] = useState(() => whenFor(kind, at0));
  const [where, setWhere] = useState(where0);
  const need0 = shift.need ?? null;
  const [need, setNeed] = useState(need0);
  const [more, setMore] = useState(false);
  const moreId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // 'tell' | 'off' — the in-place question open under the quiet buttons.
  const [ask, setAsk] = useState(tell && on.length > 0 ? 'tell' : null);
  const [told, setTold] = useState(null);
  const [details, setDetails] = useState(false);
  const [onSite, setOnSite] = useState(Boolean(shift.public));
  const following = scope === 'following';

  // Only what changed is sent.
  const t = timesOf(when)[0] || null;
  const timePatch = t && (t.start !== at0.start || (t.end || null) !== (at0.end || null))
    ? { start: t.start, ...(t.end ? { end: t.end } : {}) } : {};
  const moves = { ...(day !== day0 ? { day } : {}), ...timePatch, ...wherePatch(where0, where) };
  const patch = { ...moves, ...(need !== need0 ? { need } : {}) };
  const dirty = Object.keys(patch).length > 0;

  const run = async (fn) => {
    setError(null);
    setBusy(true);
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const save = () => run(async () => {
    // People are only out of date when the day, the time or the place changed.
    const moved = on.length > 0 && Object.keys(moves).length > 0;
    if (following) {
      const res = await action('shift.series.update', { id: shift.id, patch });
      onChanged({
        text: `${plural(res.changed.length, 'shift')} changed${res.left ? ` · ${res.left} changed on their own left alone` : ''}`,
        tell: moved ? shift.id : null,
      });
    } else {
      await action('shift.update', { id: shift.id, ...patch });
      onChanged({
        text: moved ? `Saved — ${peopleWords(on.length)} ${on.length === 1 ? 'has' : 'have'} the old time or place` : 'Saved',
        tell: moved ? shift.id : null,
      });
    }
  });

  const callOff = () => run(async () => {
    if (following) {
      const res = await action('shift.series.cancel', { id: shift.id });
      const kept = res.kept.length;
      onGone({ text: `${plural(res.called_off.length, 'shift')} called off${kept ? ` · ${kept} still ${kept === 1 ? 'has' : 'have'} people on ${kept === 1 ? 'it' : 'them'}` : ''}` });
    } else {
      await action('shift.delete', { id: shift.id });
      onGone({ text: `${shift.title} called off` });
    }
  });

  const tellThem = () => run(async () => {
    const res = await action('shift.notify', { shift_id: shift.id });
    setTold(res.notified ?? []);
    setAsk(null);
    onChanged({ quiet: true });
  });

  const toggleSite = () => run(async () => {
    await action('shift.public', { id: shift.id, public: !onSite });
    setOnSite(!onSite);
    onChanged({ quiet: true });
  });

  const nothingSends = providers && !providers.email && !providers.text;
  const summary = told?.length ? notifySummary(told) : null;
  const sub = `${dayWords(day0).wd}, ${dayWords(day0).md} · ${shiftSpan(shift, tz)} · ${countWords(shift)}`;

  const foot = over ? null : (
    <>
      {error && <p className="error" role="alert">{error}</p>}
      <button type="button" className="btn btn-primary ops-tap sch-go" disabled={busy || !dirty} onClick={save}>
        {busy && dirty ? 'Saving…' : following ? 'Save this and the following' : 'Save'}
      </button>
    </>
  );

  return (
    <Sheet title={shift.title} sub={sub} onClose={onClose} foot={foot}>
      <p className="sch-onit">
        {on.length ? <><b>On it:</b> {on.map((a) => a.name).join(', ')}</> : 'Nobody on it yet.'}
      </p>

      {over ? <p className="sch-note">This shift is over.</p> : (
        <>
          {shift.series_id && (
            <section className="sch-sec" aria-label="Change">
              <h3 className="sch-label">It repeats — change</h3>
              <div className="ops-seg" role="group" aria-label="Which shifts">
                <button type="button" aria-pressed={!following} onClick={() => setScope('one')}>This one</button>
                <button type="button" aria-pressed={following} onClick={() => setScope('following')}>This and the following</button>
              </div>
            </section>
          )}

          <section className="sch-sec" aria-label="Day">
            <h3 className="sch-label">Day</h3>
            <div className="sch-chips sch-daychips" role="group" aria-label="Day">
              {days.map((d) => {
                const w = dayWords(d);
                return (
                  <button key={d} type="button" className="sch-chip sch-daychip" aria-pressed={d === day} disabled={d < today && d !== day0}
                    aria-label={w.long} onClick={() => setDay(d)}>
                    <span>{w.wd}</span><b>{w.num}</b>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="sch-sec" aria-label="Time">
            <h3 className="sch-label">Time</h3>
            <When kind={kind} value={when} onChange={setWhen} />
          </section>

          <section className="sch-sec" aria-label="Place">
            <h3 className="sch-label">Place</h3>
            <Where kind={kind} value={where} onChange={setWhere} canMap={canMap} />
          </section>

          <button type="button" className="disclose sch-more" aria-expanded={more} aria-controls={moreId} onClick={() => setMore((v) => !v)}>More</button>
          {more && (
            <section id={moreId} className="sch-sec sch-more__body" aria-label="We need">
              <h3 className="sch-label">We need</h3>
              <div className="sch-chips" role="group" aria-label="We need">
                <button type="button" className="sch-chip" aria-pressed={need === null} onClick={() => setNeed(null)}>No target</button>
                {[...new Set([...NEEDS, ...(need0 ? [need0] : [])])].sort((a, b) => a - b).map((n) => (
                  <button key={n} type="button" className="sch-chip" aria-pressed={need === n} onClick={() => setNeed(n)}>{n}</button>
                ))}
              </div>
              <span className="ops-meta">A target — nobody is turned away</span>
            </section>
          )}
        </>
      )}

      <section className="sch-sec sch-tools" aria-label="More for this shift">
        <div className="ops-actions">
          {!over && on.length > 0 && (
            <button type="button" className="btn ops-tap" disabled={busy} aria-expanded={ask === 'tell'}
              onClick={() => { setAsk(ask === 'tell' ? null : 'tell'); setTold(null); }}>
              Tell them
            </button>
          )}
          {!over && (
            <button type="button" className="btn ops-tap sch-toggle" aria-pressed={onSite} disabled={busy} onClick={toggleSite}>
              On the website
            </button>
          )}
          {!over && (
            <button type="button" className="btn ops-tap" disabled={busy} aria-expanded={ask === 'off'}
              onClick={() => setAsk(ask === 'off' ? null : 'off')}>
              Call off
            </button>
          )}
          <Link className="btn btn-quiet ops-tap ops-link" to={`/shifts/${shift.id}`} state={{ week: days[0] }}>Open shift</Link>
        </div>

        {ask === 'tell' && (
          <div className="ops-confirm sch-ask" role="group" aria-label="Tell them">
            <span>
              {nothingSends ? 'Email and texting aren’t connected — nothing would be sent.' : `Email and text ${peopleWords(on.length)} this shift as it is now?`}
            </span>
            {nothingSends
              ? <Link className="btn ops-tap" to="/outreach/connect?connect=1">Connect</Link>
              : <button type="button" className="btn ops-solid ops-tap" disabled={busy} onClick={tellThem}>{busy ? 'Sending…' : 'Send'}</button>}
            <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={() => setAsk(null)}>Cancel</button>
          </div>
        )}
        {dirty && ask === 'tell' && !nothingSends && <p className="sch-note">Save first, or they’re told the old time and place.</p>}

        {ask === 'off' && (
          <div className="ops-confirm sch-ask" role="group" aria-label="Call off">
            <span>
              {following
                ? 'Call off this one and the following ones nobody is on?'
                : `Call off this shift?${on.length ? ` ${peopleWords(on.length)} booked won’t be told — tell them first.` : ''}`}
            </span>
            <button type="button" className="btn ops-danger ops-tap" disabled={busy} onClick={callOff}>{busy ? 'Calling off…' : 'Call it off'}</button>
            <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={() => setAsk(null)}>Keep it</button>
          </div>
        )}

        {told && (told.length === 0 ? <p className="sch-note" role="status">Nobody to tell.</p> : (
          <>
            <p className={summary.ok ? 'ops-done' : 'ops-done ops-done--wait'} role="status">{summary.text}</p>
            <button type="button" className="ops-more disclose" aria-expanded={details} onClick={() => setDetails((v) => !v)}>Details</button>
            {details && (
              <ul className="ops-results" aria-label="How each went">
                {told.map((r) => (
                  <li key={r.person_id}>
                    <span>{r.name}</span>
                    <span className="chips"><NotifyChip channel="email" status={r.email} /><NotifyChip channel="text" status={r.text} /></span>
                  </li>
                ))}
              </ul>
            )}
          </>
        ))}
      </section>
    </Sheet>
  );
}
