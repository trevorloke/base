// Shifts → Week → "More": what is done to a whole week (server/ext/schedule).
//
//   Tell everyone on this week's shifts   one tap, after the count: "6
//       people · 12 shifts". One message a person, listing their own shifts
//       of the week (shift.tellWeek; a job sends them). Then how it went,
//       a person a row under Details.
//   Remind people the evening before      a switch, off until a manager
//       turns it on (shift.reminders): everyone booked for tomorrow gets
//       one reminder at 6 pm, inside the texting hours.
//   Copy to next week                     the same shifts a week on
//       (shift.copyWeek) — "With the same people?" first.
//
// <CopyLastWeek/> is the offer on a week with nothing in it.
//
// Every number is the server's (GET /schedule/week): "Loading…" until it
// answers, "Unavailable — Try again" when it can't.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays, fmtIn } from '@starbase/shared/dayparts';
import { apiGet, action } from '../api.js';
import { NotifyChip } from '../components/NotifyWords.jsx';
import { Unavailable } from './ScheduleSheet.jsx';
import { dayWords, peopleWords, plural } from './ScheduleWords.js';

export const weekWords = (monday) => `${dayWords(monday).md} – ${dayWords(addDays(monday, 6)).md}`;
export const weekKey = (monday) => ['schedule', 'week', monday];

// How a copy went, in one line.
const copiedWords = (r, to) => [
  r.shifts.length ? `${plural(r.shifts.length, 'shift')} copied to ${weekWords(to)}` : `Nothing new to copy to ${weekWords(to)}`,
  r.already ? `${r.already} already there` : null,
  r.past ? `${r.past} already over` : null,
  r.booked ? `${peopleWords(r.booked)} booked` : null,
  r.full ? `${r.full} didn’t fit a limit` : null,
  r.no_turfs ? 'turfs not copied — that needs Map & turfs' : null,
].filter(Boolean).join(' · ');

