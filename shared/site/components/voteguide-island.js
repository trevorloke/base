// The voter guide's island (VG decision 14): where and when to vote, drawn
// on the server for the state at drawing time and hydrated with the same
// props. It reads the browser only in effects: the server's clock (once on
// load and every 10 minutes, so a phone whose clock or time-zone rules are
// wrong still flips at the right moment), the visitor's location (it
// never leaves the browser), a typed address (looked up by the server and
// forgotten), ?near= from a canvasser's code. Without JavaScript the HTML
// is complete: the filters are links, the search a GET form, Directions
// plain links.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { html, cx } from './h.js';
import { wordsIn } from '../ui-words.js';
import { directionsUrl } from '../../maps.js';
import {
  guideState, openNow, metresBetween, distanceWords, hoursWords, timeWords, dayWords, dayParts, normWords, seedDateWords,
} from '../../voteguide.js';

const arr = (v) => (Array.isArray(v) ? v : []);
const CLOCK_EVERY = 10 * 60 * 1000;

// ?near=49.19,-122.85 (2 decimals at most): the island sorts by it.
export const nearOf = (search) => {
  const m = /[?&]near=(-?\d{1,2}(?:\.\d{1,2})?),(-?\d{1,3}(?:\.\d{1,2})?)(?:&|$)/.exec(String(search || ''));
  if (!m) return null;
  const lat = Number(m[1]); const lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
};

// The places a filter keeps: day ('today', a date, 'advance', 'general',
// 'all'), area, and words in the name or the street.
export const filterPlaces = (places, { day, area, q }, guideDays, today) => {
  const kinds = Object.fromEntries(arr(guideDays).map((d) => [d.day, d.kind]));
  const words = normWords(q);
  return arr(places).filter((p) => {
    const ds = arr(p.days).map((e) => e.day);
    if (day === 'today' && !(today && ds.includes(today))) return false;
    if (day === 'advance' && !ds.some((d) => kinds[d] === 'advance')) return false;
    if (day === 'general' && !ds.some((d) => kinds[d] === 'general')) return false;
    if (/^\d{4}-\d{2}-\d{2}$/.test(day || '') && !ds.includes(day)) return false;
    if (area && p.area !== area) return false;
    if (words && !normWords(`${p.name} ${p.address}`).includes(words)) return false;
    return true;
  });
};

// The words of a status line (also the banner's, voteguide.js).
export function statusWords(st, W, lang) {
  if (st.state === 'before') return W('vg.starts', { day: dayWords(st.next?.day, lang) });
  if (st.state === 'open') return W('vg.openNow', { time: timeWords(st.next?.closes, lang) });
  if (st.state === 'between' && st.next) {
    return st.next.day === st.day
      ? W('vg.opensToday', { time: timeWords(st.next.opens, lang) })
      : W('vg.next', { day: dayWords(st.next.day, lang), hours: hoursWords(st.next.opens, st.next.closes, lang) });
  }
  return '';
}

// A sentence with its slots drawn as given nodes ({time} → <span>…</span>).
const fillIn = (W, key, vars) => {
  const names = Object.keys(vars);
  const parts = W(key, Object.fromEntries(names.map((n, i) => [n, `\u0000${i}\u0000`]))).split('\u0000');
  return html`<${Fragment}>${parts.map((t, i) => (i % 2 ? html`<${Fragment} key=${i}>${vars[names[Number(t)]]}<//>` : t))}<//>`;
};
// A phone number, an hour or a day never splits across two lines.
const keep = (s) => html`<span className="vg-keep">${s}</span>`;

// The status line as drawn: statusWords, with its day and hours kept whole.
function statusLine(st, W, lang) {
  if (st.state === 'before') return fillIn(W, 'vg.starts', { day: keep(dayWords(st.next?.day, lang)) });
  if (st.state === 'open') return fillIn(W, 'vg.openNow', { time: keep(timeWords(st.next?.closes, lang)) });
  if (st.state === 'between' && st.next) {
    return st.next.day === st.day
      ? fillIn(W, 'vg.opensToday', { time: keep(timeWords(st.next.opens, lang)) })
      : fillIn(W, 'vg.next', { day: keep(dayWords(st.next.day, lang)), hours: keep(hoursWords(st.next.opens, st.next.closes, lang)) });
  }
  return '';
}

