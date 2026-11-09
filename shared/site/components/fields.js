// The pieces every public form is built from. Each field ties its label,
// hint and error to the input (for/id, aria-describedby, aria-invalid), so a
// screen reader reads the error with the field and a form only has to say
// what went wrong. Plain elements with names: without JavaScript the same
// form posts as it is.
import { html, cx } from './h.js';

const describedBy = (...ids) => ids.filter(Boolean).join(' ') || undefined;

export function FieldError({ id, error }) {
  if (!error) return null;
  return html`<p className="field-error" id=${id}><span className="visually-hidden">Error: </span>${error}</p>`;
}

function Label({ id, label, optional }) {
  return html`<label htmlFor=${id}>${label}${optional ? html`<span className="opt"> (optional)</span>` : null}</label>`;
}

// text, email, tel, date and textarea.
export function TextField({ id, name, label, type = 'text', required, optional, autoComplete, inputMode, hint, error, max, value, rows, wide, placeholder }) {
  const hintId = hint ? `${id}-hint` : null;
  const errId = error ? `${id}-error` : null;
  const common = {
    id,
    name,
    required: required || undefined,
    'aria-invalid': error ? 'true' : undefined,
    'aria-describedby': describedBy(hintId, errId),
    autoComplete,
    maxLength: max || undefined,
    defaultValue: value || undefined,
    placeholder,
  };
  return html`<div className=${cx('field', wide && 'field--wide')}>
    <${Label} id=${id} label=${label} optional=${optional} />
    ${hint ? html`<p className="field-hint" id=${hintId}>${hint}</p>` : null}
    ${type === 'textarea'
      ? html`<textarea className="input input--area" rows=${rows || 4} ...${common} />`
      : html`<input className="input" type=${type} inputMode=${inputMode} ...${common} />`}
    <${FieldError} id=${errId} error=${error} />
  </div>`;
}

export function SelectField({ id, name, label, options = [], optional, required, error, value, wide }) {
  const errId = error ? `${id}-error` : null;
  return html`<div className=${cx('field', wide && 'field--wide')}>
    <${Label} id=${id} label=${label} optional=${optional} />
    <select className="input" id=${id} name=${name} required=${required || undefined} aria-invalid=${error ? 'true' : undefined} aria-describedby=${describedBy(errId)} defaultValue=${value || ''}>
      <option value="">Choose one</option>
      ${options.map((o) => html`<option key=${o.value} value=${o.value}>${o.label}</option>`)}
    </select>
    <${FieldError} id=${errId} error=${error} />
  </div>`;
}

// One tick box (a consent, the declaration). Never ticked for the person.
export function Check({ id, name, label, required, error, hint, value = 'true' }) {
  const hintId = hint ? `${id}-hint` : null;
  const errId = error ? `${id}-error` : null;
  return html`<div className="field field--check">
    <label className="check" htmlFor=${id}>
      <input type="checkbox" id=${id} name=${name} value=${value} required=${required || undefined} aria-invalid=${error ? 'true' : undefined} aria-describedby=${describedBy(hintId, errId)} />
      <span>${label}</span>
    </label>
    ${hint ? html`<p className="field-hint" id=${hintId}>${hint}</p>` : null}
    <${FieldError} id=${errId} error=${error} />
  </div>`;
}

// A group of tick boxes (roles) or of radio buttons (citizenship, term).
export function Choices({ id, name, legend, options = [], type = 'checkbox', required, optional, error, value, columns }) {
  const errId = error ? `${id}-error` : null;
  return html`<fieldset className="group" id=${id} aria-describedby=${describedBy(errId)}>
    <legend>${legend}${optional ? html`<span className="opt"> (optional)</span>` : null}</legend>
    <div className=${cx('choices', columns && 'choices--grid')}>
      ${options.map((o, i) => html`<label key=${o.value} className="check" htmlFor=${`${id}-${i}`}>
        <input type=${type} id=${`${id}-${i}`} name=${name} value=${o.value} required=${type === 'radio' && required ? true : undefined} defaultChecked=${value != null && String(value) === String(o.value) ? true : undefined} aria-invalid=${error ? 'true' : undefined} />
        <span>${o.label}</span>
      </label>`)}
    </div>
    <${FieldError} id=${errId} error=${error} />
  </fieldset>`;
}

// Hidden from people, irresistible to bots; a form that fills it is dropped.
export function Honeypot({ id }) {
  return html`<div className="hp" aria-hidden="true">
    <label htmlFor=${`${id}-website`}>Leave this empty</label>
    <input type="text" id=${`${id}-website`} name="website" tabIndex="-1" autoComplete="off" defaultValue="" />
  </div>`;
}

export function Hidden({ values }) {
  return Object.entries(values)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => html`<input key=${k} type="hidden" name=${k} defaultValue=${String(v)} />`);
}
