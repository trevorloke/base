// Every public form on the website — newsletter, petition and pledge,
// volunteer, contact, join, donate — is this one island, drawn from the
// settings the module hands it (the server builds them; see modules.js).
//
// Without JavaScript it is a plain form that posts to {root}api/forms/<kind>
// and comes back with ?sent=<kind> (the thank-you) or ?error=<field>. With
// JavaScript it posts the same fields as JSON, says what is wrong next to
// each field (and moves focus there), and swaps in the thank-you — or goes
// to the payment page when the answer has a checkout_url. The field names
// are SITE.md's, exactly.
import { useEffect, useRef, useState } from 'react';
import { html, cx } from './h.js';
import { Check, Choices, FieldError, Hidden, Honeypot, SelectField, TextField } from './fields.js';
import { ShareSheet } from './share.js';
import { EMAIL_RE, money, parseDollars, str, trackFrom } from './util.js';

const POSTAL = /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const newKey = () => {
  try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID(); } catch { /* fall through */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
};

// The details someone gave, kept for this visit only (sessionStorage) so
// a volunteer opening is one tap after the first form.
export const ME_KEY = 'site:me';
export const rememberMe = (body) => {
  try {
    const me = { first_name: body.first_name || '', last_name: body.last_name || '', email: body.email || '', phone: body.phone || '' };
    if (me.first_name && (me.email || me.phone)) sessionStorage.setItem(ME_KEY, JSON.stringify(me));
  } catch { /* storage blocked: no one-tap, nothing else changes */ }
};

const STATUS_MESSAGES = {
  429: 'Too many tries from here. Please wait a minute and try again.',
  503: 'This can’t be sent online right now. Please try again later.',
};

// The amount: once or monthly, the suggested amounts (never above the
// year's limit; monthly, never above a twelfth of it) and, with
// JavaScript, any other amount typed in.
function AmountPicker({ uid, a, cadence, setCadence, pick, setPick, other, setOther, error }) {
  const cap = cadence === 'monthly' ? a.monthlyMax || a.limit : a.limit;
  const presets = (a.presets || []).filter((c) => !cap || c <= cap);
  const errId = error ? `${uid}-amount-error` : null;
  return html`<div className="amount-picker">
    ${a.monthly ? html`<fieldset className="group">
      <legend>How often?</legend>
      <div className="toggle">
        ${[['once', 'Once'], ['monthly', 'Monthly']].map(([v, l]) => html`<label key=${v} className="toggle-option" htmlFor=${`${uid}-cadence-${v}`}>
          <input type="radio" id=${`${uid}-cadence-${v}`} name="cadence" value=${v} checked=${cadence === v} onChange=${() => setCadence(v)} />
          <span>${l}</span>
        </label>`)}
      </div>
    </fieldset>` : null}
    <fieldset className="group" id=${`${uid}-amount`} aria-describedby=${errId || undefined}>
      <legend>${a.legend || 'Choose an amount'}</legend>
      <div className="amounts">
        ${presets.map((c) => html`<label key=${c} className="amount" htmlFor=${`${uid}-amt-${c}`}>
          <input type="radio" id=${`${uid}-amt-${c}`} name="amount_cents" value=${c} checked=${pick === c} onChange=${() => setPick(c)} />
          <span>${money(c)}</span>
        </label>`)}
      </div>
      <div className="field other-amount js-only">
        <label htmlFor=${`${uid}-other`}>Other amount</label>
        <div className="custom-amount">
          <span aria-hidden="true">$</span>
          <input id=${`${uid}-other`} className="input" inputMode="decimal" autoComplete="off" value=${other}
            aria-invalid=${error && pick === 'other' ? 'true' : undefined} aria-describedby=${errId || undefined}
            onChange=${(e) => { setOther(e.target.value); setPick(e.target.value.trim() ? 'other' : a.defaultCents); }} />
        </div>
      </div>
      <${FieldError} id=${errId} error=${error} />
    </fieldset>
    ${a.note ? html`<p className="amount-note">${a.note}</p>` : null}
    ${cadence === 'monthly' && a.monthlyNote ? html`<p className="amount-note">${a.monthlyNote}</p>` : null}
  </div>`;
}

