// Volunteer openings and events from base.win, each with its own sign-up.
// Without JavaScript, "Sign up" opens a short form (first name, email or
// phone) that posts an RSVP. With JavaScript it posts in place, and once
// someone has signed up for one — or sent any form on the site in this
// visit — the next opening is one tap: their details are kept for the
// visit only (sessionStorage), with a "Not you?" to change them.
import { Fragment, useEffect, useRef, useState } from 'react';
import { html, cx } from './h.js';
import { Icon } from './icons.js';
import { Hidden, Honeypot, TextField } from './fields.js';
import { ME_KEY, rememberMe } from './form.js';
import { EMAIL_RE, str } from './util.js';

const newKey = () => {
  try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID(); } catch { /* fall through */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
};
const readMe = () => {
  try {
    const me = JSON.parse(sessionStorage.getItem(ME_KEY) || 'null');
    return me && me.first_name && (me.email || me.phone) ? me : null;
  } catch { return null; }
};

function DateBadge({ day, mon, small }) {
  return html`<div className=${cx('date-badge', small && 'date-badge--sm')} aria-hidden="true">
    <span className="day">${day}</span><span className="mon">${mon}</span>
  </div>`;
}

// After a sign-up: three plain links (no script needed to follow them),
// each a 48 px target on a phone (site.css .rsvp-cal).
function CalLine({ cal }) {
  if (!cal || !cal.ics) return null;
  const links = [
    cal.google ? { label: 'Google', href: cal.google, away: true } : null,
    cal.outlook ? { label: 'Outlook', href: cal.outlook, away: true } : null,
    { label: 'Apple & others', href: cal.ics },
  ].filter(Boolean);
  return html`<p className="rsvp-cal"><span className="rsvp-cal-say">Add it to your calendar:</span>${links.map((l, i) => html`<${Fragment} key=${l.label}>
    ${i ? html`<span aria-hidden="true">·</span>` : ' '}<a href=${l.href} target=${l.away ? '_blank' : undefined} rel=${l.away ? 'noopener noreferrer' : undefined}>${l.label}</a><//>`)}</p>`;
}

function Rsvp({ uid, item, action, hidden, me, setMe, state, setState, primary }) {
  const st = state || { status: 'idle', errors: {} };
  const set = (patch) => setState(item.id, { ...st, ...patch });
  // The form's own action, as the page has it (with any path the server put
  // in front, under BASE_PATH) — also for a one-tap sign-up.
  const formRef = useRef(null);

  async function send(body, form) {
    set({ status: 'pending', errors: {}, alert: '' });
    try {
      const res = await fetch((form || formRef.current)?.action || action, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ ...body, ...hidden, shift_id: item.id, client_key: newKey() }),
        credentials: 'same-origin',
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json?.ok) {
        rememberMe(body);
        setMe(readMe() || { first_name: body.first_name, email: body.email, phone: body.phone });
        set({ status: 'done', open: false });
        return;
      }
      const field = str(json?.field);
      const message = str(json?.error) || (res.status === 429 ? 'Too many tries from here. Please wait a minute.' : 'That didn’t go through. Please try again.');
      set({ status: 'open', open: true, errors: field && ['first_name', 'email', 'phone'].includes(field) ? { [field]: message } : {}, alert: message });
    } catch {
      set({ status: 'open', open: true, alert: 'We couldn’t send that. Check your connection and try again.' });
    }
  }

  if (st.status === 'done') {
    return html`<${Fragment}><div className="rsvp-done" role="status">
      <${Icon} name="check" size=${18} stroke=${3} />
      <span>You’re signed up${me?.first_name ? `, ${me.first_name}` : ''}. See you there!</span>
    </div>
    <${CalLine} cal=${item.cal} /><//>`;
  }
  if (item.full) return html`<p className="rsvp-full">This one is full.</p>`;

  const onSummary = (e) => {
    if (me && st.status === 'idle') {
      e.preventDefault();
      send({ first_name: me.first_name, last_name: me.last_name || '', email: me.email || '', phone: me.phone || '' });
    }
  };
  const onSubmit = (e) => {
    e.preventDefault();
    if (st.status === 'pending') return;
    const fd = new FormData(e.currentTarget);
    const body = {
      first_name: str(fd.get('first_name')).trim(),
      email: str(fd.get('email')).trim(),
      phone: str(fd.get('phone')).trim(),
      website: str(fd.get('website')),
    };
    const errors = {};
    if (!body.first_name) errors.first_name = 'Enter your first name';
    if (body.email && !EMAIL_RE.test(body.email)) errors.email = 'Enter an email address like name@example.org';
    if (!body.email && !body.phone) errors.email = 'Enter your email or a phone number';
    if (Object.keys(errors).length) {
      set({ errors, open: true });
      const first = e.currentTarget.elements.namedItem(Object.keys(errors)[0]);
      first?.focus?.();
      return;
    }
    send(body, e.currentTarget);
  };

  const id = `${uid}-${item.id}`;
  return html`<details className="rsvp" open=${Boolean(st.open)} onToggle=${(e) => { if (e.currentTarget.open !== Boolean(st.open)) set({ open: e.currentTarget.open }); }}>
    <summary className=${cx('btn rsvp-toggle', primary ? 'btn--primary' : 'btn--outline')} onClick=${onSummary} aria-busy=${st.status === 'pending' ? 'true' : undefined}>
      ${st.status === 'pending' ? 'Signing you up…' : me ? 'Sign me up' : 'Sign up'}<span className="visually-hidden">: ${item.title}</span>
    </summary>
    <form ref=${formRef} className="rsvp-form" method="post" action=${action} noValidate=${me !== undefined || undefined} onSubmit=${onSubmit}>
      <${Honeypot} id=${id} />
      <${Hidden} values=${{ ...hidden, shift_id: item.id }} />
      <${TextField} id=${`${id}-first`} name="first_name" label="First name" required autoComplete="given-name" error=${st.errors?.first_name} />
      <${TextField} id=${`${id}-email`} name="email" type="email" label="Email" autoComplete="email" inputMode="email" error=${st.errors?.email} />
      <${TextField} id=${`${id}-phone`} name="phone" type="tel" label="Mobile number" optional autoComplete="tel" inputMode="tel" error=${st.errors?.phone} />
      ${st.alert ? html`<div className="form-alert" role="alert">${st.alert}</div>` : null}
      <button type="submit" className="btn btn--primary btn--block">I’ll be there</button>
    </form>
  </details>`;
}

