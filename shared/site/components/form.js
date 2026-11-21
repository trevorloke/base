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
import { EMAIL_RE, money, parseDollars, str, thousands, trackFrom } from './util.js';
import { PRIVACY_LINE } from '../wording.js';
import { wordsIn } from '../ui-words.js';

// The small print under every form: its own words (small), then who keeps
// what was sent and why, then the main site's privacy policy (when it has
// one) — one paragraph, one privacy link.
// On a translated page (w given) the privacy line is the approved words
// (privacyLine), and a line that fell back to English says so (lang).
export function FormSmall({ small, privacy, keeper, privacyLine, privacyLang, smallLang, w }) {
  if (!w) return html`<p className="form-small">${small ? `${small} ` : null}${PRIVACY_LINE(keeper)}${privacy ? ' ' : null}${privacy ? html`<a href=${privacy}>Privacy policy</a>` : null}</p>`;
  const W = wordsIn(w);
  return html`<p className="form-small">${small ? html`<span lang=${smallLang}>${small}</span>` : null}${small ? ' ' : null}<span lang=${privacyLang}>${privacyLine ?? PRIVACY_LINE(keeper)}</span>${privacy ? ' ' : null}${privacy ? html`<a href=${privacy}>${W('form.privacyPolicy')}</a>` : null}</p>`;
}

const POSTAL = /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const REF = /^[a-z0-9]{6,16}$/;
// The share link with ?ref=<code> (in place of any ref it had), the rest of
// its address and its #part kept; withSource adds each channel's tag after.
const withRef = (url, code) => {
  if (!code || !str(url)) return url;
  const [front, hash] = str(url).split('#');
  const [path, query = ''] = front.split('?');
  const kept = query.split('&').filter((p) => p && !/^ref=/.test(p));
  kept.push(`ref=${code}`);
  return `${path}?${kept.join('&')}${hash !== undefined ? `#${hash}` : ''}`;
};

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

const STATUS_KEYS = { 429: 'form.busy', 503: 'form.unavailable' };