function Away({ href, children, className, top }) {
  if (!href) return null;
  return html`<a className=${className} href=${href} target=${top ? '_top' : '_blank'} rel="noopener noreferrer">${children}<span aria-hidden="true"> ↗</span></a>`;
}

function Md({ html: h, className }) {
  if (!h) return null;
  return html`<div className=${cx('md', className)} dangerouslySetInnerHTML=${{ __html: h }} />`;
}

// Which days a place is open, in words: "Advance · Election day" when it is
// open on every day of those kinds, else its dates.
const placeDays = (p, days, W, lang) => {
  const mine = new Set(arr(p.days).map((e) => e.day));
  const kinds = ['advance', 'general'].filter((k) => days.some((d) => d.kind === k));
  const whole = kinds.filter((k) => days.filter((d) => d.kind === k).every((d) => mine.has(d.day)));
  const covered = days.every((d) => mine.has(d.day) === whole.includes(d.kind));
  if (covered && whole.length) return whole.map((k) => W(k === 'advance' ? 'vg.advance' : 'vg.general')).join(' · ');
  return days.filter((d) => mine.has(d.day)).map((d) => dayParts(d.day, lang).date).join(', ');
};

function Place({ p, st, days, W, lang, where, embed }) {
  const closed = Boolean(st.day) && p.closed_on === st.day;
  const own = arr(p.days).filter((e) => e.own);
  const dir = directionsUrl({ lat: p.lat, lng: p.lng, address: p.address, city: p.city || where.city, province: where.province });
  return html`<li className=${cx('vg-place', closed && 'vg-place--closed')}>
    <div className="vg-place-main">
      <p className="vg-place-name">${closed ? html`<s>${p.name}</s>` : p.name}</p>
      <p className="vg-place-address">${p.address}</p>
      <p className="vg-place-tags">
        <span className="vg-tag">${placeDays(p, days, W, lang)}</span>
        ${p.accessible === true ? html`<span className="vg-tag">${W('vg.accessible')}</span>` : null}
        ${p.curbside === true ? html`<span className="vg-tag">${W('vg.curbside')}</span>` : null}
        ${p.changed_day && p.changed_day === st.day ? html`<span className="vg-tag vg-tag--changed">${W('vg.changed', { time: timeWords(p.changed_hm, lang) })}</span>` : null}
        ${Number.isFinite(p.distance) ? html`<span className="vg-tag vg-tag--far">${distanceWords(p.distance)}</span>` : null}
      </p>
      ${own.map((e) => html`<p key=${e.day} className="vg-place-hours">${`${dayParts(e.day, lang).date}: ${hoursWords(e.opens, e.closes, lang)}`}</p>`)}
      ${closed ? html`<p className="vg-place-closed" role="note">${p.closed_note ? W('vg.closed', { note: p.closed_note }) : W('vg.closedToday')}</p>` : null}
      ${p.note ? html`<p className="vg-place-note">${p.note}</p>` : null}
    </div>
    ${dir && !closed ? html`<a className="vg-directions" href=${dir} target="_blank" rel="noopener noreferrer" aria-label=${W('vg.directionsTo', { name: p.name })} data-embed=${embed ? '1' : undefined}>${W('vg.directions')}</a>` : null}
  </li>`;
}

