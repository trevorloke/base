// Mainstreeting (/mainstreet) — meeting people where they are: an event, a
// bus loop, a market. Say where you are once (kept on this phone); then, for
// each person, first and last name, phone, email, postal code, how they
// lean, a note, and whether they'd volunteer or want the newsletter. Save
// clears the form for the next person and keeps the place; it goes through
// the outbox, so with no signal it waits on the phone and is sent once
// (mainstreet.meet, ext/mainstreet). Who you've met here today is listed
// under the form.
import { useEffect, useRef, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { queueAction } from '../offline.js';
import RatingButtons from '../components/RatingButtons.jsx';
import { queuedText } from '../components/queued.js';
import './shifts.css';
import './mainstreet.css';

const PLACE_KEY = 'starbase:mainstreet:place';
const MET_KEY = 'starbase:mainstreet:met';
const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
const today = () => new Date().toDateString();
const BLANK = { first: '', last: '', phone: '', email: '', postal: '', note: '', rating: null, volunteer: false, newsletter: false };

export default function Mainstreet() {
  const { me } = useOutletContext() ?? {};
  const queryClient = useQueryClient();
  const [place, setPlace] = useState(() => read(PLACE_KEY, ''));
  const [placing, setPlacing] = useState(() => !read(PLACE_KEY, ''));
  const [f, setF] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [said, setSaid] = useState(null);
  // Met today, on this phone: [{ name, place, queued }]
  const [met, setMet] = useState(() => { const m = read(MET_KEY, null); return m?.day === today() ? m.list : []; });
  const firstRef = useRef(null);
  useEffect(() => { write(MET_KEY, { day: today(), list: met }); }, [met]);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const savePlace = (e) => {
    e.preventDefault();
    const p = place.trim();
    if (!p) return;
    write(PLACE_KEY, p);
    setPlace(p);
    setPlacing(false);
    requestAnimationFrame(() => firstRef.current?.focus());
  };

  const save = async (e) => {
    e.preventDefault();
    setError(null); setSaid(null);
    const name = [f.first, f.last].map((x) => x.trim()).filter(Boolean).join(' ');
    if (!name) { setError('A first or last name'); return; }
    setBusy(true);
    try {
      const r = await queueAction('mainstreet.meet', {
        place,
        first_name: f.first.trim() || undefined,
        last_name: f.last.trim() || undefined,
        phone: f.phone.trim() || undefined,
        email: f.email.trim() || undefined,
        postal: f.postal.trim() || undefined,
        rating: f.rating || undefined,
        note: f.note.trim() || undefined,
        volunteer: f.volunteer || undefined,
        newsletter: f.newsletter || undefined,
      }, { who: name });
      setMet((m) => [{ name, place, queued: Boolean(r.queued) }, ...m].slice(0, 200));
      setSaid(r.queued ? queuedText(r, name) : `✓ ${name} — saved`);
      setF(BLANK);
      if (!r.queued) {
        for (const k of ['persons', 'person', 'brief', 'requests']) queryClient.invalidateQueries({ queryKey: [k] });
      }
      requestAnimationFrame(() => firstRef.current?.focus());
    } catch (err) {
      setError(err.message || 'Not saved — try again');
    } finally {
      setBusy(false);
    }
  };

  const here = met.filter((m) => m.place === place);
  return (
    <div className="ops-page ms-page">
      <Link to="/" className="ops-back">← Today</Link>
      <h1>Mainstreeting</h1>

      {placing ? (
        <form className="card ms-place" onSubmit={savePlace} aria-label="Where you are">
          <div className="field">
            <label htmlFor="ms-place">Where are you?</label>
            <input id="ms-place" className="input" autoFocus maxLength={120} placeholder="Newton bus loop · Cloverdale market · the rally"
              value={place} onChange={(e) => setPlace(e.target.value)} />
            <span className="ops-meta">Kept on this phone for everyone you meet here.</span>
          </div>
          <button type="submit" className="btn btn-primary ops-tap" disabled={!place.trim()}>Start</button>
        </form>
      ) : (
        <>
          <p className="ms-where">
            <span className="eyebrow">At</span> <strong>{place}</strong>
            <button type="button" className="btn btn-quiet ops-tap" onClick={() => setPlacing(true)}>Change</button>
          </p>
          <form className="card ms-form" onSubmit={save} aria-label="Someone you met">
            <div className="form-row">
              <div className="field">
                <label htmlFor="ms-first">First name</label>
                <input id="ms-first" ref={firstRef} className="input" maxLength={150} autoComplete="off" value={f.first} onChange={set('first')} />
              </div>
              <div className="field">
                <label htmlFor="ms-last">Last name</label>
                <input id="ms-last" className="input" maxLength={150} autoComplete="off" value={f.last} onChange={set('last')} />
              </div>
            </div>
            <div className="form-row">
              <div className="field">
                <label htmlFor="ms-phone">Phone</label>
                <input id="ms-phone" className="input mono" type="tel" inputMode="tel" maxLength={40} autoComplete="off" value={f.phone} onChange={set('phone')} />
              </div>
              <div className="field">
                <label htmlFor="ms-email">Email</label>
                <input id="ms-email" className="input" type="email" inputMode="email" autoCapitalize="none" maxLength={320} autoComplete="off" value={f.email} onChange={set('email')} />
              </div>
            </div>
            <div className="field ms-postal">
              <label htmlFor="ms-postal">Postal code</label>
              <input id="ms-postal" className="input mono" maxLength={7} autoCapitalize="characters" autoComplete="off" value={f.postal} onChange={set('postal')} />
            </div>
            <div className="ms-rate">
              <span className="eyebrow">How they lean</span>
              <RatingButtons value={f.rating} onPick={(code) => setF((x) => ({ ...x, rating: x.rating === code ? null : code }))} disabled={busy} />
            </div>
            <div className="ms-asks">
              <label className="ot-check"><input type="checkbox" checked={f.volunteer} onChange={set('volunteer')} /> <span>Wants to volunteer</span></label>
              <label className="ot-check"><input type="checkbox" checked={f.newsletter} onChange={set('newsletter')} disabled={!f.email.trim()} /> <span>Newsletter{!f.email.trim() ? ' (needs an email)' : ''}</span></label>
            </div>
            <div className="field">
              <label htmlFor="ms-note">Note</label>
              <textarea id="ms-note" className="input" rows={2} maxLength={2000} placeholder="What they care about" value={f.note} onChange={set('note')} />
            </div>
            {error && <p className="error" role="alert">{error}</p>}
            <div className="ops-actions">
              <button type="submit" className="btn btn-primary ops-tap ops-wide" disabled={busy}>{busy ? 'Saving…' : 'Save · next person'}</button>
            </div>
            {said && <p className="ops-done" role="status">{said}</p>}
          </form>
          {here.length > 0 && (
            <section className="ms-met" aria-label="Met here today">
              <span className="eyebrow">Met here today · {here.length}</span>
              <ul className="ops-plain-list">
                {here.map((m, i) => <li key={`${m.name}-${i}`}>{m.name}{m.queued && <span className="chip obx-chip"> Not sent yet</span>}</li>)}
              </ul>
            </section>
          )}
        </>
      )}
      {me?.role !== 'volunteer' && <p className="ops-meta ms-foot">They show on People tagged <em>mainstreeting</em>, each with a Mainstreeting contact and where you met.</p>}
    </div>
  );
}
