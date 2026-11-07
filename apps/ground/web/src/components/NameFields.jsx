// First · Middle · Last, for Add a person and Edit details. A first name
// with a second word or an initial ("Mary Anne", "John A." — not
// "Mary-Anne") goes to Middle name by itself when you leave the field, with
// an Undo; a record already on file that reads that way gets the same as a
// suggestion (shared/names.js). form: { first, middle, last }.
import { useState } from 'react';
import { splitFirst } from '@base-ground/shared/names';

export default function NameFields({ id, form, setForm, autoFocus = false }) {
  const [moved, setMoved] = useState(null); // { from, first, middle } — the last automatic move, for Undo
  const [kept, setKept] = useState(null); // a first name you said is one name
  const set = (k) => (e) => { setMoved(null); setForm((f) => ({ ...f, [k]: e.target.value })); };
  const cut = !String(form.middle || '').trim() && form.first !== kept ? splitFirst(form.first) : null;
  const move = () => {
    if (!cut) return;
    setMoved({ from: form.first, ...cut });
    setForm((f) => ({ ...f, first: cut.first, middle: cut.middle }));
  };
  const undo = () => {
    setKept(moved.from);
    setForm((f) => ({ ...f, first: moved.from, middle: '' }));
    setMoved(null);
  };
  return (
    <>
      <div className="form-row">
        <div className="field">
          <label htmlFor={`${id}-first`}>First name</label>
          <input id={`${id}-first`} className="input" autoFocus={autoFocus} maxLength={150} value={form.first} onChange={set('first')} onBlur={move} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-middle`}>Middle name</label>
          <input id={`${id}-middle`} className="input" maxLength={150} value={form.middle} onChange={set('middle')} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-last`}>Last name</label>
          <input id={`${id}-last`} className="input" maxLength={150} value={form.last} onChange={set('last')} />
        </div>
      </div>
      {moved && (
        <p className="muted name-note" role="status">
          Moved “{moved.middle}” to Middle name.{' '}
          <button type="button" className="btn-link" onClick={undo}>Undo — it’s part of the first name</button>
        </p>
      )}
      {!moved && cut && (
        <p className="muted name-note">
          “{cut.middle}” looks like a middle name.{' '}
          <button type="button" className="btn-link" onClick={move}>Move it to Middle name</button>
          {' · '}
          <button type="button" className="btn-link" onClick={() => setKept(form.first)}>No, it’s one name</button>
        </p>
      )}
    </>
  );
}
