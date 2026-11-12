// A profile's History (pages/Person.jsx): everything the campaign and this
// person did with each other on one list, newest first — knocks and calls,
// texts, emails with their opens and clicks, website forms, gifts,
// memberships, shifts, survey answers, signs, voted marks — as
// GET /api/persons/:id/timeline gives it (server/ext/timeline), which
// already leaves out what this sign-in may not see.
//
//   usePersonTimeline(id, on)   the whole list's first page (and the next,
//                               on "Load more"); Person.jsx reads it for
//                               the section's count
//   timelineCount(q, waiting)   that count: "38", "50+", or nothing while
//                               it loads or can't
//   <PersonTimeline>            chips to narrow it (the server filters, so a
//                               chip is never short by what a later page
//                               holds), the rows, and each state said
//                               plainly: Loading…, No signal, Unavailable
//
// A knock still on this device (the outbox) shows first, "Not sent yet",
// whatever the server has answered. With no signal a list this sign-in
// loaded before is shown from its kept copy (KeptCopies.js).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { apiGet } from '../api.js';
import { NoSignal, noSignal, useOnline } from './NoSignal.jsx';
import { RatingTag, fmtShort, fmtWhen } from '../pages/People.jsx';
import './person-timeline.css';

const GROUP_LABEL = { all: 'All', field: 'Doors & calls', messages: 'Messages', website: 'Website', money: 'Money', shifts: 'Shifts' };

const pageOf = (id, group) => ({ pageParam }) => {
  const p = new URLSearchParams();
  if (group !== 'all') p.set('group', group);
  if (pageParam) p.set('before', pageParam);
  const qs = p.toString();
  return apiGet(`/persons/${id}/timeline${qs ? `?${qs}` : ''}`);
};
export const usePersonTimeline = (id, on, group = 'all') => useInfiniteQuery({
  queryKey: ['person', id, 'timeline', group],
  queryFn: pageOf(id, group),
  initialPageParam: null,
  getNextPageParam: (last) => last?.next ?? undefined,
  enabled: Boolean(on && id),
});

const entriesOf = (q) => (q.data?.pages ?? []).flatMap((p) => p?.entries ?? []);

// "38" once it's known; "50+" while there is more to load. Nothing while it
// loads or when it couldn't be read again (the section says which).
export const timelineCount = (q, waiting = 0) => {
  if (!q.data || q.isRefetchError) return '';
  const n = entriesOf(q).length + waiting;
  return n ? `${n.toLocaleString('en-CA')}${q.hasNextPage ? '+' : ''}` : '';
};