// error: after a plain post (no JavaScript) that was refused, what to say
// ({ field, message }, context.js errorFor) — above the openings.
// sentItem: after a plain sign-up, the opening it was for (when named).
export function Openings({ uid, variant = 'shifts', action, hidden = {}, items = [], sent = false, sentItem = '', error = null }) {
  const [me, setMe] = useState(undefined);
  const [states, setStates] = useState({});
  // Who signed up before in this visit, read once the page is live
  // (undefined until then: the server's first draw and the browser's agree).
  useEffect(() => {
    setMe(readMe());
  }, []);
  const setState = (id, s) => setStates((all) => ({ ...all, [id]: s }));
  // Back from a plain sign-up: the one named, or the only one there is.
  const sentOne = sent ? (sentItem ? items.find((it) => it.id === sentItem) : items.length === 1 ? items[0] : null) : null;
  const forget = () => {
    try { sessionStorage.removeItem(ME_KEY); } catch { /* nothing kept */ }
    setMe(null);
  };
  const rsvp = (item, primary) => html`<${Rsvp} uid=${uid} item=${item} action=${action} hidden=${hidden} me=${me} setMe=${setMe}
    state=${states[item.id]} setState=${setState} primary=${primary} />`;

  // A place with no words of its own (a pin nobody has named) is its map.
  const whereLine = (it) => (it.where || it.map ? html`<p className="event-where">
    ${it.map ? html`<a href=${it.map} target="_blank" rel="noopener noreferrer"><${Icon} name="pin" size=${16} />${it.where || 'See the map'}<span className="visually-hidden"> (map, opens in a new tab)</span></a>` : it.where}
  </p>` : null);

  return html`<div className=${cx('openings', `openings--${variant}`)}>
    ${sent ? html`<p className="rsvp-done rsvp-done--page" role="status"><${Icon} name="check" size=${18} stroke=${3} /><span>You’re signed up. See you there!</span></p>` : null}
    ${sentOne ? html`<${CalLine} cal=${sentOne.cal} />` : null}
    ${!sent && str(error?.message) ? html`<p className="form-alert" role="alert">${error.message}</p>` : null}
    ${me ? html`<p className="rsvp-me">Signing up as <strong>${me.first_name}</strong>. <button type="button" className="link-button" onClick=${forget}>Not you?</button></p>` : null}
    ${variant === 'events' && items[0] ? html`<article className="event-feature">
      <${DateBadge} day=${items[0].day} mon=${items[0].mon} />
      <div className="info">
        <h3>${items[0].title}</h3>
        <p className="event-when">${items[0].date}, ${items[0].time}</p>
        ${whereLine(items[0])}
        ${items[0].spots ? html`<p className="spots">${items[0].spots}</p>` : null}
      </div>
      <div className="event-action">${rsvp(items[0], true)}</div>
    </article>` : null}
    ${(variant === 'events' ? items.slice(1) : items).length ? html`<ul className=${variant === 'events' ? 'event-list' : 'opening-list'}>
      ${(variant === 'events' ? items.slice(1) : items).map((it) => html`<li key=${it.id} className=${cx(variant === 'events' ? 'event-row' : 'opening-card', it.full && 'is-full')}>
        <${DateBadge} day=${it.day} mon=${it.mon} small />
        <div className="info">
          <h3>${it.title}</h3>
          <p className="event-when">${it.date}, ${it.time}</p>
          ${whereLine(it)}
          ${it.spots ? html`<p className=${cx('spots', it.low && 'spots--low')}>${it.spots}</p>` : null}
          ${rsvp(it, variant !== 'events')}
        </div>
      </li>`)}
    </ul>` : null}
  </div>`;
}