// "With the same people?" — then one write.
function CopyAsk({ from, to, words, onCopied, onCancel }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const copy = async (withPeople) => {
    setBusy(true);
    setError(null);
    try {
      const res = await action('shift.copyWeek', { from, to, with_people: withPeople });
      onCopied({ text: copiedWords(res, to), to });
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <div className="ops-confirm sch-ask" role="group" aria-label="Copy the week">
      <span>{words} With the same people?</span>
      <button type="button" className="btn ops-solid ops-tap" disabled={busy} onClick={() => copy(true)}>{busy ? 'Copying…' : 'With the people'}</button>
      <button type="button" className="btn ops-tap" disabled={busy} onClick={() => copy(false)}>Just the shifts</button>
      <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={onCancel}>Cancel</button>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

// An empty week's one offer: last week's shifts, when it had any.
export function CopyLastWeek({ monday, lastCount, online, onCopied }) {
  const [asking, setAsking] = useState(false);
  if (!lastCount) return null;
  return asking ? (
    <CopyAsk from={addDays(monday, -7)} to={monday} words={`Copy last week’s ${plural(lastCount, 'shift')} here?`}
      onCopied={onCopied} onCancel={() => setAsking(false)} />
  ) : (
    <button type="button" className="btn ops-tap" disabled={!online} onClick={() => setAsking(true)}>Copy last week</button>
  );
}

const stamp = (iso, tz) => fmtIn(iso, tz, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// One notice, a person a row.
function NoticeDetails({ batchId }) {
  const q = useQuery({ queryKey: ['schedule', 'notice', batchId], queryFn: () => apiGet(`/schedule/notices/${batchId}`) });
  if (q.isPending) return <p className="sch-note" role="status">Loading…</p>;
  if (q.isError) return <Unavailable onRetry={() => q.refetch()} />;
  return (
    <ul className="ops-results" aria-label="How each went">
      {q.data.people.map((p) => (
        <li key={p.person_id}>
          <span>{p.name}</span>
          <span className="chips">
            {p.state !== 'done' && <span className="chip">Not sent yet</span>}
            <NotifyChip channel="email" status={p.email} />
            <NotifyChip channel="text" status={p.text} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function TellWeek({ monday, tz, week, online, thisWeek }) {
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [details, setDetails] = useState(false);
  const d = week.data;
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await action('shift.tellWeek', { week: monday });
      setAsking(false);
      await queryClient.invalidateQueries({ queryKey: weekKey(monday) });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const none = !d.providers.email && !d.providers.text;
  const going = d.last && d.last.waiting > 0;
  const whose = thisWeek ? 'this week’s' : 'that week’s';

  return (
    <div className="sch-row">
      <div className="sch-row__main">
        <b>Tell everyone on {whose} shifts</b>
        <span className="ops-meta" role="status">
          {d.people ? `${peopleWords(d.people)} · ${plural(d.shifts, 'shift')}` : 'Nobody is on a shift still to come'}
        </span>
      </div>
      {!asking && (
        <button type="button" className="btn ops-tap" disabled={!online || !d.people || going} onClick={() => { setAsking(true); setError(null); }}>
          {d.last ? 'Tell them again' : 'Tell them'}
        </button>
      )}
      {asking && (none ? (
        <div className="ops-confirm sch-ask" role="group" aria-label="Tell everyone">
          <span>Email and texting aren’t connected — nothing would be sent.</span>
          <Link className="btn ops-tap" to="/outreach/connect?connect=1">Connect</Link>
          <button type="button" className="btn btn-quiet ops-tap" onClick={() => setAsking(false)}>Cancel</button>
        </div>
      ) : (
        <div className="ops-confirm sch-ask" role="group" aria-label="Tell everyone">
          <span>Send {peopleWords(d.people)} their own shifts for the week, by email and text?</span>
          <button type="button" className="btn ops-solid ops-tap" disabled={busy || !online} onClick={send}>{busy ? 'Sending…' : 'Send'}</button>
          <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={() => setAsking(false)}>Cancel</button>
          {!d.providers.email && <span className="ops-meta">Email isn’t connected — no emails will be sent.</span>}
          {!d.providers.text && <span className="ops-meta">Texting isn’t connected — no texts will be sent.</span>}
          {d.quiet?.now && <span className="ops-meta">Quiet hours — texts won’t be sent now (sending opens at {d.quiet.opens}).</span>}
          {!d.jobs && <span className="ops-meta">This server isn’t sending in the background — the notice will wait.</span>}
        </div>
      ))}
      {error && <p className="error" role="alert">{error}</p>}
      {d.last && (
        <div className="sch-last">
          <span className={!going && d.last.reached === d.last.people ? 'ops-done' : 'ops-done ops-done--wait'} role="status">
            {going
              ? `Going out — ${d.last.waiting} of ${d.last.people} to go…`
              : `${d.last.reached === d.last.people ? '✓ ' : ''}Reached ${d.last.reached} of ${d.last.people} · ${stamp(d.last.at, tz)}`}
          </span>
          <button type="button" className="ops-more disclose disclose--inline" aria-expanded={details} onClick={() => setDetails((v) => !v)}>Details</button>
          {details && <NoticeDetails batchId={d.last.batch_id} key={`${d.last.batch_id}:${d.last.waiting}`} />}
        </div>
      )}
    </div>
  );
}

function Reminders({ monday, tz, week, online }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const r = week.data.reminders;
  const none = !week.data.providers.email && !week.data.providers.text;
  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await action('shift.reminders', { on: !r.on });
      await queryClient.invalidateQueries({ queryKey: weekKey(monday) });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const state = !r.on ? 'Off'
    : none ? 'On — nothing sends until email or texting is connected'
      : r.next_at ? `On — next ${stamp(r.next_at, tz)}` : 'On';
  return (
    <div className="sch-row">
      <div className="sch-row__main">
        <b id="sch-remind">Remind people the evening before</b>
        <span className="ops-meta" role="status">{state}{!r.can_set && ' · a manager turns this on or off'}</span>
      </div>
      <button type="button" role="switch" className="sch-switch" aria-checked={r.on} aria-labelledby="sch-remind"
        disabled={busy || !online || !r.can_set} onClick={toggle}>
        <span className="sch-switch__knob" aria-hidden="true" />
      </button>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

export default function WeekMore({ id, monday, thisMonday, tz, week, count, online, onCopied }) {
  const [copying, setCopying] = useState(false);
  const next = addDays(monday, 7);
  return (
    <section id={id} className="card sch-weekmore" aria-label="More for this week">
      {week.isPending && <p className="sch-note" role="status">{week.fetchStatus === 'paused' ? 'Offline — loads with signal' : 'Loading…'}</p>}
      {week.isError && !week.data && <Unavailable onRetry={() => week.refetch()} />}
      {week.data && (
        <>
          <TellWeek monday={monday} tz={tz} week={week} online={online} thisWeek={monday === thisMonday} />
          <Reminders monday={monday} tz={tz} week={week} online={online} />
        </>
      )}
      <div className="sch-row">
        <div className="sch-row__main">
          <b>Copy to next week</b>
          <span className="ops-meta">{count ? `${plural(count, 'shift')} → ${weekWords(next)}` : 'Nothing here to copy'}</span>
        </div>
        {!copying && <button type="button" className="btn ops-tap" disabled={!online || !count} onClick={() => setCopying(true)}>Copy</button>}
        {copying && (
          <CopyAsk from={monday} to={next} words={`Copy ${plural(count, 'shift')} to ${weekWords(next)}?`}
            onCopied={(r) => { setCopying(false); onCopied(r); }} onCancel={() => setCopying(false)} />
        )}
      </div>
    </section>
  );
}