// Fields in rows: two half-width fields side by side, the rest full width.
function rows(fields) {
  const out = [];
  for (const f of fields) {
    const last = out[out.length - 1];
    if (f.half && Array.isArray(last) && last.length === 1) last.push(f);
    else out.push(f.half ? [f] : f);
  }
  return out;
}

export function SiteForm(props) {
  const {
    uid, kind, action, layout = 'card', title, hidden = {}, fields = [], amount, impliedConsent,
    needsContact = true, submit = 'Send', small, thanks = {}, sent = false, error: given = null,
  } = props;
  const [done, setDone] = useState(Boolean(sent));
  const [errors, setErrors] = useState(given?.field ? { [given.field]: given.message } : {});
  const [alert, setAlert] = useState(given ? (given.field ? 'Please check the highlighted field.' : given.message) : '');
  const [pending, setPending] = useState(false);
  const [live, setLive] = useState(false);
  const [track, setTrack] = useState({ ref: str(hidden.ref), source: str(hidden.source) });
  const [cadence, setCadence] = useState('once');
  const [pick, setPick] = useState(amount ? amount.defaultCents : null);
  const [other, setOther] = useState('');
  const key = useRef('');
  // The last send didn't get through (no answer, or the server couldn't
  // finish it): the server may be keeping it, unanswered, under this key.
  const unsure = useRef(false);
  const thanksRef = useRef(null);
  const justSent = useRef(false);

  useEffect(() => {
    setLive(true);
    key.current = newKey();
    // A referral code or a share tag in the address the page didn't carry —
    // only as the server takes them (util.js trackFrom): a long tracking
    // link never stops the form.
    try {
      const addr = trackFrom(window.location.search);
      setTrack((t) => ({ ref: t.ref || addr.ref, source: t.source || addr.source }));
    } catch { /* no address to read */ }
    // Back from the payment page, the browser may show this page as it was
    // left (the back/forward cache): what is sent from it now is a new form,
    // not a retry of the one that went to pay.
    const back = (e) => { if (e.persisted) { key.current = newKey(); setPending(false); } };
    window.addEventListener('pageshow', back);
    return () => window.removeEventListener('pageshow', back);
  }, []);
  useEffect(() => {
    if (done && justSent.current) thanksRef.current?.focus();
  }, [done]);

  const changeCadence = (v) => {
    setCadence(v);
    const cap = v === 'monthly' ? amount.monthlyMax || amount.limit : amount.limit;
    if (typeof pick === 'number' && cap && pick > cap) {
      const fits = (amount.presets || []).filter((c) => c <= cap);
      setPick(fits.length ? fits[Math.min(1, fits.length - 1)] : 'other');
    }
  };
  const cents = !amount ? null : pick === 'other' ? parseDollars(other) : pick;
  // After a send that didn't get through, any change makes this a new form
  // with a new key: a typo put right, or the next person at a shared
  // screen, is never taken for that send. Sent again unchanged, it keeps
  // its key and finishes what was started.
  const edited = () => {
    if (!unsure.current) return;
    unsure.current = false;
    key.current = newKey();
  };

  if (done) {
    const t = thanks || {};
    return html`<div className="success-card" role="status" tabIndex="-1" ref=${thanksRef}>
      <h3 className="success-card__title">${t.title || 'Thank you'}</h3>
      ${t.body ? html`<p>${t.body}</p>` : null}
      ${t.share ? html`<${ShareSheet} uid=${`${uid}-share`} ...${t.share} />` : null}
    </div>`;
  }

  const names = new Set(fields.map((f) => f.name).filter(Boolean));

  function read(form) {
    const fd = new FormData(form);
    const body = {};
    for (const f of fields) {
      if (!f.name) continue;
      if (f.type === 'check') body[f.name] = fd.get(f.name) === 'true';
      else if (f.type === 'checks') body[f.name] = fd.getAll(f.name).map(String);
      else if (f.type === 'radios' && f.number) body[f.name] = fd.get(f.name) ? Number(fd.get(f.name)) : null;
      else body[f.name] = str(fd.get(f.name)).trim();
    }
    if (impliedConsent) body[impliedConsent] = true;
    for (const [k, v] of Object.entries(hidden)) if (v !== undefined && v !== null && v !== '' && !(k in body)) body[k] = v;
    if (track.ref) body.ref = track.ref;
    if (track.source) body.source = track.source;
    if (amount) {
      body.amount_cents = cents;
      if (amount.monthly) body.cadence = cadence;
      else if (amount.cadence) body.cadence = 'once';
    }
    body.website = str(fd.get('website'));
    body.client_key = key.current || newKey();
    return body;
  }

  function check(body) {
    const errs = {};
    for (const f of fields) {
      if (!f.name || !f.required) continue;
      const v = body[f.name];
      const empty = f.type === 'check' ? v !== true : f.type === 'checks' ? !v?.length : v == null || v === '';
      if (empty) errs[f.name] = f.msg || 'This is needed';
    }
    if (body.email && !EMAIL_RE.test(body.email)) errs.email = 'Enter an email address like name@example.org';
    if (body.phone && body.phone.replace(/\D/g, '').length < 10) errs.phone = 'Enter a phone number with its area code';
    if (body.postal_code && !POSTAL.test(body.postal_code)) errs.postal_code = 'Enter a postal code like V3T 1A1';
    if (body.birth_date && !DAY.test(body.birth_date)) errs.birth_date = 'Enter your date of birth';
    if (needsContact && !body.email && !body.phone && !errs.email && !errs.phone) errs[names.has('email') ? 'email' : 'phone'] = 'Enter your email or a phone number';
    if (body.consent_sms === true && !body.phone && names.has('phone')) errs.phone = 'Add a mobile number so we can text you, or untick the text box';
    if (amount) {
      const cap = cadence === 'monthly' ? amount.monthlyMax || amount.limit : amount.limit;
      if (!cents || cents < (amount.min || 100)) errs.amount_cents = pick === 'other' ? `Enter an amount of at least ${money(amount.min || 100)}` : 'Choose an amount';
      else if (cap && cents > cap) errs.amount_cents = `The most you can give is ${money(cap)}${cadence === 'monthly' ? ' a month' : ' this year'}`;
    }
    return errs;
  }

  function focusFirst(form, errs) {
    const order = [...fields.map((f) => f.name || (f.type === 'amount' ? 'amount_cents' : null)), 'amount_cents'].filter(Boolean);
    const first = order.find((n) => errs[n]);
    if (!first) return;
    let el = first === 'amount_cents'
      ? (pick === 'other' ? form.querySelector(`#${uid}-other`) : form.querySelector('input[name="amount_cents"]'))
      : form.elements.namedItem(first);
    if (el && typeof el.length === 'number' && !el.focus) el = el[0];
    el?.focus?.();
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (pending) return;
    const form = e.currentTarget;
    const body = read(form);
    const errs = check(body);
    if (Object.keys(errs).length) {
      setErrors(errs);
      setAlert(Object.keys(errs).length === 1 ? 'Please check the highlighted field.' : `Please check the ${Object.keys(errs).length} highlighted fields.`);
      focusFirst(form, errs);
      return;
    }
    setErrors({});
    setAlert('');
    setPending(true);
    try {
      const res = await fetch(form.action, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        credentials: 'same-origin',
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json?.ok) {
        rememberMe(body);
        // Answered: this key is spent. A form sent from here again (back
        // from the payment page with another amount, say) is a new one.
        key.current = newKey();
        const url = str(json.checkout_url);
        if (url) {
          let target = null;
          try {
            const u = new URL(url, window.location.href);
            if (u.protocol === 'https:' || u.origin === window.location.origin) target = u.href;
          } catch { /* not a link */ }
          if (target) { window.location.assign(target); return; }
        }
        justSent.current = true;
        setDone(true);
        return;
      }
      if (res.status >= 500) unsure.current = true;
      const field = str(json?.field);
      const message = str(json?.error) || STATUS_MESSAGES[res.status] || 'Something went wrong. Please try again.';
      if (res.status === 400 && field && (names.has(field) || field === 'amount_cents')) {
        setErrors({ [field]: message });
        setAlert('Please check the highlighted field.');
        focusFirst(form, { [field]: message });
      } else {
        setAlert(message);
      }
    } catch {
      unsure.current = true;
      setAlert('We couldn’t send that. Check your connection and try again.');
    } finally {
      setPending(false);
    }
  }

  const fieldFor = (f) => {
    const id = `${uid}-${f.name || f.type}`;
    const error = f.name ? errors[f.name] : null;
    switch (f.type) {
      case 'section': return html`<h4 key=${id} className="form-section">${f.label}</h4>`;
      case 'note': return html`<p key=${id} className="form-note">${f.label}</p>`;
      case 'amount':
        return amount ? html`<${AmountPicker} key=${id} uid=${uid} a=${amount} cadence=${cadence} setCadence=${changeCadence}
          pick=${pick} setPick=${setPick} other=${other} setOther=${setOther} error=${errors.amount_cents} />` : null;
      case 'check': return html`<${Check} key=${id} id=${id} name=${f.name} label=${f.label} required=${f.required} error=${error} hint=${f.hint} />`;
      case 'checks': case 'radios':
        return html`<${Choices} key=${id} id=${id} name=${f.name} legend=${f.label} options=${f.options || []} type=${f.type === 'radios' ? 'radio' : 'checkbox'}
          required=${f.required} optional=${f.optional} error=${error} value=${f.value} columns=${f.columns} />`;
      case 'select': return html`<${SelectField} key=${id} id=${id} name=${f.name} label=${f.label} options=${f.options || []} optional=${f.optional} required=${f.required} error=${error} />`;
      default:
        return html`<${TextField} key=${id} id=${id} name=${f.name} label=${f.label} type=${f.type || 'text'} required=${f.required} optional=${f.optional}
          autoComplete=${f.autoComplete} inputMode=${f.inputMode} hint=${f.hint} error=${error} max=${f.max} rows=${f.rows} placeholder=${f.placeholder} />`;
    }
  };

  const total = cents ? ` ${money(cents)}${amount?.monthly && cadence === 'monthly' ? ' a month' : ''}` : '';
  return html`<form className=${cx('site-form', layout === 'inline' ? 'site-form--inline' : 'form-card')} method="post" action=${action}
      noValidate=${live || undefined} onSubmit=${onSubmit} onChange=${edited} aria-busy=${pending ? 'true' : undefined} aria-labelledby=${title ? `${uid}-title` : undefined}>
    ${title ? html`<h3 className="form-title" id=${`${uid}-title`}>${title}</h3>` : null}
    <${Honeypot} id=${uid} />
    <${Hidden} values=${{ ...hidden, ...(impliedConsent ? { [impliedConsent]: 'true' } : {}), ...(amount && !amount.monthly && amount.cadence ? { cadence: 'once' } : {}) }} />
    <div className="form-fields">
      ${rows(fields).map((r, i) => (Array.isArray(r)
        ? html`<div key=${`row-${i}`} className="form-row">${r.map(fieldFor)}</div>`
        : fieldFor(r)))}
    </div>
    ${alert ? html`<div className="form-alert" role="alert">${alert}</div>` : null}
    <button type="submit" className=${cx('btn btn--submit', props.submitClass || 'btn--action', layout !== 'inline' && 'btn--lg btn--block')} aria-disabled=${pending ? 'true' : undefined}>
      <span>${pending ? 'Sending…' : submit}${amount && !pending ? html`<span className="js-only">${total}</span>` : null}</span>
    </button>
    ${small || props.privacy ? html`<p className="form-small">${small || null}${small && props.privacy ? ' ' : null}${props.privacy ? html`<a href=${props.privacy}>Privacy policy</a>` : null}</p>` : null}
  </form>`;
}
