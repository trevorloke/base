// The field cuts (server/ext/cuts) on People's filter, a saved list's form
// and Calls: when the door was last knocked, the latest outcome, a turf, a
// postal code, and the tags someone doesn't have.
//   CUT_KEYS                 the URL / filter keys
//   cutChips(f, turfs)       [{ key, label }] — the active cuts, in words
//   addCuts(qs, f)           copies the cuts onto a URLSearchParams
//   <CutGroups chip f update turfs />   People's sheet: chip rows
//   <CutFields value onChange turfs />  a saved list's form: selects
//   useTurfs()               the campaign's turfs (the map's own query)
import { useQuery } from '@tanstack/react-query';
import { OUTCOMES } from '@starbase/shared/canvass';
import { apiGet } from '../api.js';
import { OUTCOME_LABEL } from './RatingButtons.jsx';

export const CUT_KEYS = ['knocked', 'outcome', 'turf', 'postal', 'notag'];

export const KNOCKED = [
  ['never', 'Never knocked'],
  ['7', 'Not knocked in 7 days'],
  ['14', 'Not knocked in 14 days'],
  ['30', 'Not knocked in 30 days'],
];
// The latest contact's outcome, in the words the screens use.
const OUTCOME_WORD = { ...OUTCOME_LABEL, contacted: 'Talked' };
export const LAST_OUTCOMES = OUTCOMES.map((o) => [o, OUTCOME_WORD[o] || o]);

export const useTurfs = () => {
  const q = useQuery({ queryKey: ['turfs'], queryFn: () => apiGet('/turfs'), staleTime: 60_000, meta: { side: true } });
  return q.data?.turfs ?? [];
};

export const cutChips = (f, turfs = []) => [
  f.knocked && { key: 'knocked', label: KNOCKED.find(([k]) => k === f.knocked)?.[1] || f.knocked },
  f.outcome && { key: 'outcome', label: `Last: ${LAST_OUTCOMES.find(([k]) => k === f.outcome)?.[1] || f.outcome}` },
  f.turf && { key: 'turf', label: `Turf: ${turfs.find((t) => t.id === f.turf)?.name || '…'}` },
  f.postal && { key: 'postal', label: `Postal ${String(f.postal).toUpperCase()}…` },
  f.notag && { key: 'notag', label: `Not tagged ${f.notag}` },
].filter(Boolean);

export const addCuts = (qs, f) => {
  for (const k of CUT_KEYS) if (f[k]) qs.set(k, f[k]);
  return qs;
};

export function CutGroups({ chip, f, update, turfs }) {
  return (
    <>
      <fieldset className="pp-group">
        <legend className="eyebrow">Last knocked</legend>
        <div className="pp-group__opts">{KNOCKED.map(([k, l]) => chip('knocked', k, l))}</div>
      </fieldset>
      <fieldset className="pp-group">
        <legend className="eyebrow">Last outcome</legend>
        <div className="pp-group__opts">{LAST_OUTCOMES.map(([k, l]) => chip('outcome', k, l))}</div>
      </fieldset>
      {turfs.length > 0 && (
        <fieldset className="pp-group">
          <legend className="eyebrow">Turf</legend>
          <div className="pp-group__opts">{turfs.map((t) => chip('turf', t.id, t.name))}</div>
        </fieldset>
      )}
      <div className="field pp-postal">
        <label htmlFor="pp-postal">Postal code starts with</label>
        <input id="pp-postal" className="input mono" maxLength={7} placeholder="V3W" autoComplete="off"
          value={f.postal || ''} onChange={(e) => update({ postal: e.target.value.trim() || null })} />
      </div>
    </>
  );
}

export function CutFields({ value, onChange, turfs }) {
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value || '' });
  return (
    <div className="form-row">
      <div className="field">
        <label htmlFor="ls-knocked">Last knocked</label>
        <select id="ls-knocked" className="input" value={value.knocked || ''} onChange={set('knocked')}>
          <option value="">Any time</option>
          {KNOCKED.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="ls-outcome">Last outcome</label>
        <select id="ls-outcome" className="input" value={value.outcome || ''} onChange={set('outcome')}>
          <option value="">Any</option>
          {LAST_OUTCOMES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="ls-turf">Turf</label>
        <select id="ls-turf" className="input" value={value.turf || ''} onChange={set('turf')}>
          <option value="">Anywhere</option>
          {turfs.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="ls-postal">Postal code starts with</label>
        <input id="ls-postal" className="input mono" maxLength={7} placeholder="V3W" value={value.postal || ''} onChange={set('postal')} />
      </div>
      <div className="field">
        <label htmlFor="ls-notag">Without the tag <span className="muted">(or several, with commas)</span></label>
        <input id="ls-notag" className="input" value={value.notag || ''} onChange={set('notag')} placeholder="do-not-contact" />
      </div>
    </div>
  );
}
