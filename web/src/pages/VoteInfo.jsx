// "Where to vote" (/vote-info; VG decisions 27–31): the published voter
// guide on a canvasser's phone, one tap from Today, a door card or a
// walk-list door. Opened from a door, the door comes in router state
// ({ near, at, lang }), never in the address: a reload opens it without
// the door. It shows the three nearest voting places to that door with
// today's hours and Directions; near an open voting place (150 m) it warns
// and hides "Show the voter" and our names. "Show the voter" draws a QR
// code on the phone (shared/qr.js; works with no signal) for the public
// guide in the voter's language, with ?near= rounded to 2 decimals (about
// 1 km) so it never points at the house. The copy is kept on the phone.
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { nearest, nearVotingPlace, distanceWords, hoursWords, timeWords, dayWords, normWords } from '@base-win/shared/voteguide';
import { qrSvgPath } from '@base-win/shared/qr';
import { directionsUrl } from '@base-win/shared/maps';
import { renderMarkdown } from '@base-win/shared/markdown';
import { langWord } from '@base-win/shared/site/languages';
import { noAnswer } from '../api.js';
import { useOnline } from '../components/NoSignal.jsx';
import { useGuide, useGuideClock } from '../components/guide.js';
import { W } from '../components/guideWords.js';
import './shifts.css';
import './vote-guide.css';

const arr = (v) => (Array.isArray(v) ? v : []);
const LANG_ORDER = ['en', 'pa', 'zh-Hans', 'zh-Hant'];

// The status line (the public page's words).
function statusLine(st) {
  if (st.state === 'before') return W('vg.starts', { day: dayWords(st.next?.day) });
  if (st.state === 'open') return W('vg.openNow', { time: timeWords(st.next?.closes) });
  if (st.state === 'between' && st.next) {
    return st.next.day === st.day ? W('vg.opensToday', { time: timeWords(st.next.opens) })
      : W('vg.next', { day: dayWords(st.next.day), hours: hoursWords(st.next.opens, st.next.closes) });
  }
  return '';
}

// "Open today until 8 p.m." · "Closed today" · "Next: Sat, Oct 12".
function whenWords(p, st, now) {
  const today = st.day ? arr(p.days).find((e) => e.day === st.day) : null;
  if (today && p.closed_on === st.day) return W('vg.closedToday');
  if (today && now < today.opensAt) return `Open today ${hoursWords(today.opens, today.closes)}`;
  if (today && now < today.closesAt) return `Open today until ${timeWords(today.closes)}`;
  const next = arr(p.days).find((e) => e.opensAt > now && e.day !== st.day);
  return next ? `Next: ${dayWords(next.day)}` : '';
}

function Go({ p }) {
  const href = directionsUrl({ lat: p.lat, lng: p.lng, address: p.address, city: p.city });
  if (!href) return null;
  return (
    <a className="btn vi-go" href={href} target="_blank" rel="noopener noreferrer"
      aria-label={W('vg.directionsTo', { name: p.name })}>{W('vg.directions')}</a>
  );
}

function PlaceRow({ p, st, now, distance }) {
  const closed = Boolean(st.day) && p.closed_on === st.day;
  const when = whenWords(p, st, now);
  return (
    <li className="vi-place" data-closed={closed ? '' : undefined}>
      <div className="vi-place__main">
        <span className="vi-place__name">{p.name}</span>
        <span className="vi-place__line">
          {distance != null ? `${distanceWords(distance)} · ` : ''}{when}
        </span>
        {distance == null && p.address && <span className="vi-place__addr">{p.address}</span>}
        {closed && p.closed_note && <span className="vi-place__note">{W('vg.closed', { note: p.closed_note })}</span>}
        {(p.accessible === true || p.curbside === true) && (
          <span className="vi-place__tags">
            {p.accessible === true && <span className="chip vi-tag">{W('vg.accessible')}</span>}
            {p.curbside === true && <span className="chip vi-tag">{W('vg.curbside')}</span>}
          </span>
        )}
        {p.note && <span className="vi-place__line">{p.note}</span>}
        {!closed && p.changed_day && p.changed_day === st.day && <span className="chip chip-warn vi-chip">{W('vg.changed', { time: timeWords(p.changed_hm) })}</span>}
      </div>
      <Go p={p} />
    </li>
  );
}

function Section({ title, children, open = false }) {
  return (
    <details className="vi-sec" open={open || undefined}>
      <summary className="vi-sec__h">{title}</summary>
      <div className="vi-sec__body">{children}</div>
    </details>
  );
}

