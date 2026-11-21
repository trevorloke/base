// Profile fields on the screens that aren't theirs (the manager's own screen
// is pages/Fields.jsx):
//
//   usePersonFields(id) / <PersonFields key={person.id} query personId />
//       the profile's "More details". The desk fills each field in with the
//       right control — Yes/No and Pick one as 48px tap buttons, Text, Number
//       and Date as inputs — and one Save (a field.values.set action, "✓
//       Saved"). A volunteer gets the filled-in fields a manager marked for
//       volunteers, read-only: the server sends nothing else. With no signal
//       the kept copy shows read-only ("Changing these needs signal"), or
//       the No signal line when nothing is kept. Keyed by person: nothing
//       typed or saved on one profile follows a link to the next.
//   <FieldFilterGroups chip />  People → Filter → More filters: one group per
//       field (Yes · No, its choices, the most common words, Filled in);
//       picks ?field=<id>:<value>, the same chip helper as every filter.
//   <FieldFilterChip value onRemove />  the removable chip for that filter,
//       "Language at home: Punjabi" — a volunteer reads the one field's name
//       (only one marked for them); unknown, "Profile field: Yes".
//   useImportFields() / FIELD_KEY / fieldCell   the import's column choices.
import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { groupsOf } from '@starbase/shared/fieldlists';
import { action, apiGet } from '../api.js';
import { NeedsSignalLine, NoSignal, noSignal, useOnline } from './NoSignal.jsx';
import './survey-questions.css';
import './fields-bits.css';

export const KINDS = [
  { code: 'text', label: 'Text' },
  { code: 'note', label: 'Long text' },
  { code: 'yesno', label: 'Yes/No' },
  { code: 'choice', label: 'Pick one' },
  { code: 'choices', label: 'Pick several' },
  { code: 'number', label: 'Number' },
  { code: 'date', label: 'Date' },
];
export const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.code, k.label]));
// The kinds with a list of choices (Pick one, Pick several).
export const hasChoices = (kind) => kind === 'choice' || kind === 'choices';
const TEXT_MAX = 500;
const NOTE_MAX = 4000;

// "2024-02-29" → "Feb 29, 2024" (the day as stored, never shifted by a time zone).
export const fmtDay = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return String(s ?? '');
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
    .toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
};
// A stored value in words.
export const fieldWords = (kind, v) => {
  if (v === null || v === undefined || v === '') return '';
  if (kind === 'yesno') return v === true ? 'Yes' : v === false ? 'No' : String(v);
  if (kind === 'date') return fmtDay(v);
  if (kind === 'number') return Number(v).toLocaleString('en-CA', { maximumFractionDigits: 6 });
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
};

// The desk's list of fields (counts, common values) — also the filter and import's.
export const FIELDS_QUERY = { queryKey: ['fields'], queryFn: () => apiGet('/fields'), staleTime: 30_000 };
export const useFieldsList = (enabled = true) => useQuery({ ...FIELDS_QUERY, enabled, retry: false });

// ── The profile ──
export function usePersonFields(personId) {
  return useQuery({
    queryKey: ['person', personId, 'fields'],
    queryFn: () => apiGet(`/persons/${personId}/fields`),
    enabled: Boolean(personId),
    staleTime: 30_000,
  });
}
export const filledCount = (query) => (query.data?.fields || []).filter((f) => f.value !== null && f.value !== undefined).length;

// What goes in a draft for each stored value (inputs hold strings).
const draftOf = (f) => {
  if (f.kind === 'choices') return Array.isArray(f.value) ? [...f.value] : [];
  if (f.value === null || f.value === undefined) return f.kind === 'yesno' || f.kind === 'choice' ? null : '';
  if (f.kind === 'yesno' || f.kind === 'choice') return f.value;
  return String(f.value);
};
const sameDraft = (f, d) => {
  const a = draftOf(f);
  if (Array.isArray(a)) return [...a].sort().join('\u0000') === [...(d || [])].sort().join('\u0000');
  return typeof a === 'string' ? a.trim() === String(d ?? '').trim() : a === d;
};

