// Website → Voter guide (/website/guide; VG decisions 23–25): the one
// place the campaign enters the voting information the day the elections
// office releases it — days, places (typed or pasted), the ballot, what to
// bring — ticks each part "I checked this against the official notice",
// and a manager publishes it. The public sees it on the website (and the
// embed), canvassers under "Where to vote". The product says nothing about
// voting of its own: every fact here is typed by a person.
// Read by GET /api/site/guide (the Website area); every write is a
// site.guide.* action. Publish, Unpublish, Clear and the embed addresses
// are a manager's; staff with the Website area do the rest.
import { Suspense, lazy, useMemo, useRef, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { dayWords, normWords } from '@starbase/shared/voteguide';
import { action, apiGet, apiPost } from '../api.js';
import { NeedsSignal, NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import { Toast, WebsiteTabs, useToast } from '../components/site/Bits.jsx';
import { GUIDE_STATE, useSiteGuide } from '../components/site/useSiteGuide.js';
import { DEFAULT_TILES } from '../components/tiles.js';
import './shifts.css';
import '../editor.css';
import './website.css';
import './vote-guide.css';

const PlaceMap = lazy(() => import('./SchedulePlaceMap.jsx').catch(() => ({ default: () => <p className="wg-err" role="alert">The map didn’t load</p> })));
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (n) => (Number(n) || 0).toLocaleString('en-CA');
const HINT = 'Copy this from the elections office’s page';
const RULES = [
  ['bring_listed', 'What to bring — if you’re on the voters list'],
  ['bring_unlisted', 'What to bring — if you’re not on the list yet'],
  ['who', 'Who can vote'],
  ['mail', 'Voting by mail'],
  ['access', 'Getting there'],
];
// Where each checklist line is fixed.
const FIX = {
  days: '#wg-days', general: '#wg-days', future: '#wg-days', places: '#wg-places', anywhere: '#wg-places',
  official: '#wg-official', checkDays: '#wg-days', checkPlaces: '#wg-places', checkBallot: '#wg-ballot', checkRules: '#wg-rules',
};
const tri = (v) => (v === true ? 'yes' : v === false ? 'no' : '');
const fromTri = (v) => (v === 'yes' ? true : v === 'no' ? false : null);

function useRun() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const run = async (name, input) => {
    setBusy(true);
    try {
      const r = await action(name, input);
      await Promise.all([['site-guide'], ['guide'], ['site']].map((queryKey) => qc.invalidateQueries({ queryKey })));
      return r;
    } finally {
      setBusy(false);
    }
  };
  return { run, busy };
}

// "Checked by Ana · Oct 3" · the tick box · "Changed since checked".
function CheckFoot({ section, d, run, busy, label = 'I checked this against the official notice', online }) {
  const c = d.guide.checked?.[section];
  const [err, setErr] = useState(null);
  const flip = async (checked) => {
    setErr(null);
    try { await run('site.guide.check', { section, checked }); } catch (e) { setErr(e.message); }
  };
  return (
    <div className="wg-foot">
      <label className="wg-check">
        <input type="checkbox" checked={Boolean(c)} disabled={busy || !online} onChange={(e) => flip(e.target.checked)} />
        <span>{label}</span>
      </label>
      {c && <span className="wg-line">Checked by {c.by_name || 'someone'} · {dayWords(c.on)}</span>}
      {c && d.changed_since_checked?.[section] && <span className="chip chip-warn">Changed since checked</span>}
      {err && <p className="wg-err" role="alert">{err}</p>}
    </div>
  );
}

// ── Voting days ──
function DaysCard({ d, run, busy, online, adding, onAdded }) {
  const saved = arr(d.guide.days).map(({ day, kind, opens, closes }) => ({ day, kind, opens, closes }));
  const [draft, setDraft] = useState(null);
  const [err, setErr] = useState(null);
  const [said, setSaid] = useState('');
  const rows = draft ?? (adding && !saved.length ? [{ day: '', kind: 'advance', opens: '08:00', closes: '20:00' }] : saved);
  const set = (i, patch) => setDraft(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const save = async () => {
    setErr(null);
    try {
      await run('site.guide.days', { days: rows.filter((r) => r.day) });
      setDraft(null); onAdded?.(); setSaid('Saved');
    } catch (e) { setErr(e.message); }
  };
  return (
    <section className="card wg-card" id="wg-days" aria-labelledby="wg-days-h">
      <h2 id="wg-days-h">Voting days</h2>
      {rows.length === 0 && <p className="wg-line">No days yet.</p>}
      <div className="wg-days">
        {rows.map((r, i) => (
          <div className="wg-day" key={i}>
            <div><label htmlFor={`wg-d-${i}`}>Day</label><input id={`wg-d-${i}`} type="date" className="input" value={r.day} onChange={(e) => set(i, { day: e.target.value })} /></div>
            <div>
              <label htmlFor={`wg-k-${i}`}>Kind</label>
              <select id={`wg-k-${i}`} className="input" value={r.kind} onChange={(e) => set(i, { kind: e.target.value })}>
                <option value="advance">Advance</option><option value="general">Election day</option>
              </select>
            </div>
            <div><label htmlFor={`wg-o-${i}`}>Opens</label><input id={`wg-o-${i}`} type="time" className="input" value={r.opens} onChange={(e) => set(i, { opens: e.target.value })} /></div>
            <div><label htmlFor={`wg-c-${i}`}>Closes</label><input id={`wg-c-${i}`} type="time" className="input" value={r.closes} onChange={(e) => set(i, { closes: e.target.value })} /></div>
            <button type="button" className="btn btn-quiet" aria-label={`Remove ${r.day ? dayWords(r.day) : 'this day'}`} onClick={() => setDraft(rows.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
      </div>
      <div className="wg-row">
        <button type="button" className="btn" onClick={() => setDraft([...rows, { day: '', kind: rows.length ? 'general' : 'advance', opens: rows.at(-1)?.opens || '08:00', closes: rows.at(-1)?.closes || '20:00' }])}>Add a day</button>
        <button type="button" className="btn" disabled={busy || !online || draft === null} onClick={save}>Save</button>
        {!online && <NeedsSignal />}
        <span className="wg-line wg-ok" role="status">{draft === null ? said : ''}</span>
      </div>
      {err && <p className="wg-err" role="alert">{err}</p>}
      <CheckFoot section="days" d={d} run={run} busy={busy} online={online} />
    </section>
  );
}

// "Advance · Election day" when a place is open every day; else its dates.
const placeDaysWords = (p, days) => {
  const mine = new Set(arr(p.own_days).map((e) => e.day));
  if (!mine.size) return 'No days';
  if (days.length && days.every((x) => mine.has(x.day))) return 'Every day';
  return [...mine].sort().map((x) => dayWords(x).replace(/^\w+, /, '')).join(', ');
};

// ── One place, opened in place ──
function PlaceEditor({ p, d, run, busy, online, onClose, toast }) {
  const days = arr(d.guide.days);
  const [f, setF] = useState(() => ({
    name: p?.name || '', address: p?.address || '', city: p?.city || '', area: p?.area || '', note: p?.note || '',
    accessible: tri(p?.accessible), curbside: tri(p?.curbside), closed: Boolean(p?.closed), closed_note: p?.closed_note || '',
    days: p ? arr(p.own_days) : days.map((x) => ({ day: x.day })),
    pin: p && p.lat != null ? { lat: p.lat, lng: p.lng } : null, pinMoved: false,
  }));
  const [err, setErr] = useState(null);
  const [asking, setAsking] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const tilesQ = useQuery({ queryKey: ['mapConfig'], queryFn: () => apiGet('/map/config'), staleTime: 10 * 60_000, retry: 1, enabled: mapOpen });
  const tiles = tilesQ.data?.tiles || (tilesQ.isError ? DEFAULT_TILES : null);
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const ticked = new Set(f.days.map((x) => x.day));
  const tick = (day, on) => set({ days: on ? [...f.days, { day }].sort((a, b) => a.day.localeCompare(b.day)) : f.days.filter((x) => x.day !== day) });
  const save = async () => {
    setErr(null);
    const input = {
      ...(p ? { id: p.id } : {}), name: f.name, address: f.address, city: f.city, area: f.area, note: f.note, days: f.days,
      accessible: fromTri(f.accessible), curbside: fromTri(f.curbside), closed: f.closed, closed_note: f.closed_note,
      ...(f.pinMoved && f.pin ? { lat: f.pin.lat, lng: f.pin.lng } : {}),
    };
    try { await run('site.guide.place.save', input); toast(p ? 'Saved' : 'Place added'); onClose(); } catch (e) { setErr(e.message); }
  };
  const remove = async () => {
    setErr(null);
    try {
      const r = await run('site.guide.place.delete', { id: p.id });
      onClose();
      toast(r?.kept ? 'Kept in Shifts and GOTV — it is used there' : 'Place removed', { undo: () => run('site.guide.place.restore', { id: p.id }).catch(() => {}) });
    } catch (e) { setErr(e.message); }
  };
  const around = useMemo(() => arr(d.guide.places).filter((x) => x.lat != null).map((x) => [x.lat, x.lng]).slice(0, 50), [d.guide.places]);
  return (
    <div className="wg-place" role="group" aria-label={p ? `Edit ${p.name}` : 'New voting place'}>
      <div className="wg-grid">
        <div className="wg-fld"><label htmlFor="wg-pn">Name</label><input id="wg-pn" className="input" value={f.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} /></div>
        <div className="wg-fld"><label htmlFor="wg-pa">Address</label><input id="wg-pa" className="input" value={f.address} maxLength={200} onChange={(e) => set({ address: e.target.value })} /></div>
        <div className="wg-fld"><label htmlFor="wg-pc">City</label><input id="wg-pc" className="input" value={f.city} maxLength={80} onChange={(e) => set({ city: e.target.value })} /></div>
        <div className="wg-fld"><label htmlFor="wg-par">Area</label><input id="wg-par" className="input" value={f.area} maxLength={60} onChange={(e) => set({ area: e.target.value })} /></div>
        <div className="wg-fld">
          <label htmlFor="wg-pacc">Accessible</label>
          <select id="wg-pacc" className="input" value={f.accessible} onChange={(e) => set({ accessible: e.target.value })}><option value="">Not said</option><option value="yes">Yes</option><option value="no">No</option></select>
        </div>
        <div className="wg-fld">
          <label htmlFor="wg-pcurb">Curbside</label>
          <select id="wg-pcurb" className="input" value={f.curbside} onChange={(e) => set({ curbside: e.target.value })}><option value="">Not said</option><option value="yes">Yes</option><option value="no">No</option></select>
        </div>
      </div>
      <fieldset className="wg-radios">
        <legend>Open on</legend>
        <div className="wg-dayticks">
          {days.map((x) => (
            <label key={x.day} className="wg-check"><input type="checkbox" checked={ticked.has(x.day)} onChange={(e) => tick(x.day, e.target.checked)} /><span>{dayWords(x.day)}</span></label>
          ))}
          {!days.length && <span className="wg-line">Add the voting days first.</span>}
          {f.days.filter((x) => !days.some((y) => y.day === x.day)).map((x) => <span key={x.day} className="chip chip-warn">Open on a day that isn’t listed: {dayWords(x.day)}</span>)}
        </div>
      </fieldset>
      <div className="wg-fld"><label htmlFor="wg-pnote">Note</label><input id="wg-pnote" className="input" value={f.note} maxLength={200} onChange={(e) => set({ note: e.target.value })} /></div>
      {p && (
        <div className="wg-row">
          <button type="button" role="switch" aria-checked={f.closed} className="sv-switch" onClick={() => set({ closed: !f.closed })}>
            <span className="sv-switch__track" aria-hidden="true"><span className="sv-switch__dot" /></span>
            <span className="sv-switch__label">Closed today</span>
          </button>
          {f.closed && <input className="input" aria-label="Why it’s closed" placeholder="Why it’s closed (shown to voters)" value={f.closed_note} maxLength={200} onChange={(e) => set({ closed_note: e.target.value })} />}
        </div>
      )}
      <div className="wg-row">
        <span className="wg-line">{f.pin ? `On the map${f.pinMoved ? ' — new pin, not saved' : ''}` : 'Not on the map — left out of “nearest” and the near-a-voting-place check'}</span>
        <button type="button" className="btn btn-quiet" aria-expanded={mapOpen} onClick={() => setMapOpen((o) => !o)}>Put the pin here</button>
      </div>
      {mapOpen && (
        <Suspense fallback={<p className="wg-line">Loading…</p>}>
          {tiles ? <PlaceMap tiles={tiles} around={f.pin ? [[f.pin.lat, f.pin.lng]] : around} point={f.pin} onPoint={(pt) => set({ pin: pt, pinMoved: true })} /> : <p className="wg-line">Loading…</p>}
        </Suspense>
      )}
      {err && <p className="wg-err" role="alert">{err}</p>}
      <div className="wg-row">
        <button type="button" className="btn" disabled={busy || !online || !f.name.trim() || !f.address.trim()} onClick={save}>{p ? 'Save' : 'Add this place'}</button>
        <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
        {p && !asking && <button type="button" className="btn btn-quiet" onClick={() => setAsking(true)}>Delete</button>}
        {p && asking && (
          <span className="wg-confirm"><p>Remove this place?</p>
            <button type="button" className="btn" disabled={busy || !online} onClick={remove}>Yes</button>
            <button type="button" className="btn btn-quiet" onClick={() => setAsking(false)}>No</button>
          </span>
        )}
      </div>
    </div>
  );
}

// ── Import places: paste or a file, preview, save ──
function ImportSheet({ d, run, busy, online, onClose, toast, live }) {
  const [text, setText] = useState('');
  const [prev, setPrev] = useState(null);
  const [err, setErr] = useState(null);
  const [looking, setLooking] = useState(false);
  const [asking, setAsking] = useState(false);
  const fileRef = useRef(null);
  const preview = async () => {
    setErr(null); setLooking(true);
    try { setPrev(await apiPost('/site/guide/import/preview', { text })); } catch (e) { setErr(e.message); } finally { setLooking(false); }
  };
  const save = async (replace) => {
    setErr(null);
    try {
      const r = await run('site.guide.places.import', { rows: prev.rows, token: prev.token, replace });
      toast(`${num(r.added)} added · ${num(r.updated)} changed${replace ? ` · ${num(r.removed)} removed` : ''}`);
      onClose();
    } catch (e) { setErr(e.message); }
  };
  const c = prev?.counts;
  const keeps = prev ? prev.rows.filter((r) => r.status !== 'Problem').length : 0;
  return (
    <section className="card wg-card" aria-labelledby="wg-imp-h">
      <h2 id="wg-imp-h">Import places</h2>
      <p className="wg-line">Paste the list from the elections office, or a spreadsheet. One place per line.</p>
      <label className="wg-sr" htmlFor="wg-imp">The list</label>
      <textarea id="wg-imp" className="input wg-big" value={text} onChange={(e) => { setText(e.target.value); setPrev(null); }} placeholder={'Name, Address, Days\nExample Community Hall, 100 Example Ave, All'} />
      <div className="wg-row">
        <input ref={fileRef} type="file" accept=".csv,.txt,text/csv,text/plain" hidden onChange={async (e) => { const file = e.target.files?.[0]; if (file) { setText(await file.text()); setPrev(null); } e.target.value = ''; }} />
        <button type="button" className="btn" onClick={() => fileRef.current?.click()}>Choose a file</button>
        <button type="button" className="btn" disabled={!text.trim() || looking || !online} onClick={preview}>{looking ? 'Looking up addresses…' : 'Preview'}</button>
        <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
      </div>
      {d.lookup === 'off' && <p className="wg-line">Address lookup is off — pins can be added by hand later</p>}
      {err && <p className="wg-err" role="alert">{err}</p>}
      {prev && (
        <>
          <ul className="wg-counts" aria-label="This list">
            <li className="chip">New {num(c.new)}</li><li className="chip">Changed {num(c.changed)}</li><li className="chip">Same {num(c.same)}</li>
            <li className="chip">Not on the map {num(c.not_on_map)}</li><li className="chip">Problem {num(c.problem)}</li><li className="chip">Not in this list {num(c.not_in_list)}</li>
          </ul>
          <table className="wg-preview">
            <thead><tr><th>Status</th><th>Name</th><th>Address</th><th>Days</th><th>Why</th></tr></thead>
            <tbody>
              {prev.rows.map((r, i) => (
                <tr key={i} data-status={r.status}>
                  <td>{r.status}{r.status !== 'Problem' && !r.on_map ? ' · Not on the map' : ''}</td>
                  <td>{r.name}</td><td>{r.address}</td>
                  <td>{arr(r.days).map((x) => dayWords(x).replace(/^\w+, /, '')).join(', ')}</td>
                  <td>{[r.reason, r.changes?.length ? `Changed: ${r.changes.join(', ')}` : ''].filter(Boolean).join(' · ')}</td>
                </tr>
              ))}
              {arr(prev.not_in_list).map((p) => <tr key={p.id} data-status="gone"><td>Not in this list</td><td>{p.name}</td><td>{p.address}</td><td /><td /></tr>)}
            </tbody>
          </table>
          <div className="wg-row">
            <button type="button" className="btn" disabled={busy || !online || !keeps} onClick={() => save(false)}>{live ? 'Save — goes live now' : 'Save these places'}</button>
            {prev.places > 0 && !asking && <button type="button" className="btn btn-quiet" disabled={!keeps} onClick={() => setAsking(true)}>Replace the whole list</button>}
          </div>
          {asking && (
            <div className="wg-confirm">
              <p>Replace all {num(prev.places)} places with these {num(keeps)}?</p>
              <button type="button" className="btn" disabled={busy || !online} onClick={() => save(true)}>Yes</button>
              <button type="button" className="btn btn-quiet" onClick={() => setAsking(false)}>No</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ── Voting places ──
function PlacesCard({ d, run, busy, online, toast, live }) {
  const places = arr(d.guide.places);
  const days = arr(d.guide.days);
  const [open, setOpen] = useState(null); // a place id, or 'new'
  const [importing, setImporting] = useState(false);
  const [q, setQ] = useState('');
  const [err, setErr] = useState(null);
  const words = normWords(q);
  const shown = words ? places.filter((p) => normWords(`${p.name} ${p.address} ${p.area}`).includes(words)) : places;
  const anywhere = async (v) => { setErr(null); try { await run('site.guide.save', { vote_anywhere: v }); } catch (e) { setErr(e.message); } };
  const addBack = async () => {
    setErr(null);
    try { for (const p of arr(d.gotv_only_places)) await run('site.guide.place.restore', { id: p.id }); toast('Added to the guide'); } catch (e) { setErr(e.message); }
  };
  const editor = (p) => <PlaceEditor key={p?.id || 'new'} p={p} d={d} run={run} busy={busy} online={online} toast={toast} onClose={() => setOpen(null)} />;
  return (
    <section className="card wg-card" id="wg-places" aria-labelledby="wg-places-h">
      <h2 id="wg-places-h">Voting places · {num(places.length)}</h2>
      <fieldset className="wg-radios">
        <legend>Can voters vote at any voting place?</legend>
        <label className="wg-radio"><input type="radio" name="wg-any" checked={d.guide.vote_anywhere === true} disabled={busy || !online} onChange={() => anywhere(true)} /><span>Yes, at any voting place</span></label>
        <label className="wg-radio"><input type="radio" name="wg-any" checked={d.guide.vote_anywhere === false} disabled={busy || !online} onChange={() => anywhere(false)} /><span>No, at an assigned place</span></label>
      </fieldset>
      {d.gotv_only > 0 && (
        <p className="wg-line">In GOTV, not in the guide: {num(d.gotv_only)} · <button type="button" className="btn-link" disabled={busy || !online} onClick={addBack}>Add</button></p>
      )}
      <div className="wg-row">
        <label className="wg-sr" htmlFor="wg-psearch">Search places</label>
        <input id="wg-psearch" className="input" type="search" placeholder="Search places" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn btn-quiet" onClick={() => { setImporting(true); setOpen(null); }}>Import places</button>
        <button type="button" className="btn btn-quiet" onClick={() => { setOpen('new'); setImporting(false); }}>Add a place</button>
      </div>
      {importing && <ImportSheet d={d} run={run} busy={busy} online={online} toast={toast} live={live} onClose={() => setImporting(false)} />}
      {open === 'new' && editor(null)}
      {places.length > 0 && (
        <>
          <table className="wg-table">
            <thead><tr><th>Name</th><th>Address</th><th>Days</th><th>On the map</th><th>Accessible</th></tr></thead>
            <tbody>
              {shown.map((p) => (open === p.id ? (
                <tr key={p.id}><td colSpan={5}>{editor(p)}</td></tr>
              ) : (
                <tr key={p.id} data-closed={p.closed ? '' : undefined}>
                  <td><button type="button" className="wg-rowbtn" onClick={() => setOpen(p.id)}><span className="wg-name">{p.name}</span>{p.closed && <span className="chip chip-danger"> Closed today</span>}</button></td>
                  <td><button type="button" className="wg-rowbtn" tabIndex={-1} onClick={() => setOpen(p.id)}>{p.address}</button></td>
                  <td><button type="button" className="wg-rowbtn" tabIndex={-1} onClick={() => setOpen(p.id)}>{placeDaysWords(p, days)}</button></td>
                  <td><button type="button" className="wg-rowbtn" tabIndex={-1} onClick={() => setOpen(p.id)}>{p.lat != null ? 'Yes' : 'Not on the map'}</button></td>
                  <td><button type="button" className="wg-rowbtn" tabIndex={-1} onClick={() => setOpen(p.id)}>{p.accessible === true ? 'Yes' : p.accessible === false ? 'No' : '—'}</button></td>
                </tr>
              )))}
            </tbody>
          </table>
          <ul className="wg-list">
            {shown.map((p) => (open === p.id ? <li key={p.id}>{editor(p)}</li> : (
              <li key={p.id}>
                <button type="button" className="wg-rowbtn" onClick={() => setOpen(p.id)}>
                  <span className="wg-name">{p.name}{p.closed ? ' · Closed today' : ''}</span>
                  <span className="wg-sub">{p.address} · {placeDaysWords(p, days)}{p.lat == null ? ' · Not on the map' : ''}</span>
                </button>
              </li>
            )))}
          </ul>
        </>
      )}
      {err && <p className="wg-err" role="alert">{err}</p>}
      <CheckFoot section="places" d={d} run={run} busy={busy} online={online} />
    </section>
  );
}

// ── On the ballot ──
function BallotCard({ d, run, busy, online }) {
  const saved = arr(d.guide.contests).map((c) => ({ office: c.office, vote_for: c.vote_for, text: arr(c.names).map((n) => n.name).join('\n'), ours: Object.fromEntries(arr(c.names).map((n) => [n.name, Boolean(n.ours)])) }));
  const [draft, setDraft] = useState(null);
  const [err, setErr] = useState(null);
  const rows = draft ?? saved;
  const set = (i, patch) => setDraft(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const save = async (list = rows) => {
    setErr(null);
    try {
      await run('site.guide.ballot', {
        contests: list.filter((c) => c.office.trim()).map((c) => ({
          office: c.office.trim(), vote_for: Number(c.vote_for) || 1,
          names: c.text.split('\n').map((n) => n.trim()).filter(Boolean).map((name) => (name in c.ours ? { name, ours: c.ours[name] } : { name })),
        })),
      });
      setDraft(null);
    } catch (e) { setErr(e.message); }
  };
  return (
    <section className="card wg-card" id="wg-ballot" aria-labelledby="wg-ballot-h">
      <h2 id="wg-ballot-h">On the ballot</h2>
      {rows.map((c, i) => (
        <div className="wg-contest" key={i}>
          <div className="wg-grid">
            <div className="wg-fld"><label htmlFor={`wg-off-${i}`}>Office</label><input id={`wg-off-${i}`} className="input" value={c.office} maxLength={80} onChange={(e) => set(i, { office: e.target.value })} /></div>
            <div className="wg-fld"><label htmlFor={`wg-vf-${i}`}>Vote for</label><input id={`wg-vf-${i}`} className="input" type="number" min={1} max={20} value={c.vote_for} onChange={(e) => set(i, { vote_for: e.target.value })} /></div>
          </div>
          <div className="wg-fld">
            <label htmlFor={`wg-names-${i}`}>One name per line, exactly as on the ballot</label>
            <textarea id={`wg-names-${i}`} className="input wg-text" value={c.text} onChange={(e) => set(i, { text: e.target.value })} />
          </div>
          {draft === null && c.text.trim() && (
            <div className="wg-names" role="group" aria-label={`Ours — ${c.office}`}>
              {c.text.split('\n').filter((n) => n.trim()).map((name) => (
                <label key={name} className="wg-check">
                  <input type="checkbox" checked={Boolean(c.ours[name])} disabled={busy || !online}
                    onChange={(e) => save(rows.map((r, j) => (j === i ? { ...r, ours: { ...r.ours, [name]: e.target.checked } } : r)))} />
                  <span>{name} · Ours</span>
                </label>
              ))}
            </div>
          )}
          <button type="button" className="btn btn-quiet" onClick={() => setDraft(rows.filter((_, j) => j !== i))}>Remove this office</button>
        </div>
      ))}
      <div className="wg-row">
        <button type="button" className="btn" onClick={() => setDraft([...rows, { office: '', vote_for: 1, text: '', ours: {} }])}>Add an office</button>
        <button type="button" className="btn" disabled={busy || !online || draft === null} onClick={() => save()}>Save</button>
      </div>
      {err && <p className="wg-err" role="alert">{err}</p>}
      <CheckFoot section="ballot" d={d} run={run} busy={busy} online={online} />
    </section>
  );
}

// ── Texts and links: one form per card, saved with site.guide.save ──
function useFields(d, pick) {
  const saved = pick(d.guide);
  const [draft, setDraft] = useState(null);
  return { v: draft ?? saved, set: (patch) => setDraft({ ...(draft ?? saved), ...patch }), dirty: draft !== null, reset: () => setDraft(null) };
}
function SaveRow({ f, run, busy, online, input }) {
  const [err, setErr] = useState(null);
  const [said, setSaid] = useState('');
  const save = async () => {
    setErr(null);
    try { await run('site.guide.save', input(f.v)); f.reset(); setSaid('Saved'); } catch (e) { setErr(e.message); }
  };
  return (
    <>
      <div className="wg-row">
        <button type="button" className="btn" disabled={busy || !online || !f.dirty} onClick={save}>Save</button>
        {!online && <NeedsSignal />}
        <span className="wg-line wg-ok" role="status">{f.dirty ? '' : said}</span>
      </div>
      {err && <p className="wg-err" role="alert">{err}</p>}
    </>
  );
}

function RulesCard({ d, run, busy, online }) {
  const f = useFields(d, (g) => ({ ...Object.fromEntries(RULES.map(([k]) => [k, g.rules?.[k] || ''])), ballot_note: g.ballot_note || '' }));
  return (
    <section className="card wg-card" id="wg-rules" aria-labelledby="wg-rules-h">
      <h2 id="wg-rules-h">What to bring and who can vote</h2>
      {RULES.map(([k, label]) => (
        <div className="wg-fld" key={k}>
          <label htmlFor={`wg-r-${k}`}>{label}</label>
          <textarea id={`wg-r-${k}`} className="input wg-text" maxLength={1200} placeholder={HINT} value={f.v[k]} onChange={(e) => f.set({ [k]: e.target.value })} />
        </div>
      ))}
      <div className="wg-fld">
        <label htmlFor="wg-r-note">A note under the ballot</label>
        <textarea id="wg-r-note" className="input wg-text" maxLength={300} placeholder="For example, how names are printed on the ballot — only if the elections office says so" value={f.v.ballot_note} onChange={(e) => f.set({ ballot_note: e.target.value })} />
      </div>
      <SaveRow f={f} run={run} busy={busy} online={online} input={(v) => ({ rules: Object.fromEntries(RULES.map(([k]) => [k, v[k]])), ballot_note: v.ballot_note })} />
      <CheckFoot section="rules" d={d} run={run} busy={busy} online={online} label="I checked this" />
    </section>
  );
}

function OfficialCard({ d, run, busy, online }) {
  const f = useFields(d, (g) => ({ official_url: g.official_url || '', official_label: g.official_label || '' }));
  return (
    <section className="card wg-card" id="wg-official" aria-labelledby="wg-off-h">
      <h2 id="wg-off-h">Official link</h2>
      <div className="wg-grid">
        <div className="wg-fld"><label htmlFor="wg-ourl">Elections office’s page</label><input id="wg-ourl" className="input" type="url" placeholder="https://" value={f.v.official_url} onChange={(e) => f.set({ official_url: e.target.value })} /></div>
        <div className="wg-fld"><label htmlFor="wg-olab">Its name as voters know it</label><input id="wg-olab" className="input" maxLength={120} value={f.v.official_label} onChange={(e) => f.set({ official_label: e.target.value })} /></div>
      </div>
      <SaveRow f={f} run={run} busy={busy} online={online} input={(v) => v} />
    </section>
  );
}

function Confirm({ words, onYes, onNo, busy, online }) {
  return (
    <div className="wg-confirm">
      <p>{words}</p>
      <button type="button" className="btn" disabled={busy || !online} onClick={onYes}>Yes</button>
      <button type="button" className="btn btn-quiet" onClick={onNo}>No</button>
    </div>
  );
}

function MoreCard({ d, run, busy, online, manager, toast }) {
  const f = useFields(d, (g) => ({ request_by: g.mail?.request_by || '', mail_url: g.mail?.url || '', ride_phone: g.ride_phone || '', wait_url: g.wait_url || '', banner: g.banner !== false }));
  const [origins, setOrigins] = useState(null);
  const [asking, setAsking] = useState(null); // 'unpublish' | 'clear'
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState('');
  const site = String(d.site || '').replace(/\/+$/, '');
  const snippet = `<iframe src="${site}/embed/voter-guide" title="Voter guide" allow="geolocation" loading="lazy" style="width:100%;min-height:1200px;border:0"></iframe>\n<script src="${site}/site-assets/embed.js" async></script>`;
  const o = origins ?? arr(d.guide.embed_origins).join('\n');
  const doIt = async (name, input, said) => { setErr(null); try { await run(name, input); setAsking(null); if (said) toast(said); return true; } catch (e) { setErr(e.message); return false; } };
  const pages = arr(d.pages);
  const published = d.guide.status === 'published';
  return (
    <details className="card wg-more">
      <summary>More</summary>
      <div className="wg-more__body">
        <div className="wg-grid">
          <div className="wg-fld"><label htmlFor="wg-mby">Voting by mail: ask by</label><input id="wg-mby" className="input" type="date" value={f.v.request_by} onChange={(e) => f.set({ request_by: e.target.value })} /></div>
          <div className="wg-fld"><label htmlFor="wg-murl">Voting by mail: link</label><input id="wg-murl" className="input" type="url" placeholder="https://" value={f.v.mail_url} onChange={(e) => f.set({ mail_url: e.target.value })} /></div>
          <div className="wg-fld"><label htmlFor="wg-ride">Ride to vote phone</label><input id="wg-ride" className="input" type="tel" value={f.v.ride_phone} onChange={(e) => f.set({ ride_phone: e.target.value })} /></div>
          <div className="wg-fld"><label htmlFor="wg-wait">Wait-time map link</label><input id="wg-wait" className="input" type="url" placeholder="https://" value={f.v.wait_url} onChange={(e) => f.set({ wait_url: e.target.value })} /></div>
        </div>
        <label className="wg-check"><input type="checkbox" checked={f.v.banner} onChange={(e) => f.set({ banner: e.target.checked })} /><span>Show a voting banner on every page</span></label>
        <SaveRow f={f} run={run} busy={busy} online={online}
          input={(v) => ({ mail: { request_by: v.request_by || null, url: v.mail_url }, ride_phone: v.ride_phone, wait_url: v.wait_url, banner: v.banner })} />

        <div>
          <h3 className="vi-sub">The guide page</h3>
          {pages.length ? (
            <ul className="wg-checks">{pages.map((p) => (
              <li key={p.id}>
                <Link to={`/website/pages/${p.id}`}>{p.title || 'Voter guide'}{p.published ? '' : ' (draft)'} — open in the builder</Link>
                <span className="muted"> {p.path}{p.site_id ? ' · another website' : ''}</span>
              </li>
            ))}</ul>
          ) : (
            <button type="button" className="btn" disabled={busy || !online} onClick={() => doIt('site.guide.page', {}, 'Page added as a draft — publish it from Pages')}>Add the guide page</button>
          )}
        </div>

        <div>
          <h3 className="vi-sub">Embed on another website</h3>
          {manager && (
            <div className="wg-fld">
              <label htmlFor="wg-orig">Websites that may show it (one per line, up to 5)</label>
              <textarea id="wg-orig" className="input wg-text" placeholder="https://www.example.ca" value={o} onChange={(e) => setOrigins(e.target.value)} />
              <div className="wg-row">
                <button type="button" className="btn" disabled={busy || !online || origins === null}
                  onClick={async () => { if (await doIt('site.guide.embed', { origins: o.split('\n').map((x) => x.trim()).filter(Boolean) }, 'Saved')) setOrigins(null); }}>Save</button>
              </div>
            </div>
          )}
          <label className="wg-sr" htmlFor="wg-snip">The code to paste</label>
          <textarea id="wg-snip" className="input wg-snippet" readOnly value={snippet} />
          <div className="wg-row">
            <button type="button" className="btn" onClick={async () => { try { await navigator.clipboard.writeText(snippet); setCopied('Copied'); } catch { setCopied('Select the code and copy it'); } }}>Copy</button>
            <span className="wg-line" role="status">{copied}</span>
          </div>
        </div>

        <div className="wg-row">
          <Link className="btn btn-quiet" to="/vote-info?draft=1">See it as a canvasser</Link>
          <span className="wg-line">Asked to be told: {num(d.asked)} · <Link to="/people?web=guide">See them</Link></span>
        </div>

        {manager && (
          <div className="wg-row">
            {published && <button type="button" className="btn btn-quiet" onClick={() => setAsking('unpublish')}>Unpublish</button>}
            {(!published || d.state === 'over') && <button type="button" className="btn btn-quiet" onClick={() => setAsking('clear')}>Clear for the next election</button>}
          </div>
        )}
        {asking === 'unpublish' && <Confirm words="Take the guide down? It will say ‘not out yet’." busy={busy} online={online} onNo={() => setAsking(null)} onYes={() => doIt('site.guide.unpublish', {}, 'The guide is down')} />}
        {asking === 'clear' && <Confirm words="Clear days, places and names?" busy={busy} online={online} onNo={() => setAsking(null)} onYes={() => doIt('site.guide.clear', {}, 'Cleared')} />}
        {err && <p className="wg-err" role="alert">{err}</p>}
      </div>
    </details>
  );
}

export default function WebsiteGuide() {
  const { me } = useOutletContext() || {};
  const manager = me?.role === 'manager';
  const q = useSiteGuide();
  const online = useOnline();
  const { run, busy } = useRun();
  const { toast, say, clear } = useToast();
  const [publishing, setPublishing] = useState(false);
  const [gotvDays, setGotvDays] = useState(null);
  const [pubErr, setPubErr] = useState('');
  const [adding, setAdding] = useState(false);
  const d = q.data;

  const head = (state) => (
    <div className="wg-head">
      <h1>Voter guide {state && <span className="chip">{GUIDE_STATE[state]}</span>}</h1>
      {d && manager && (state === 'draft' || state === 'not_out') && (
        <button type="button" className="btn btn-primary" disabled={!online} onClick={() => { setPublishing(true); setPubErr(''); }}>Publish</button>
      )}
      {d && state === 'live' && (() => {
        const page = arr(d.pages).find((p) => !p.site_id && p.published);
        return page ? <a className="btn btn-primary" href={`${String(d.site).replace(/\/+$/, '')}${page.path}`} target="_blank" rel="noopener">View guide<span className="ws-sr"> (opens a new tab)</span></a> : null;
      })()}
    </div>
  );
  if (!d) {
    return (
      <div className="wb-page wg-page">
        {head(null)}
        <WebsiteTabs />
        {noSignal(q) ? <NoSignal /> : q.isError
          ? <p className="wg-err" role="alert">Unavailable — <button type="button" className="btn-link" onClick={() => q.refetch()}>Try again</button></p>
          : <p className="muted">Loading…</p>}
      </div>
    );
  }
  const g = d.guide;
  const empty = !arr(g.days).length && !arr(g.places).length && !arr(g.contests).length;
  const live = d.state === 'live';
  // Tick "Also use these days for GOTV mode" when GOTV has none or others.
  const adv = arr(g.days).filter((x) => x.kind === 'advance').map((x) => x.day).sort();
  const elec = arr(g.days).filter((x) => x.kind === 'general').map((x) => x.day).sort().at(-1) || null;
  const gotvSame = d.gotv?.election_day === elec && JSON.stringify([...arr(d.gotv?.advance_days)].sort()) === JSON.stringify(adv);
  const useGotv = gotvDays ?? !gotvSame;
  const publish = async () => {
    setPubErr('');
    try { await run('site.guide.publish', { gotv_days: useGotv }); setPublishing(false); say('Published — the guide is live'); } catch (e) { setPubErr(e.message); }
  };
  const missing = arr(d.checklist).filter((c) => !c.done);
  return (
    <div className="wb-page wg-page">
      {head(d.state)}
      <WebsiteTabs />
      {!manager && (d.state === 'draft' || d.state === 'not_out') && <p className="wg-line">A manager publishes it.</p>}

      {publishing && (
        <div className="wg-confirm" role="group" aria-label="Publish">
          <p>Publish the voter guide?</p>
          <label className="wg-check"><input type="checkbox" checked={useGotv} onChange={(e) => setGotvDays(e.target.checked)} /><span>Also use these days for GOTV mode</span></label>
          <button type="button" className="btn" disabled={busy || !online} onClick={publish}>Yes</button>
          <button type="button" className="btn btn-quiet" onClick={() => setPublishing(false)}>No</button>
        </div>
      )}
      <p className="wg-err" aria-live="polite">{pubErr}</p>

      {empty && !adding && (
        <section className="card wg-card">
          <p className="wg-line">Nothing yet. Add it when the elections office publishes it.</p>
          <div className="wg-row"><button type="button" className="btn" onClick={() => setAdding(true)}>Add voting days</button></div>
        </section>
      )}

      {d.state !== 'live' && d.state !== 'over' && (
        <section className="card wg-card" aria-labelledby="wg-check-h">
          <h2 id="wg-check-h">Before it goes live</h2>
          <ul className="wg-checks">
            {arr(d.checklist).map((c) => (
              <li key={c.key} data-done={c.done ? '' : undefined}>
                <span className="wg-tick" aria-hidden="true">{c.done ? '✓' : '○'}</span>
                {c.done ? <span>{c.words}<span className="ws-sr"> — done</span></span>
                  : c.key === 'authorized' ? <Link to="/website/settings#org">{c.words}</Link>
                    : <a href={FIX[c.key] || '#'}>{c.words}</a>}
              </li>
            ))}
          </ul>
          {!missing.length && <p className="wg-line wg-ok">Everything is ready.</p>}
        </section>
      )}

      {(!empty || adding) && <DaysCard d={d} run={run} busy={busy} online={online} adding={adding} onAdded={() => setAdding(false)} />}
      {!empty && (
        <>
          <PlacesCard d={d} run={run} busy={busy} online={online} toast={say} live={live} />
          <BallotCard d={d} run={run} busy={busy} online={online} />
          <RulesCard d={d} run={run} busy={busy} online={online} />
          <OfficialCard d={d} run={run} busy={busy} online={online} />
        </>
      )}
      <MoreCard d={d} run={run} busy={busy} online={online} manager={manager} toast={say} />
      <Toast toast={toast} onClear={clear} />
    </div>
  );
}