function Md({ text }) {
  if (!String(text || '').trim()) return null;
  return <div className="vi-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}

// The code for the voter: the guide's address in their language, with the
// area (2 decimals) when the door has a pin. Too long for a code: without
// the area, then no code at all.
function codeFor(link, near) {
  const area = near ? `${link}${link.includes('?') ? '&' : '?'}near=${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : null;
  for (const text of [area, link].filter(Boolean)) {
    try { return { text, qr: qrSvgPath(text) }; } catch { /* too long for a code */ }
  }
  return { text: area || link, qr: null };
}

function ShowTheVoter({ links, near, lang, onClose }) {
  // The whole screen: above the tab bar, and the app behind it out of
  // reach (no tap, no Tab) while the voter holds the phone.
  useEffect(() => {
    const root = document.getElementById('root');
    root?.setAttribute('inert', '');
    return () => root?.removeAttribute('inert');
  }, []);
  const langs = LANG_ORDER.filter((c) => links[c]);
  const [pick, setPick] = useState(langs.includes(lang) ? lang : 'en');
  const [said, setSaid] = useState('');
  const { text, qr } = useMemo(() => codeFor(links[pick] || links.en, near), [links, pick, near]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setSaid('Link copied'); } catch { setSaid('Couldn’t copy — press and hold the link'); }
  };
  return createPortal(
    <div className="vi-sheet" role="dialog" aria-modal="true" aria-labelledby="vi-sheet-h"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <h2 id="vi-sheet-h" className="vi-sheet__h">Scan for where and when to vote</h2>
      {qr ? (
        <svg className="vi-qr" viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label="QR code for the voter guide" shapeRendering="crispEdges">
          <rect width={qr.size} height={qr.size} fill="#fff" />
          <path d={qr.d} fill="#000" />
        </svg>
      ) : <p className="vi-sheet__long">This link is too long for a code</p>}
      {langs.length > 1 && (
        <div className="vi-langs" role="radiogroup" aria-label="Language">
          {langs.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={pick === c} lang={c} className={`chip vi-lang${pick === c ? ' is-on' : ''}`} onClick={() => setPick(c)}>{langWord(c)}</button>
          ))}
        </div>
      )}
      <p className="vi-sheet__link mono">{text}</p>
      <div className="vi-sheet__acts">
        <button type="button" className="btn" onClick={copy}>Copy link</button>
        <button type="button" className="btn" onClick={onClose} autoFocus>Done</button>
      </div>
      <p className="vi-sr" aria-live="polite">{said}</p>
    </div>,
    document.body,
  );
}

export default function VoteInfo() {
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const draft = params.get('draft') === '1';
  // The door comes once, in router state, and is taken out of the history
  // entry at once: a reload (the browser keeps history state) opens the
  // screen without it.
  const [door] = useState(() => (location.state && typeof location.state === 'object' ? location.state : {}));
  // Land at the top (the walk list's scroll would hide the warning).
  useLayoutEffect(() => { window.scrollTo(0, 0); }, []);
  useEffect(() => {
    if (location.state) navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [location.state, location.pathname, location.search, navigate]);
  const near = door.near && Number.isFinite(door.near.lat) && Number.isFinite(door.near.lng) ? door.near : null;
  const q = useGuide({ poll: true, draft });
  const online = useOnline();
  const g = q.data;
  const { now, st } = useGuideClock(g);
  const [showing, setShowing] = useState(false);
  const [search, setSearch] = useState('');

  const back = door.at
    ? <button type="button" className="ops-back btn-link vi-back" onClick={() => navigate(-1)}>← Back to the door</button>
    : <Link to="/" className="ops-back">← Today</Link>;
  const head = <>{back}<h1>Where to vote</h1></>;
  if (!g) {
    let body = <p className="muted" role="status">Loading…</p>;
    if ((q.isPending && !online) || (q.isError && noAnswer(q.error))) body = <p className="vi-quiet">No signal — open this once with signal to keep it on your phone.</p>;
    else if (q.isError) body = <p className="vi-quiet" role="alert">Unavailable — <button type="button" className="btn-link" onClick={() => q.refetch()}>Try again</button></p>;
    return <div className="vi-page">{head}{body}</div>;
  }
  if (g.status === 'not_out' || st.state === 'not_out') return <div className="vi-page">{head}<p className="vi-quiet">{W('vg.notOut')}</p></div>;
  if (st.state === 'over') return <div className="vi-page">{head}<p className="vi-quiet">Voting is over.</p></div>;

  const places = arr(g.places);
  const warn = near && st.state === 'open' ? nearVotingPlace(places, near, now, 150) : null;
  const closest = near ? nearest(places, near, 3, g.times, now) : [];
  const links = g.links || {};
  const words = normWords(search);
  const show = !warn && links.en
    ? <button type="button" className="btn btn-primary vi-show" onClick={() => setShowing(true)}>Show the voter</button>
    : null;
  const listed = words && !near ? places.filter((p) => normWords(`${p.name} ${p.address}`).includes(words)) : places;
  const rules = g.rules || {};
  const bring = [rules.bring_listed, rules.bring_unlisted].some((t) => String(t || '').trim());
  const mail = String(rules.mail || '').trim() || g.mail?.request_by || g.mail?.url;
  const ballot = arr(g.contests);
  const checked = g.checkedOn ? dayWords(g.checkedOn) : '';

  return (
    <div className="vi-page">
      {head}
      {/* Only when the server served the draft (not a live guide, not a volunteer's ?draft=1). */}
      {draft && g.draft === true && <p className="chip chip-warn">Draft — only the desk sees this</p>}
      <p className="vi-status" aria-live="polite">{statusLine(st)}</p>

      {warn && (
        <div className="vi-warn" role="alert">
          <p className="vi-warn__h">{W('vg.nearPlace')}</p>
          <p className="vi-warn__name">{warn.name}</p>
        </div>
      )}

      {/* Without a door the one action comes first; the places fold below. */}
      {!near && show}

      {near ? (
        <section aria-labelledby="vi-near-h">
          <h2 id="vi-near-h" className="vi-h">{door.at ? `Nearest to ${door.at}` : 'Nearest voting places'}</h2>
          {closest.length ? (
            <ul className="vi-places">
              {closest.map((p) => <PlaceRow key={p.id} p={p} st={st} now={now} distance={p.distance} />)}
            </ul>
          ) : <p className="vi-quiet">No voting place is on the map yet.</p>}
        </section>
      ) : null}

      {near && show}

      <div className="vi-secs">
        <Section title="Days and hours">
          <ul className="vi-days">
            {arr(g.days).map((d) => (
              <li key={d.day} data-today={d.day === st.day ? '' : undefined}>
                <strong>{dayWords(d.day)}</strong> · {W(d.kind === 'general' ? 'vg.general' : 'vg.advance')} · {hoursWords(d.opens, d.closes)}
                {d.day === st.day && <span className="chip vi-chip">{W('vg.today')}</span>}
              </li>
            ))}
          </ul>
          {g.vote_anywhere === true && <p>{W('vg.anywhere')}</p>}
        </Section>
        {bring && (
          <Section title={W('vg.bring')}>
            {String(rules.bring_listed || '').trim() && <><h3 className="vi-sub">{W('vg.bringListed')}</h3><Md text={rules.bring_listed} /></>}
            {String(rules.bring_unlisted || '').trim() && <><h3 className="vi-sub">{W('vg.bringUnlisted')}</h3><Md text={rules.bring_unlisted} /></>}
          </Section>
        )}
        {String(rules.who || '').trim() && <Section title={W('vg.who')}><Md text={rules.who} /></Section>}
        <Section title={`All voting places (${places.length.toLocaleString('en-CA')})`} open={!near}>
          {!near && (
            <>
              <label className="vi-sr" htmlFor="vi-search">{W('vg.search')}</label>
              <input id="vi-search" className="input vi-search" type="search" placeholder={W('vg.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
            </>
          )}
          {listed.length ? (
            <ul className="vi-places">{listed.map((p) => <PlaceRow key={p.id} p={p} st={st} now={now} />)}</ul>
          ) : (
            <p className="vi-quiet">{W('vg.noMatch')} <button type="button" className="btn-link vi-tap" onClick={() => setSearch('')}>{W('vg.clear')}</button></p>
          )}
        </Section>
        {!warn && ballot.length > 0 && ballot.some((c) => arr(c.names).some((n) => n.ours)) && (
          <Section title="Our names on the ballot">
            {ballot.filter((c) => arr(c.names).some((n) => n.ours)).map((c, i) => (
              <div key={`${c.office}-${i}`} className="vi-contest">
                <h3 className="vi-sub">{W(Number(c.vote_for) === 1 ? 'vg.voteForOne' : 'vg.voteFor', { office: c.office, n: c.vote_for })}</h3>
                {/* Only ours: a name read out at a door is never an opponent's. */}
                <ul className="vi-names">
                  {arr(c.names).filter((n) => n.ours).map((n, j) => <li key={`${n.name}-${j}`} data-ours="">{n.name}</li>)}
                </ul>
              </div>
            ))}
            {String(g.ballot_note || '').trim() && <p className="vi-note">{g.ballot_note}</p>}
          </Section>
        )}
        {mail && (
          <Section title={W('vg.mail')}>
            <Md text={rules.mail} />
            {g.mail?.request_by && <p>{W('vg.mailBy', { day: dayWords(g.mail.request_by) })}</p>}
            {g.mail?.url && <p><a className="btn vi-go" href={g.mail.url} target="_blank" rel="noopener noreferrer">{W('vg.mailAsk')} ↗</a></p>}
          </Section>
        )}
        {g.ride_phone && (
          <Section title="Need a ride">
            <p><a className="btn vi-go" href={`tel:${g.ride_phone.replace(/[^\d+]/g, '')}`}>Call or text <span className="vi-keep">{g.ride_phone}</span></a></p>
          </Section>
        )}
      </div>

      {g.official_label && <p className="vi-foot">From {g.official_label}{checked ? ` · checked ${checked}` : ''}</p>}

      {showing && <ShowTheVoter links={links} near={near} lang={door.lang || 'en'} onClose={() => setShowing(false)} />}
    </div>
  );
}