// The amount: once or monthly, the suggested amounts (never above the
// year's limit; monthly, never above a twelfth of it) and, with
// JavaScript, any other amount typed in.
function AmountPicker({ uid, a, cadence, setCadence, pick, setPick, other, setOther, error, W }) {
  const cap = cadence === 'monthly' ? a.monthlyMax || a.limit : a.limit;
  const presets = (a.presets || []).filter((c) => !cap || c <= cap);
  const errId = error ? `${uid}-amount-error` : null;
  return html`<div className="amount-picker">
    ${a.monthly ? html`<fieldset className="group">
      <legend>${W('form.howOften')}</legend>
      <div className="toggle">
        ${[['once', W('form.once')], ['monthly', W('form.monthly')]].map(([v, l]) => html`<label key=${v} className="toggle-option" htmlFor=${`${uid}-cadence-${v}`}>
          <input type="radio" id=${`${uid}-cadence-${v}`} name="cadence" value=${v} checked=${cadence === v} onChange=${() => setCadence(v)} />
          <span>${l}</span>
        </label>`)}
      </div>
    </fieldset>` : null}
    <fieldset className="group" id=${`${uid}-amount`} aria-describedby=${errId || undefined}>
      <legend>${a.legend || W('form.chooseAmount')}</legend>
      <div className="amounts">
        ${presets.map((c) => html`<label key=${c} className="amount" htmlFor=${`${uid}-amt-${c}`}>
          <input type="radio" id=${`${uid}-amt-${c}`} name="amount_cents" value=${c} checked=${pick === c} onChange=${() => setPick(c)} />
          <span>${money(c)}</span>
        </label>`)}
      </div>
      <div className="field other-amount js-only">
        <label htmlFor=${`${uid}-other`}>${W('form.otherAmount')}</label>
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

// A petition or pledge just signed here: the count beside it (GoalBar, drawn
// with the page) takes the new signature, so "Your name is on the petition"
// never sits next to a number without it.
function countMe(form) {
  const goal = form?.closest('section')?.querySelector('.goal');
  const strong = goal?.querySelector('.goal-label strong');
  if (!strong) return;
  const was = Number(String(strong.textContent).replace(/[^0-9]/g, '')) || 0;
  const from = thousands(was);
  const to = thousands(was + 1);
  strong.textContent = to;
  const bar = goal.querySelector('progress.goal-bar');
  if (bar) {
    bar.value = Math.min(was + 1, Number(bar.max) || was + 1);
    const label = bar.getAttribute('aria-label');
    // The number only where it can't be mistaken for the goal's digits.
    if (label && label.split(from).length === 2) bar.setAttribute('aria-label', label.replace(from, to));
  }
}

export function SiteForm(props) {
  const {
    uid, kind, action, layout = 'card', title, hidden = {}, fields = [], amount, impliedConsent,
    needsContact = true, submit: submitGiven, small, thanks = {}, sent = false, error: given = null, w,
  } = props;
  // The page's words (translated pages), else the English.
  const W = wordsIn(w);
  const submit = submitGiven ?? W('form.send');
  const [done, setDone] = useState(Boolean(sent));
  const [errors, setErrors] = useState(given?.field ? { [given.field]: given.message } : {});
  const [alert, setAlert] = useState(given ? (given.field ? W('form.checkField') : given.message) : '');
  const [pending, setPending] = useState(false);
  const [live, setLive] = useState(false);
  const [track, setTrack] = useState({ ref: str(hidden.ref), source: str(hidden.source) });
  // Their own referral code, when the answer gave one: the thank-you's share
  // link carries it, so a friend who signs through it counts as theirs.
  const [mine, setMine] = useState('');
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
      <h3 className="success-card__title">${t.title || W('form.thanks')}</h3>
      ${t.body ? html`<p>${t.body}</p>` : null}
      ${t.share ? html`<${ShareSheet} uid=${`${uid}-share`} ...${t.share} url=${withRef(t.share.url, mine)} w=${w} />` : null}
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
      if (empty) errs[f.name] = f.msg || W('form.needed');
    }
    if (body.email && !EMAIL_RE.test(body.email)) errs.email = W('form.emailLike');
    if (body.phone && body.phone.replace(/\D/g, '').length < 10) errs.phone = W('err.phone');
    if (body.postal_code && !POSTAL.test(body.postal_code)) errs.postal_code = W('err.postal_code');
    if (body.birth_date && !DAY.test(body.birth_date)) errs.birth_date = W('err.birth_date');
    if (needsContact && !body.email && !body.phone && !errs.email && !errs.phone) errs[names.has('email') ? 'email' : 'phone'] = W('form.emailOrPhone');
    if (body.consent_sms === true && !body.phone && names.has('phone')) errs.phone = W('form.smsNeedsPhone');
    if (amount) {
      const cap = cadence === 'monthly' ? amount.monthlyMax || amount.limit : amount.limit;
      if (!cents || cents < (amount.min || 100)) errs.amount_cents = pick === 'other' ? W('form.atLeast', { amount: money(amount.min || 100) }) : W('form.chooseAmount');
      else if (cap && cents > cap) errs.amount_cents = W(cadence === 'monthly' ? 'form.mostMonth' : 'form.mostYear', { amount: money(cap) });
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
      setAlert(Object.keys(errs).length === 1 ? W('form.checkField') : W('form.checkFields', { count: Object.keys(errs).length }));
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
        if (REF.test(str(json.ref_code))) setMine(json.ref_code);
        if (kind === 'petition' || kind === 'pledge') countMe(form);
        justSent.current = true;
        setDone(true);
        return;
      }
      if (res.status >= 500) unsure.current = true;
      const field = str(json?.field);
      const message = str(json?.error) || (STATUS_KEYS[res.status] ? W(STATUS_KEYS[res.status]) : W('form.wrong'));
      if (res.status === 400 && field && (names.has(field) || field === 'amount_cents')) {
        setErrors({ [field]: message });
        setAlert(W('form.checkField'));
        focusFirst(form, { [field]: message });
      } else {
        setAlert(message);
      }
    } catch {
      unsure.current = true;
      setAlert(W('form.offline'));
    } finally {
      setPending(false);
    }
  }

  const fieldFor = (f) => {
    const id = `${uid}-${f.name || f.type}`;
    const error = f.name ? errors[f.name] : null;
    switch (f.type) {
      case 'section': return html`<h4 key=${id} className="form-section">${f.label}</h4>`;
      case 'note': return html`<p key=${id} className="form-note" lang=${f.labelLang}>${f.label}</p>`;
      case 'amount':
        return amount ? html`<${AmountPicker} key=${id} uid=${uid} a=${amount} cadence=${cadence} setCadence=${changeCadence}
          pick=${pick} setPick=${setPick} other=${other} setOther=${setOther} error=${errors.amount_cents} W=${W} />` : null;
      case 'check': return html`<${Check} key=${id} id=${id} name=${f.name} label=${f.label} required=${f.required} error=${error} hint=${f.hint} lang=${f.labelLang} W=${w ? W : null} />`;
      case 'checks': case 'radios':
        return html`<${Choices} key=${id} id=${id} name=${f.name} legend=${f.label} options=${f.options || []} type=${f.type === 'radios' ? 'radio' : 'checkbox'}
          required=${f.required} optional=${f.optional} error=${error} value=${f.value} columns=${f.columns} W=${w ? W : null} />`;
      case 'select': return html`<${SelectField} key=${id} id=${id} name=${f.name} label=${f.label} options=${f.options || []} optional=${f.optional} required=${f.required} error=${error} W=${w ? W : null} />`;
      default:
        return html`<${TextField} key=${id} id=${id} name=${f.name} label=${f.label} type=${f.type || 'text'} required=${f.required} optional=${f.optional}
          autoComplete=${f.autoComplete} inputMode=${f.inputMode} hint=${f.hint} error=${error} max=${f.max} rows=${f.rows} placeholder=${f.placeholder} W=${w ? W : null} />`;
    }
  };

  const total = cents ? ` ${money(cents)}${amount?.monthly && cadence === 'monthly' ? ` ${W('form.aMonth')}` : ''}` : '';
  return html`<form className=${cx('site-form', layout === 'inline' ? 'site-form--inline' : 'form-card')} method="post" action=${action}
      noValidate=${live || undefined} onSubmit=${onSubmit} onChange=${edited} aria-busy=${pending ? 'true' : undefined} aria-labelledby=${title ? `${uid}-title` : undefined}>
    ${title ? html`<h3 className="form-title" id=${`${uid}-title`}>${title}</h3>` : null}
    <${Honeypot} id=${uid} W=${w ? W : null} />
    <${Hidden} values=${{ ...hidden, ...(impliedConsent ? { [impliedConsent]: 'true' } : {}), ...(amount && !amount.monthly && amount.cadence ? { cadence: 'once' } : {}) }} />
    <div className="form-fields">
      ${rows(fields).map((r, i) => (Array.isArray(r)
        ? html`<div key=${`row-${i}`} className="form-row">${r.map(fieldFor)}</div>`
        : fieldFor(r)))}
    </div>
    ${alert ? html`<div className="form-alert" role="alert">${alert}</div>` : null}
    <button type="submit" className=${cx('btn btn--submit', props.submitClass || 'btn--action', layout !== 'inline' && 'btn--lg btn--block')} aria-disabled=${pending ? 'true' : undefined}>
      <span>${pending ? W('form.sending') : submit}${amount && !pending ? html`<span className="js-only">${total}</span>` : null}</span>
    </button>
    <${FormSmall} small=${small} privacy=${props.privacy} keeper=${props.keeper} privacyLine=${props.privacyLine} privacyLang=${props.privacyLang} smallLang=${props.smallLang} w=${w} />
  </form>`;
}
