// Calendar (both apps, every role): the campaign's calendar as it is for
// this person (server/ext/groupcal) — their own shifts, the website's
// events, the voting days, the filing dates for the money desk, and the
// items managers put on it for them. One month at a time, a list by day,
// on the campaign's clock; ?month=YYYY-MM is in the address.
// Each entry has "Add to Google Calendar" (a link that opens Google with it
// filled in). Under the list, the person's own calendar link (the card on
// Your profile), which keeps all of it in their calendar app.
// On the desk, managers add items and say who sees each (Edit / Remove on
// each); whoever has the Shifts board can show every shift that month.
// An end earlier than the start is the next day ("Ends the next day"), for
// an evening past midnight. An item for a team since deleted (or a seat
// since removed) keeps that choice on Edit, marked "(removed)".
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays, clockOf } from '@base-win/shared/dayparts';
import { action, apiGet } from '../api.js';
import { appMode } from '../mode.js';
import { timeRange, zoneOf } from '../components/shiftTime.js';
import { NeedsSignalLine, useOnline } from '../components/NoSignal.jsx';
import CalendarFeedCard from '../components/CalendarFeed.jsx';
import '../components/two-step.css';
import './calendar-page.css';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
// Days are written as days, not moments: no zone can move them.
const dayFmt = (opts) => new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: 'UTC' });
const dayWords = (day) => dayFmt({ weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${day}T12:00:00Z`));
const monthWords = (month) => dayFmt({ month: 'long', year: 'numeric' }).format(new Date(`${month}-15T12:00:00Z`));
const shiftMonth = (month, n) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};
const said = (m) => { const t = String(m || ''); return t.charAt(0).toUpperCase() + t.slice(1); };

const KIND = { shift: 'Your shift', event: 'Event', every: 'Shift', vote: 'Voting', filing: 'Filing date' };

function whenOf(e, tz) {
  if (e.allDay) return e.last_day && e.last_day !== e.day ? `All day, to ${dayWords(e.last_day)}` : 'All day';
  return timeRange(e.start, e.end, tz);
}

// ── The form: a new item, or one being changed ──
const blank = { title: '', all_day: false, day: '', last_day: '', start: '', end: '', place: '', details: '', who: 'everyone' };
const fromEntry = (e, tz) => ({
  title: e.title,
  all_day: e.allDay,
  day: e.day,
  last_day: e.allDay ? e.last_day || e.day : '',
  start: e.allDay ? '' : clockOf(e.start, tz),
  end: !e.allDay && e.end ? clockOf(e.end, tz) : '',
  place: e.where || '',
  details: e.details || '',
  who: e.value || 'everyone',
});
// Who the item is for now, when that is no longer a choice (a deleted team).
const whoLabelOf = (e) => e.who || '';
// An end earlier than the start: the next morning.
const endsNextDay = (f) => !f.all_day && Boolean(f.start && f.end) && f.end < f.start;

function ItemForm({ start, who: offered, tz, onDone, onCancel }) {
  const online = useOnline();
  const [f, setF] = useState(start.values);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const id = useId();
  const kept = start.values.who;
  const who = !kept || offered.some((w) => w.value === kept) ? offered : [...offered, { value: kept, label: start.whoLabel || kept }];
  const nextDay = endsNextDay(f);
  const firstRef = useRef(null);
  useEffect(() => { firstRef.current?.focus(); }, []);
  const set = (k) => (ev) => { setError(null); setF((x) => ({ ...x, [k]: ev.target.type === 'checkbox' ? ev.target.checked : ev.target.value })); };
  const save = async (ev) => {
    ev.preventDefault();
    setBusy(true); setError(null);
    const input = {
      title: f.title, all_day: f.all_day, day: f.day, who: f.who,
      place: f.place || null, details: f.details || null,
      ...(f.all_day ? { last_day: f.last_day || f.day } : { start: f.start || null, end: f.end || null, end_day: nextDay && f.day ? addDays(f.day, 1) : null }),
    };
    try {
      await action(start.id ? 'calendar.item.edit' : 'calendar.item.add', start.id ? { id: start.id, ...input } : input);
      onDone(start.id ? 'Saved' : 'Added');
    } catch (err) {
      setError(said(err.message));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="ts-card gc-form" onSubmit={save} aria-label={start.id ? 'Change this item' : 'Add to the calendar'}>
      <h2 className="ts-h">{start.id ? 'Change this item' : 'Add to the calendar'}</h2>
      <div className="field">
        <label htmlFor={`${id}-title`}>What</label>
        <input id={`${id}-title`} ref={firstRef} className="input" maxLength={120} required value={f.title} onChange={set('title')} placeholder="e.g. Campaign launch" />
      </div>
      <label className="gc-check">
        <input type="checkbox" checked={f.all_day} onChange={set('all_day')} /> All day
      </label>
      <div className="gc-row">
        <div className="field">
          <label htmlFor={`${id}-day`}>{f.all_day ? 'First day' : 'Day'}</label>
          <input id={`${id}-day`} className="input" type="date" required value={f.day} onChange={set('day')} />
        </div>
        {f.all_day ? (
          <div className="field">
            <label htmlFor={`${id}-last`}>Last day</label>
            <input id={`${id}-last`} className="input" type="date" value={f.last_day} min={f.day || undefined} onChange={set('last_day')} />
          </div>
        ) : (
          <>
            <div className="field">
              <label htmlFor={`${id}-start`}>Starts</label>
              <input id={`${id}-start`} className="input" type="time" required value={f.start} onChange={set('start')} />
            </div>
            <div className="field">
              <label htmlFor={`${id}-end`}>Ends</label>
              <input id={`${id}-end`} className="input" type="time" value={f.end} onChange={set('end')} aria-describedby={nextDay ? `${id}-next` : undefined} />
            </div>
          </>
        )}
      </div>
      {nextDay && <p id={`${id}-next`} className="cal-help gc-next-day">Ends the next day.</p>}
      {!f.all_day && <p className="cal-help gc-zone">Times are the campaign’s ({tz.replace(/_/g, ' ')}).</p>}
      <div className="field">
        <label htmlFor={`${id}-place`}>Where (optional)</label>
        <input id={`${id}-place`} className="input" maxLength={200} value={f.place} onChange={set('place')} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-details`}>Notes (optional)</label>
        <textarea id={`${id}-details`} className="input" rows={3} maxLength={2000} value={f.details} onChange={set('details')} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-who`}>Who sees it</label>
        <select id={`${id}-who`} className="input" value={f.who} onChange={set('who')}>
          {who.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
        </select>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="ts-row">
        <button type="submit" className="btn btn-primary ts-btn" disabled={busy || !online}>{busy ? 'Saving…' : start.id ? 'Save' : 'Add'}</button>
        <button type="button" className="btn btn-quiet ts-btn" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
      {!online && <NeedsSignalLine>Needs signal</NeedsSignalLine>}
    </form>
  );
}

function Entry({ e, tz, tools, onEdit, onRemoved }) {
  const online = useOnline();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const remove = async () => {
    setBusy(true); setError(null);
    try {
      await action('calendar.item.remove', { id: e.id });
      onRemoved();
    } catch (err) {
      setError(said(err.message));
      setBusy(false);
    }
  };
  const title = e.shift_id ? <Link to={`/shifts/${e.shift_id}`}>{e.title}</Link> : e.title;
  return (
    <li className={`gc-entry gc-entry--${e.kind}`}>
      <div className="gc-when">{whenOf(e, tz)}</div>
      <div className="gc-what">
        <p className="gc-title">{title}</p>
        <p className="gc-meta">
          {KIND[e.kind] && <span className="chip">{KIND[e.kind]}</span>}
          {e.who && <span className="chip">{e.who === 'Everyone' ? 'Everyone' : `For ${e.who}`}</span>}
          {e.where && <span className="gc-where">{e.where}</span>}
        </p>
        {e.details && <p className="gc-details">{e.details}</p>}
        <div className="gc-acts">
          <a className="btn btn-quiet gc-btn" href={e.google} target="_blank" rel="noopener noreferrer">Add to Google Calendar</a>
          {tools && e.kind === 'item' && !asking && (
            <>
              <button type="button" className="btn btn-quiet gc-btn" onClick={() => onEdit(e)}>Edit</button>
              <button type="button" className="btn btn-quiet gc-btn" onClick={() => setAsking(true)}>Remove</button>
            </>
          )}
        </div>
        {asking && (
          <div className="cal-confirm" role="group" aria-label="Remove this item">
            <span>Remove it from everyone’s calendar?</span>
            <button type="button" className="btn ts-danger" disabled={busy || !online} onClick={remove}>{busy ? 'Removing…' : 'Yes'}</button>
            <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => setAsking(false)}>No</button>
          </div>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </li>
  );
}

export default function Calendar() {
  const { me } = useOutletContext();
  const qc = useQueryClient();
  const tz = zoneOf(me);
  const desk = appMode() === 'admin';
  const [params, setParams] = useSearchParams();
  const asked = MONTH.test(params.get('month') || '') ? params.get('month') : '';
  // The switch moves at once; the address follows (a navigation, which React
  // may finish a moment later).
  const [everyOn, setEveryOn] = useState(params.get('every') === '1');
  const every = desk && everyOn;
  const q = useQuery({
    queryKey: ['calendar', asked, every],
    queryFn: () => apiGet(`/calendar?month=${asked}${every ? '&every=1' : ''}`),
    placeholderData: (prev) => prev,
  });
  const [form, setForm] = useState(null); // { id?, values }
  const [note, setNote] = useState('');
  const headRef = useRef(null);
  const data = q.data;
  const month = data?.month || asked;
  const tools = desk && Boolean(data?.canAdd);

  const go = (m) => {
    const next = new URLSearchParams(params);
    next.set('month', m);
    setParams(next);
    setNote('');
  };
  const toggleEvery = (on) => {
    setEveryOn(on);
    const next = new URLSearchParams(params);
    if (on) next.set('every', '1'); else next.delete('every');
    if (!next.get('month') && month) next.set('month', month);
    setParams(next, { replace: true });
  };
  const refresh = (words) => {
    setForm(null);
    setNote(words || '');
    qc.invalidateQueries({ queryKey: ['calendar'] });
    headRef.current?.focus();
  };

  // A day's entries under its heading; an item that began last month is
  // under this month's first day.
  const first = month ? `${month}-01` : '';
  const days = [];
  for (const e of data?.entries || []) {
    const day = e.day < first ? first : e.day;
    const last = days[days.length - 1];
    if (last && last.day === day) last.entries.push(e); else days.push({ day, entries: [e] });
  }

  return (
    <div className="gc-page">
      <div className="gc-head">
        <h1 tabIndex={-1} ref={headRef}>Calendar</h1>
        {tools && !form && (
          <button type="button" className="btn btn-primary gc-add" onClick={() => setForm({ values: { ...blank, day: data?.today || '' } })}>
            Add to the calendar
          </button>
        )}
      </div>
      <p className="muted gc-lede">What’s on for you: your shifts, events, voting days and what the campaign adds.</p>

      {form && <ItemForm key={form.id || 'new'} start={form} who={data?.who || []} tz={data?.tz || tz} onDone={refresh} onCancel={() => setForm(null)} />}

      {month && (
        <nav className="gc-month" aria-label="Month">
          <button type="button" className="btn btn-quiet gc-btn" onClick={() => go(shiftMonth(month, -1))} aria-label={`Previous month, ${monthWords(shiftMonth(month, -1))}`}>‹ Previous</button>
          <h2 className="gc-month__name">{monthWords(month)}</h2>
          <button type="button" className="btn btn-quiet gc-btn" onClick={() => go(shiftMonth(month, 1))} aria-label={`Next month, ${monthWords(shiftMonth(month, 1))}`}>Next ›</button>
        </nav>
      )}
      {desk && data?.canEvery && (
        <label className="gc-check gc-every">
          <input type="checkbox" checked={every} onChange={(ev) => toggleEvery(ev.target.checked)} /> Every shift
        </label>
      )}
      <p className="cal-said" role="status" aria-live="polite">{note}</p>

      {q.isError && !data ? (
        <p className="ts-line">Unavailable — <button type="button" className="btn btn-quiet ts-btn" onClick={() => q.refetch()}>Try again</button></p>
      ) : !data ? (
        <p className="muted">Loading…</p>
      ) : days.length === 0 ? (
        <p className="gc-empty">Nothing on the calendar in {monthWords(month)}.</p>
      ) : (
        days.map((d) => (
          <section key={d.day} className={`gc-day${d.day === data.today ? ' is-today' : ''}${d.day < data.today ? ' is-past' : ''}`} aria-label={dayWords(d.day)}>
            <h3 className="gc-day__h">{d.day === data.today ? `Today · ${dayWords(d.day)}` : dayWords(d.day)}</h3>
            <ul className="gc-list">
              {d.entries.map((e) => (
                <Entry key={e.key} e={e} tz={data.tz || tz} tools={tools}
                  onEdit={(x) => { setForm({ id: x.id, values: fromEntry(x, data.tz || tz), whoLabel: whoLabelOf(x) }); window.scrollTo({ top: 0 }); }}
                  onRemoved={() => refresh('Removed')} />
              ))}
            </ul>
          </section>
        ))
      )}
      {month && data && <p className="gc-next"><button type="button" className="btn btn-quiet gc-btn" onClick={() => go(shiftMonth(month, 1))}>{monthWords(shiftMonth(month, 1))} ›</button></p>}

      <CalendarFeedCard me={me} title="In your own calendar"
        line="Everything here that’s for you appears in Google Calendar (or any calendar app) and stays up to date." />
    </div>
  );
}