// "Oct 4, 2:14 p.m." this year, the year too before that; the day alone
// when that is all anyone knows (a gift keyed in later).
const whenWords = (e) => {
  if (e.day) return fmtShort(e.at);
  const d = new Date(e.at);
  if (Number.isNaN(d.getTime()) || d.getFullYear() === new Date().getFullYear()) return fmtWhen(e.at);
  return d.toLocaleString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

// What happened, as a link when it leads somewhere: another screen, or one
// of this profile's own sections ("#gifts") while that section is on the
// page — words otherwise, never a link that goes nowhere.
function Words({ e, from, sections, onSection }) {
  const section = e.link?.startsWith('#') ? e.link.slice(1) : null;
  if (!e.link || (section && !sections.includes(section))) return <span>{e.title}</span>;
  if (section) {
    return <button type="button" className="ptl-link" onClick={() => onSection?.(section)}>{e.title}</button>;
  }
  return <Link className="ptl-link" to={e.link} state={{ from }}>{e.title}</Link>;
}

function Row({ e, from, sections = [], onSection }) {
  return (
    <li>
      <span className="when">{whenWords(e)}</span>
      <span className="what">
        <span className="chip">{e.label}</span>
        {e.pending && <span className="chip obx-copy ds-pending">Not sent yet</span>}
        {e.rating ? <RatingTag code={e.rating} /> : <Words e={e} from={from} sections={sections} onSection={onSection} />}
        {e.by && <span className="by">{e.by}</span>}
        {e.detail && <span className="note">{e.detail}</span>}
      </span>
    </li>
  );
}

// all: usePersonTimeline's query for the whole list (Person.jsx holds it).
// pending: contacts waiting on this device, already in a row's words.
// sections: the profile's sections on the page now (Answers and Ladders
// wait on reads of their own, and no signal keeps neither).
// onSection(key): open that section of the profile and go to it.
export function PersonTimeline({ personId, name, all, pending = [], sections = [], onSection }) {
  const [group, setGroup] = useState('all');
  const [said, setSaid] = useState('');
  const narrowed = usePersonTimeline(personId, group !== 'all', group);
  const q = group === 'all' ? all : narrowed;
  const online = useOnline();
  const groups = all.data?.pages?.[0]?.groups ?? narrowed.data?.pages?.[0]?.groups ?? [];
  const entries = entriesOf(q);
  // What's waiting on this device is a knock or a call: under All and Doors & calls.
  const waiting = group === 'all' || group === 'field' ? pending : [];
  const from = { to: `/people/${personId}`, label: String(name || '').trim().split(/\s+/)[0] || 'Back' };

  // The chip whose next page got no answer (the server restarting: what's
  // loaded stays, KeptCopies.js), so its button says so.
  const [missed, setMissed] = useState(null);

  const pick = (g) => {
    setGroup(g);
    setSaid(`Showing ${GROUP_LABEL[g].toLowerCase()}`);
  };
  const more = async () => {
    setMissed(null);
    const before = entries.length;
    const r = await q.fetchNextPage();
    const now = entriesOf(r).length;
    if (now > before) setSaid(`${(now - before).toLocaleString('en-CA')} more loaded`);
    else if (r.hasNextPage && !r.isError) setMissed(group);
  };

  // The list couldn't be read (or read again: refused now, or the server
  // failed): it isn't shown — Loading… again while Try again asks. A next
  // page that didn't come leaves what's loaded where it is, and its button
  // says so.
  const failed = q.isError && !q.isFetching && !q.isFetchNextPageError && !noSignal(q);
  const moreFailed = q.isFetchNextPageError || missed === group;
  const empty = Boolean(q.data) && !failed && entries.length === 0 && waiting.length === 0;
  return (
    <>
      {(groups.length > 0 && (group !== 'all' || entries.length > 0)) && (
        <div className="ptl-chips" role="group" aria-label="Show">
          {['all', ...groups].map((g) => (
            <button key={g} type="button" className="chip ptl-chip" aria-pressed={group === g} onClick={() => pick(g)}>{GROUP_LABEL[g] || g}</button>
          ))}
        </div>
      )}
      <p className="ptl-sr" role="status">{said}</p>
      {(waiting.length > 0 || (!failed && entries.length > 0)) && (
        <ul className="timeline ptl">
          {waiting.map((e) => <Row key={e.id} e={e} />)}
          {!failed && entries.map((e) => <Row key={e.id} e={e} from={from} sections={sections} onSection={onSection} />)}
        </ul>
      )}
      {failed ? (
        <p className="ptl-state" role="alert">
          Unavailable — <button type="button" className="btn pp-btn" onClick={() => q.refetch()}>Try again</button>
        </p>
      ) : noSignal(q) ? <NoSignal />
        : !q.data ? <p className="ptl-state muted" role="status">Loading…</p>
          : empty ? <p className="pf-empty">{group === 'all' ? 'No history yet.' : `Nothing under ${GROUP_LABEL[group]} yet.`}</p>
            : null}
      {!failed && q.hasNextPage && (moreFailed && !q.isFetchingNextPage ? (
        <p className="ptl-state" role="alert">
          Unavailable — <button type="button" className="btn pp-btn" onClick={more}>Try again</button>
        </p>
      ) : online ? (
        <div className="pf-row-acts">
          <button type="button" className="btn pp-btn" disabled={q.isFetchingNextPage} onClick={more}>
            {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      ) : <NoSignal>No signal — the rest loads when you’re back online.</NoSignal>)}
    </>
  );
}