// A field's name, with "Private" after it for a private one (Faith).
function Label({ f }) {
  return <>{f.name}{f.sensitive && <span className="chip fd-private">Private</span>}</>;
}
const PrivateHint = ({ f }) => (f.sensitive ? <p className="muted fd-q__hint">Only what they tell you. Never guess.</p> : null);

function Taps({ id, label, options, value, onPick, disabled, hint = null }) {
  return (
    <div className="sv-q fd-q" role="group" aria-labelledby={id}>
      <p className="sv-q__text fd-q__label" id={id}>{label}</p>
      {hint}
      {/* Long choices (a school and its campus) get wider buttons, one or two lines each. */}
      <div className={`sv-q__opts${options.some((o) => String(o.label).length > 24) ? ' fd-opts--long' : ''}`}>
        {options.map((o) => (
          <button key={String(o.v)} type="button" className={`sv-opt${value === o.v ? ' is-on' : ''}`}
            aria-pressed={value === o.v} disabled={disabled} onClick={() => onPick(value === o.v ? null : o.v)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// Pick several: each choice taps on and off; the list keeps the choices' order.
function ManyTaps({ id, label, choices, value, onChange, disabled }) {
  const on = new Set(value || []);
  const all = [...choices, ...[...on].filter((v) => !choices.includes(v))]; // one since taken off still shows
  const flip = (c) => onChange(all.filter((x) => (x === c ? !on.has(c) : on.has(x))));
  return (
    <div className="sv-q fd-q" role="group" aria-labelledby={id}>
      <p className="sv-q__text fd-q__label" id={id}>{label}</p>
      <p className="muted fd-q__hint">Any that apply</p>
      <div className="sv-q__opts">
        {all.map((c) => (
          <button key={c} type="button" className={`sv-opt${on.has(c) ? ' is-on' : ''}`}
            aria-pressed={on.has(c)} disabled={disabled} onClick={() => flip(c)}>
            {c}
          </button>
        ))}
      </div>
    </div>
  );
}

// Pick one with groups (more than 12 choices, "Christian – Catholic"): a
// group is one button; tapping it opens its row underneath. Opening and
// closing a row never changes the value — tap the picked one again, or the
// row's Clear, to clear it.
function GroupTaps({ id, f, groups, value, onPick, disabled }) {
  const inGroup = (g) => g.members.some((m) => m.choice === value);
  const [open, setOpen] = useState(() => groups.find((g) => g.group && inGroup(g))?.group || null);
  const shown = groups.find((g) => g.group === open);
  const extra = value != null && !f.choices.includes(value) ? value : null; // taken off since: still shows, picked
  const rowId = `${id}-row`;
  return (
    <div className="sv-q fd-q" role="group" aria-labelledby={id}>
      <p className="sv-q__text fd-q__label" id={id}><Label f={f} /></p>
      <PrivateHint f={f} />
      <div className="sv-q__opts">
        {groups.map((g) => (g.group ? (
          <button key={`g:${g.group}`} type="button" className={`sv-opt fd-grp${inGroup(g) ? ' is-on' : ''}${open === g.group ? ' is-open' : ''}`}
            aria-expanded={open === g.group} aria-controls={open === g.group ? rowId : undefined} disabled={disabled}
            onClick={() => setOpen(open === g.group ? null : g.group)}>
            {g.group} <span aria-hidden="true">{open === g.group ? '▴' : '▾'}</span>
          </button>
        ) : (
          <button key={g.choice} type="button" className={`sv-opt${value === g.choice ? ' is-on' : ''}`}
            aria-pressed={value === g.choice} disabled={disabled} onClick={() => onPick(value === g.choice ? null : g.choice)}>
            {g.choice}
          </button>
        )))}
        {extra && (
          <button type="button" className="sv-opt is-on" aria-pressed disabled={disabled} onClick={() => onPick(null)}>{extra}</button>
        )}
      </div>
      {shown && (
        <div className="fd-sub" id={rowId} role="group" aria-labelledby={`${rowId}-l`}>
          <p className="fd-sub__label" id={`${rowId}-l`}>
            {shown.group} — pick one.{/^just\b/i.test(shown.members[0]?.short || '') ? ` Just ${shown.group}? Pick the first one.` : ''}
          </p>
          <div className="sv-q__opts">
            {shown.members.map((m) => (
              <button key={m.choice} type="button" className={`sv-opt${value === m.choice ? ' is-on' : ''}`}
                aria-pressed={value === m.choice} aria-label={m.choice} disabled={disabled}
                onClick={() => onPick(value === m.choice ? null : m.choice)}>
                {m.short}
              </button>
            ))}
          </div>
          {inGroup(shown) && (
            <button type="button" className="btn btn-quiet fd-clear" disabled={disabled} onClick={() => onPick(null)}>Clear</button>
          )}
        </div>
      )}
    </div>
  );
}

// Pick one shown as a scroll-down list (Dwelling type): the phone's own picker.
function ChoiceSelect({ id, f, value, onPick, disabled }) {
  const extra = value != null && !f.choices.includes(value) ? value : null;
  return (
    <div className="sv-q fd-q">
      <label className="sv-q__text fd-q__label" htmlFor={id}><Label f={f} /></label>
      <PrivateHint f={f} />
      <select id={id} className="input fd-select" disabled={disabled} value={value ?? ''}
        onChange={(e) => onPick(e.target.value || null)}>
        <option value="">Pick one…</option>
        {groupsOf(f.choices).map((g) => (g.group ? (
          <optgroup key={`g:${g.group}`} label={g.group}>
            {g.members.map((m) => <option key={m.choice} value={m.choice}>{m.short}</option>)}
          </optgroup>
        ) : <option key={g.choice} value={g.choice}>{g.choice}</option>))}
        {extra && <option value={extra}>{extra}</option>}
      </select>
    </div>
  );
}

// The words a list couldn't take ("Dwelling type as written"): read-only,
// drawn only while there are some; Clear empties it at the next Save.
function AsWritten({ id, f, value, stored, onChange, disabled }) {
  if (stored == null || stored === '') return null;
  const cleared = value == null || value === '';
  return (
    <div className="sv-q fd-q fd-written" role="group" aria-labelledby={id}>
      <p className="sv-q__text fd-q__label" id={id}><Label f={f} /></p>
      <p className={`fd-written__v${cleared ? ' is-cleared' : ''}`}>{String(stored)}</p>
      <p className="muted fd-q__hint">{cleared ? 'Cleared — Save to keep it that way.' : 'From before the list — pick the type above, then clear this'}</p>
      {!cleared && <button type="button" className="btn btn-quiet fd-clear" disabled={disabled} onClick={() => onChange(null)}>Clear</button>}
    </div>
  );
}

function FieldControl({ f, value, onChange, disabled, stored, listable }) {
  const id = useId();
  if (f.kept_out) {
    // A Private field from the kept copy: its value never left the server.
    return (
      <div className="sv-q fd-q">
        <p className="sv-q__text fd-q__label"><Label f={f} /></p>
        <p className="muted">Needs signal</p>
      </div>
    );
  }
  if (f.as_written_of) return <AsWritten id={id} f={f} value={value} stored={stored} onChange={onChange} disabled={disabled} />;
  if (f.kind === 'choices') {
    return <ManyTaps id={id} label={<Label f={f} />} choices={f.choices} value={value} onChange={onChange} disabled={disabled} />;
  }
  if (f.kind === 'note') {
    return (
      <div className="sv-q fd-q">
        <label className="sv-q__text fd-q__label" htmlFor={id}><Label f={f} /></label>
        <PrivateHint f={f} />
        <textarea id={id} className="input sv-q__input fd-note" rows={4} maxLength={NOTE_MAX} disabled={disabled}
          value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
      </div>
    );
  }
  if (f.kind === 'yesno') {
    return <Taps id={id} label={<Label f={f} />} hint={<PrivateHint f={f} />} value={value} onPick={onChange} disabled={disabled}
      options={[{ v: true, label: 'Yes' }, { v: false, label: 'No' }]} />;
  }
  if (f.kind === 'choice') {
    if (f.display === 'list') return <ChoiceSelect id={id} f={f} value={value} onPick={onChange} disabled={disabled} />;
    const groups = groupsOf(f.choices);
    if (groups.some((g) => g.group)) return <GroupTaps id={id} f={f} groups={groups} value={value} onPick={onChange} disabled={disabled} />;
    // A value whose choice was since taken off still shows, picked.
    const choices = f.choices.includes(value) || value == null ? f.choices : [...f.choices, value];
    return <Taps id={id} label={<Label f={f} />} hint={<PrivateHint f={f} />} value={value} onPick={onChange} disabled={disabled}
      options={choices.map((c) => ({ v: c, label: c }))} />;
  }
  const kind = {
    text: { type: 'text', maxLength: TEXT_MAX },
    number: { type: 'text', inputMode: 'decimal' },
    date: { type: 'date' },
  }[f.kind] || { type: 'text' };
  return (
    <div className="sv-q fd-q">
      <label className="sv-q__text fd-q__label" htmlFor={id}><Label f={f} /></label>
      <PrivateHint f={f} />
      <input id={id} className="input sv-q__input" autoComplete="off" disabled={disabled} {...kind}
        value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
      {listable && (
        <p className="muted fd-q__hint fd-listable">This can be a pick list — <Link to={`/people/fields?list=${f.id}`}>Turn it into a list</Link></p>
      )}
    </div>
  );
}

// saved / setSaved live in PersonFields: the form starts fresh from the
// server's values after a save, and "✓ Saved" must outlast that.
// With no signal (online false) it is read-only: what's kept (or typed and
// not saved yet) stays on screen, every control off, and one line says so.
function PersonFieldsForm({ fields, personId, saved, setSaved, online, listable, faithLine }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => Object.fromEntries(fields.map((f) => [f.id, draftOf(f)])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const changed = fields.filter((f) => !f.kept_out && !sameDraft(f, draft[f.id]));
  const set = (fid, v) => { setSaved(false); setError(null); setDraft((d) => ({ ...d, [fid]: v })); };
  const off = busy || !online;

  const save = async (e) => {
    e.preventDefault();
    if (!changed.length || !online) return;
    setBusy(true);
    setError(null);
    try {
      const res = await action('field.values.set', {
        person_id: personId,
        values: changed.map((f) => {
          const v = draft[f.id];
          return { field_id: f.id, value: typeof v === 'string' ? (v.trim() || null) : Array.isArray(v) ? (v.length ? v : null) : v };
        }),
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['person', personId, 'fields'] }),
        queryClient.invalidateQueries({ queryKey: ['fields'] }),
        queryClient.invalidateQueries({ queryKey: ['persons'] }),
      ]);
      // Each value as the server stored it ("1,200" is 1200): a save that
      // changed nothing on file still reads as saved, not as waiting.
      const stored = new Map((res?.values || []).map((v) => [v.field_id, v.value]));
      setDraft((d) => {
        const next = { ...d };
        for (const f of fields) if (stored.has(f.id)) next[f.id] = draftOf({ ...f, value: stored.get(f.id) });
        return next;
      });
      setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="fd-form" onSubmit={save} aria-label="More details">
      {!online && <NeedsSignalLine>Changing these needs signal</NeedsSignalLine>}
      {faithLine && <p className="muted fd-tagline">{faithLine}</p>}
      {fields.map((f) => (
        <FieldControl key={f.id} f={f} value={draft[f.id]} stored={f.value} disabled={off} onChange={(v) => set(f.id, v)}
          listable={listable?.has(f.id)} />
      ))}
      <div className="fd-foot">
        <button type="submit" className="btn fd-save" disabled={off || !changed.length}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <span className="fd-said" role="status">{saved && !changed.length ? '✓ Saved' : ''}</span>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}

// The Dwelling type or Campus still typed as Text, whose words suit a list:
// a manager's profile says it can be one (GET /fields; never read otherwise).
const LISTABLE = new Set(['dwelling type', 'campus']);
export function PersonFields({ query, personId, manager = false, tags = [] }) {
  const [saved, setSaved] = useState(false);
  const online = useOnline();
  const list = useFieldsList(manager);
  const listable = useMemo(() => new Set((list.data?.fields || [])
    .filter((f) => !f.retired && f.kind === 'text' && !f.as_written_of && !f.converting && f.suits && LISTABLE.has(f.name.trim().toLowerCase()))
    .map((f) => f.id)), [list.data]);
  // No signal and nothing kept: say so, never a "Loading…" that doesn't end.
  if (noSignal(query)) return <NoSignal />;
  if (query.isPending) return <p className="muted">Loading…</p>;
  if (query.isError) return <p className="error">{query.error.message}</p>;
  const { fields = [], edit } = query.data || {};
  if (!edit) {
    return (
      <ul className="contact-lines fd-read">
        {fields.map((f) => (
          <li key={f.id}>
            <span className="k">{f.name}</span>
            <span className={`v${f.kind === 'note' ? ' fd-note-read' : ''}`}>{fieldWords(f.kind, f.value)}</span>
          </li>
        ))}
      </ul>
    );
  }
  // A fresh form whenever the saved values change (after Save, or another desk's).
  const version = fields.map((f) => `${f.id}=${JSON.stringify(f.value)}`).join('|');
  // Tagged "faith" before Faith was a field: a nudge to pick it, never a guess.
  const faith = fields.find((f) => f.kind === 'choice' && f.name.trim().toLowerCase() === 'faith' && !f.kept_out);
  const faithLine = faith && (faith.value == null) && tags.some((t) => String(t).toLowerCase() === 'faith')
    ? `Tagged “faith”. If they told you their faith, pick it under ${faith.name}.` : null;
  return <PersonFieldsForm key={version} fields={fields} personId={personId} saved={saved} setSaved={setSaved} online={online}
    listable={listable} faithLine={faithLine} />;
}

// ── People: filter by one field's value ──
const filterOptions = (f) => {
  if (f.kind === 'yesno') return [['yes', 'Yes'], ['no', 'No']];
  if (hasChoices(f.kind)) return f.choices.map((c) => [c, c]);
  if (f.kind === 'note') return [['*', 'Filled in']];
  const common = (f.common || []).map((c) => [String(c.value), fieldWords(f.kind, c.value)]);
  if (f.kind === 'date') return [['*', 'Filled in']];
  return f.kind === 'text' ? [...common, ['*', 'Filled in']] : common.length ? common : [['*', 'Filled in']];
};

// A grouped Pick one (Faith): the top-level chips, "Christian (any)" for a
// whole group (?field=<id>:Christian – *), and the group's own chips under
// a quiet More.
const ANY = ' – *';
function GroupedFilter({ f, chip }) {
  const [more, setMore] = useState(null);
  const groups = groupsOf(f.choices);
  return (
    <fieldset className="pp-group">
      <legend className="eyebrow">{f.name}</legend>
      <div className="pp-group__opts">
        {groups.map((g) => (g.group ? chip('field', `${f.id}:${g.group}${ANY}`, `${g.group} (any)`) : chip('field', `${f.id}:${g.choice}`, g.choice)))}
      </div>
      {groups.filter((g) => g.group).map((g) => (
        <div key={g.group} className="fd-fmore">
          <button type="button" className="btn btn-quiet fd-fmore__btn" aria-expanded={more === g.group}
            onClick={() => setMore(more === g.group ? null : g.group)}>
            More: {g.group} {more === g.group ? '▴' : '▾'}
          </button>
          {more === g.group && (
            <div className="pp-group__opts">{g.members.map((m) => chip('field', `${f.id}:${m.choice}`, m.short))}</div>
          )}
        </div>
      ))}
    </fieldset>
  );
}

export function FieldFilterGroups({ chip }) {
  const list = useFieldsList();
  const fields = (list.data?.fields || []).filter((f) => !f.retired);
  if (!fields.length) return null;
  return fields.map((f) => (f.kind === 'choice' && groupsOf(f.choices).some((g) => g.group)
    ? <GroupedFilter key={f.id} f={f} chip={chip} />
    : (
      <fieldset key={f.id} className="pp-group">
        <legend className="eyebrow">{f.name}</legend>
        <div className="pp-group__opts">
          {filterOptions(f).map(([v, label]) => chip('field', `${f.id}:${v}`, label))}
        </div>
      </fieldset>
    )));
}

// "Language at home: Punjabi" — or "Profile field: Yes" when the field's
// name can't be read here (no signal, or one volunteers can't see).
const filterId = (value) => {
  const s = String(value || '');
  const at = s.indexOf(':');
  return at < 0 ? s : s.slice(0, at);
};
export const fieldFilterLabel = (value, fields) => {
  const s = String(value || '');
  const at = s.indexOf(':');
  const id = filterId(s);
  const v = at < 0 ? '*' : s.slice(at + 1);
  const f = (fields || []).find((x) => x.id === id);
  if (v === '*') return f ? `${f.name}: Filled in` : 'Profile field: Filled in';
  if (!f) return `Profile field: ${/^(yes|true)$/i.test(v) ? 'Yes' : /^(no|false)$/i.test(v) ? 'No' : v}`;
  if (v.endsWith(ANY)) return `${f.name}: ${v.slice(0, -ANY.length)} (any)`;
  const word = f.kind === 'yesno' ? (/^y/i.test(v) ? 'Yes' : 'No') : fieldWords(f.kind, f.kind === 'number' ? Number(v) : v);
  return `${f.name}: ${word}`;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function FieldFilterChip({ value, onRemove, desk = true }) {
  const list = useFieldsList(desk);
  // A volunteer can't read the desk's list: just this one field's name.
  const id = filterId(value);
  const one = useQuery({
    queryKey: ['fields', 'one', id],
    queryFn: () => apiGet(`/fields/${id}`),
    enabled: !desk && UUID_RE.test(id),
    retry: false,
    staleTime: 60_000,
  });
  const label = fieldFilterLabel(value, desk ? list.data?.fields : one.data?.field ? [one.data.field] : []);
  return (
    <button type="button" className="pp-fchip" aria-label={`Remove filter: ${label}`} onClick={onRemove}>
      {label}
      <svg className="pp-icon" viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="M6 6l12 12M18 6 6 18" />
      </svg>
    </button>
  );
}

// ── Import: the campaign's fields as columns to match ──
export const FIELD_KEY = 'field:';
export function useImportFields() {
  const list = useFieldsList();
  return useMemo(
    () => (list.data?.fields || []).filter((f) => !f.retired).map((f) => ({ key: `${FIELD_KEY}${f.id}`, label: f.name, kind: f.kind, f })),
    [list.data],
  );
}
// One CSV cell for a field column → the row the server reads ({ fields: { id: cell } }).
export const fieldCell = (row, key, v) => {
  row.fields = { ...(row.fields || {}), [key.slice(FIELD_KEY.length)]: v };
};