export function VoteGuide(props) {
  const {
    uid, headingId, title, intro, level = 2, lang = 'en', guide = {}, filter = {}, showBallot = true, cta = null, embed = false,
    clockUrl, findUrl, where = {}, rules = {}, ballotNote = '', w,
  } = props;
  const W = wordsIn(w);
  seedDateWords(lang, props.dateWords);
  const H = `h${Math.min(6, Math.max(1, level))}`;
  const H3 = `h${Math.min(6, Math.max(1, level + 1))}`;
  const times = guide.times || {};
  const days = arr(times.days);
  const places = arr(guide.places);

  // The server's clock: its now at drawing, then corrected on load.
  const [offset, setOffset] = useState(null);
  const [tick, setTick] = useState(0);
  const nowMs = offset === null ? props.now : Date.now() + offset;
  const st = guideState(times, nowMs, places);

  useEffect(() => {
    let stop = false;
    const ask = async () => {
      const sent = Date.now();
      try {
        const r = await fetch(clockUrl, { headers: { accept: 'application/json' }, cache: 'no-store' });
        const j = await r.json();
        const back = Date.now();
        if (!stop && Number.isFinite(j?.now)) setOffset(j.now - (sent + back) / 2);
      } catch {
        // No answer: the device's clock, moved by the page's own age guess.
        if (!stop) setOffset((o) => (o === null ? props.now - Date.now() : o));
      }
    };
    ask();
    const every = setInterval(() => { if (document.visibilityState === 'visible') ask(); }, CLOCK_EVERY);
    return () => { stop = true; clearInterval(every); };
  }, [clockUrl]);

  // Draw again at the next boundary (a poll opening or closing, midnight).
  useEffect(() => {
    if (offset === null || !st.boundary) return undefined;
    const wait = Math.max(1000, Math.min(st.boundary - nowMs + 500, 2 ** 31 - 1));
    const t = setTimeout(() => setTick((n) => n + 1), wait);
    return () => clearTimeout(t);
  }, [offset, st.boundary, tick]);

  // Filters and where the visitor is.
  const votingToday = Boolean(st.day) && days.some((d) => d.day === st.day) && st.state !== 'over';
  const [day, setDay] = useState(filter.day || (votingToday ? 'today' : 'all'));
  const [area, setArea] = useState(filter.area || '');
  const [q, setQ] = useState(filter.q || '');
  const [at, setAt] = useState(null); // { lat, lng, how: 'you' | 'area' }
  const [say, setSay] = useState('');
  const [busy, setBusy] = useState(false);
  const [address, setAddress] = useState('');
  const sayRef = useRef(null);

  useEffect(() => {
    const near = nearOf(window.location.search);
    if (near) setAt({ ...near, how: 'area' });
  }, []);

  // In another website's frame: tell the frame how tall the guide is.
  useEffect(() => {
    if (!embed || window.parent === window) return undefined;
    const post = () => window.parent.postMessage({ type: 'basewin:height', h: document.documentElement.scrollHeight }, '*');
    post();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(post) : null;
    ro?.observe(document.body);
    window.addEventListener('resize', post);
    return () => { ro?.disconnect(); window.removeEventListener('resize', post); };
  }, [embed]);

  const useLocation = () => {
    setSay('');
    if (!navigator.geolocation) { setSay(W('vg.noLocation')); return; }
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => { setBusy(false); setAt({ lat: pos.coords.latitude, lng: pos.coords.longitude, how: 'you' }); },
      () => { setBusy(false); setSay(W('vg.noLocation')); },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
    );
  };
  const find = async (e) => {
    e.preventDefault();
    const a = address.trim();
    if (!a) return;
    setSay(''); setBusy(true);
    try {
      const r = await fetch(findUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ address: a }), credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (r.ok && Number.isFinite(j.lat)) setAt({ lat: j.lat, lng: j.lng, how: 'you' });
      else setSay(j.error || W('vg.notFound'));
    } catch { setSay(W('vg.notFound')); }
    setBusy(false);
  };

  const shown = useMemo(() => {
    const list = filterPlaces(places, { day, area, q }, days, st.day);
    // A place closed on the day drawn goes last, so the first row (and its
    // Directions) is never a closed door; its row stays, with the note.
    const shut = (p) => (st.day && p.closed_on === st.day ? 1 : 0);
    if (!at) return [...list].sort((a, b) => shut(a) - shut(b));
    const withD = list.map((p) => (p.lat != null && p.lng != null ? { ...p, distance: metresBetween(at, { lat: p.lat, lng: p.lng }) } : p));
    return withD.sort((a, b) => shut(a) - shut(b) || (a.distance ?? Infinity) - (b.distance ?? Infinity) || a.position - b.position);
  }, [places, day, area, q, at, st.day]);

  // Each filter is a link too (?day=, ?area=), for a page without JavaScript.
  const plainDay = votingToday ? 'today' : 'all';
  const hrefFor = (d, a) => {
    const sp = new URLSearchParams();
    if (d && d !== plainDay) sp.set('day', d);
    if (a) sp.set('area', a);
    const s2 = sp.toString();
    return s2 ? `?${s2}` : '?';
  };
  const chip = (key, value, label, cur, set) => {
    const on = cur === value;
    const next = on ? (key === 'day' ? 'all' : '') : value;
    const href = key === 'day' ? hrefFor(next, area) : hrefFor(day, next);
    return html`<a key=${`${key}-${value}`} className=${cx('vg-chip', on && 'vg-chip--on')} href=${href} target="_self" aria-pressed=${on ? 'true' : 'false'} role="button"
      onClick=${(e) => { e.preventDefault(); set(next); }}>${label}</a>`;
  };

  if (st.state === 'over') {
    return html`<div className="vg vg--over">
      <${H} id=${headingId} className="display">${title}<//>
      <p className="vg-status" aria-live="polite">${W('vg.over')}</p>
      ${guide.official_url ? html`<p><${Away} href=${guide.official_url} top=${embed}>${W('vg.results', { label: guide.official_label || guide.official_url })}<//></p>` : null}
      ${cta ? html`<p><a className="btn btn--action" href=${cta.href} target=${embed ? '_top' : undefined}>${cta.label}</a></p>` : null}
    </div>`;
  }

  const hasAdvance = days.some((d) => d.kind === 'advance');
  const hasGeneral = days.some((d) => d.kind === 'general');
  const contests = showBallot ? arr(guide.contests) : [];
  const mail = guide.mail || {};
  const hasMail = Boolean(rules.mail || mail.request_by || mail.url);
  const bring = rules.bring_listed || rules.bring_unlisted;
  return html`<div className="vg">
    <div className="vg-head">
      <${H} id=${headingId} className="display">${title}<//>
      ${intro ? html`<p className="lede">${intro}</p>` : null}
      <p className="vg-status" aria-live="polite">${statusLine(st, W, lang)}</p>
    </div>

    <section className="vg-block" aria-labelledby=${`${uid}-days`}>
      <${H3} id=${`${uid}-days`} className="vg-title">${W('vg.days')}<//>
      <ul className="vg-days">
        ${days.map((d) => {
          const done = nowMs >= d.closesAt;
          const isToday = d.day === st.day;
          const parts = dayParts(d.day, lang);
          return html`<li key=${d.day} className=${cx('vg-day', d.kind === 'general' && 'vg-day--general', isToday && 'vg-day--today', done && 'vg-day--done')}>
            <span className="vg-day-week">${parts.weekday}</span>
            <span className="vg-day-date">${parts.date}</span>
            <span className="vg-day-kind">${W(d.kind === 'general' ? 'vg.general' : 'vg.advance')}</span>
            <span className="vg-day-hours">${hoursWords(d.opens, d.closes, lang)}</span>
            ${isToday && !done ? html`<span className="vg-day-flag">${W('vg.today')}</span>` : done ? html`<span className="vg-day-flag">${W('vg.done')}</span>` : null}
          </li>`;
        })}
      </ul>
    </section>

    <section className="vg-block" aria-labelledby=${`${uid}-where`}>
      <${H3} id=${`${uid}-where`} className="vg-title">${at ? W(at.how === 'area' ? 'vg.nearArea' : 'vg.nearest') : W('vg.where')}<//>
      ${guide.vote_anywhere === true ? html`<p>${W('vg.anywhere')}</p>`
        : guide.vote_anywhere === false && guide.official_url ? html`<p><${Away} href=${guide.official_url} top=${embed}>${W('vg.checkWhere', { label: guide.official_label || guide.official_url })}<//></p>` : null}
      ${offset !== null || tick ? html`<div className="vg-find">
        <button type="button" className="btn btn--action vg-locate" onClick=${useLocation} disabled=${busy}>${W('vg.useLocation')}</button>
        <form className="vg-address" onSubmit=${find}>
          <label className="vg-label" htmlFor=${`${uid}-addr`}>${W('vg.typeAddress')}</label>
          <div className="vg-row">
            <input id=${`${uid}-addr`} className="vg-input" type="text" autoComplete="street-address" maxLength="200" value=${address} onInput=${(e) => setAddress(e.target.value)} onChange=${(e) => setAddress(e.target.value)} />
            <button type="submit" className="btn vg-find-btn" disabled=${busy}>${W('vg.find')}</button>
          </div>
        </form>
      </div>` : null}
      <p className="vg-say" aria-live="polite" ref=${sayRef}>${say}</p>
      <div className="vg-chips" role="group" aria-label=${W('vg.filters')}>
        ${votingToday ? chip('day', 'today', W('vg.openToday'), day, setDay) : null}
        ${hasAdvance ? chip('day', 'advance', W('vg.advance'), day, setDay) : null}
        ${hasGeneral ? chip('day', 'general', W('vg.general'), day, setDay) : null}
        ${arr(guide.areas).map((a) => chip('area', a, a, area, setArea))}
      </div>
      <form className="vg-search" method="get" target="_self" onSubmit=${(e) => e.preventDefault()}>
        <label className="vg-label" htmlFor=${`${uid}-q`}>${W('vg.search')}</label>
        <div className="vg-row">
          <input id=${`${uid}-q`} name="q" className="vg-input" type="search" maxLength="80" value=${q} onInput=${(e) => setQ(e.target.value)} onChange=${(e) => setQ(e.target.value)} />
          ${offset === null && !tick ? html`<button type="submit" className="btn">${W('vg.searchButton')}</button>` : null}
        </div>
      </form>
      ${shown.length
        ? html`<ul className="vg-places">${shown.map((p) => html`<${Place} key=${p.id} p=${p} st=${st} days=${days} W=${W} lang=${lang} where=${where} embed=${embed} />`)}</ul>`
        : html`<p className="vg-none">${W('vg.noMatch')} <a href="?" target="_self" onClick=${(e) => { e.preventDefault(); setQ(''); setArea(''); setDay('all'); }}>${W('vg.clear')}</a></p>`}
      ${guide.wait_url && st.state === 'open' ? html`<p><${Away} href=${guide.wait_url}>${W('vg.wait')}<//></p>` : null}
    </section>

    ${hasMail ? html`<section className="vg-block">
      <${H3} className="vg-title">${W('vg.mail')}<//>
      <${Md} html=${rules.mail} />
      ${mail.request_by ? html`<p>${W('vg.mailBy', { day: dayWords(mail.request_by, lang) })}</p>` : null}
      ${mail.url ? html`<p><${Away} href=${mail.url}>${W('vg.mailAsk')}<//></p>` : null}
    </section>` : null}

    ${bring ? html`<section className="vg-block">
      <${H3} className="vg-title">${W('vg.bring')}<//>
      ${rules.bring_listed ? html`<${Fragment}><p className="vg-sub">${W('vg.bringListed')}</p><${Md} html=${rules.bring_listed} /><//>` : null}
      ${rules.bring_unlisted ? html`<${Fragment}><p className="vg-sub">${W('vg.bringUnlisted')}</p><${Md} html=${rules.bring_unlisted} /><//>` : null}
    </section>` : null}
    ${rules.who ? html`<section className="vg-block"><${H3} className="vg-title">${W('vg.who')}<//><${Md} html=${rules.who} /></section>` : null}
    ${rules.access || guide.ride_phone ? html`<section className="vg-block">
      ${rules.access ? html`<${Fragment}><${H3} className="vg-title">${W('vg.access')}<//><${Md} html=${rules.access} /><//>` : null}
      ${guide.ride_phone ? html`<p className="vg-ride">${(() => {
        const [before, after] = W('vg.ride', { phone: '\u0000' }).split('\u0000');
        return html`<${Fragment}>${before}<a className="vg-keep" href=${`tel:${guide.ride_phone.replace(/[^\d+]/g, '')}`}>${guide.ride_phone}</a>${after || ''}<//>`;
      })()}</p>` : null}
    </section>` : null}

    ${contests.length ? html`<section className="vg-block vg-ballot">
      <${H3} className="vg-title">${W('vg.ballot')}<//>
      ${contests.map((c, i) => html`<div key=${i} className="vg-contest">
        <p className="vg-office">${c.vote_for === 1 ? W('vg.voteForOne', { office: c.office }) : W('vg.voteFor', { office: c.office, n: c.vote_for })}</p>
        <ul className="vg-names">${arr(c.names).map((n, j) => html`<li key=${j} className=${cx('vg-name', n.ours && 'vg-name--ours')}>
          <span className="vg-oval" aria-hidden="true"></span><span>${n.name}</span>${n.ours ? html`<span className="visually-hidden">${` ${W('vg.ours')}`}</span>` : null}
        </li>`)}</ul>
      </div>`)}
      ${ballotNote ? html`<p className="vg-ballot-note">${ballotNote}</p>` : null}
    </section>` : null}

    ${cta ? html`<p className="vg-cta"><a className="btn btn--action" href=${cta.href} target=${embed ? '_top' : undefined}>${cta.label}</a></p>` : null}
    ${guide.official_url ? html`<p className="vg-source small">${(() => {
      const label = html`<${Away} href=${guide.official_url} top=${embed}>${guide.official_label || guide.official_url}<//>`;
      return fillIn(W, 'vg.source', { label, day: guide.checkedOn ? keep(dayWords(guide.checkedOn, lang)) : '' });
    })()}</p>` : null}
  </div>`;
}
