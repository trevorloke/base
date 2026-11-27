// Enter a membership form (/people/membership-form — the desk that handles
// money): the paper form, box for box, in its order — basic information,
// campus, get involved, languages, interests, the membership, giving once
// and monthly, how they paid, the declaration. While the name, email or phone
// is typed, people already on file who may be the same are offered; the desk
// picks one or says it's someone new. Save does it all at once
// (membership.enter, ext/membership) and says what was done, what to check,
// and who entered it (the form's "Office use" line). Card numbers are never
// typed here.
//
// The form is the campaign's own: its terms, amounts, clubs, dues, city and
// the lists it falls back on all come from its server (GET /membership/form,
// `form`), and none of them is written here. So there is no form to draw
// until the server has answered; a campaign with no membership has no such
// answer, and no link to this screen.
import { useEffect, useMemo, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet } from '../api.js';
import { useFieldsList } from '../components/FieldsBits.jsx';
import { NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import './shifts.css'; // the ops-* pieces (the page column, the back link)
import './membership.css';

const SIGNS = [['lawn', 'Lawn'], ['window', 'Window'], ['large', 'Large 4×4'], ['billboard', 'Billboard 8×4']];
const METHODS = [['cash', 'Cash'], ['cheque', 'Cheque'], ['card', 'Credit card'], ['etransfer', 'E-transfer'], ['pad', 'Pre-authorized debit']];
const today = () => new Date().toISOString().slice(0, 10);
const dollars = (c) => `$${(c / 100).toLocaleString('en-CA', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const cents = (s) => { const n = Number(String(s).replace(/[$,\s]/g, '')); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null; };
const BLANK = {
  first: '', last: '', gender: '', birth: '', email: '', phone: '', address: '', city: '', postal: '',
  citizenship: '', union: false, local: '', campus: '', campusOther: '',
  volunteer: false, candidate: false, sign: '', languages: [], otherLang: '', interests: [],
  term: '', once: '', onceOther: '', monthly: '', monthlyOther: '', schoolBoard: false, method: '',
  signed: false, signedOn: today(), optIn: true,
};

const Check = ({ on, onChange, children, disabled }) => (
  <label className={`mf-check${on ? ' is-on' : ''}`}><input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /> {children}</label>
);
const OTHER_CAMPUS = '\u0001another';
const Radio = ({ name, value, on, onPick, children }) => (
  <label className={`mf-check${on ? ' is-on' : ''}`}><input type="radio" name={name} checked={on} onChange={() => onPick(value)} /> {children}</label>
);

const formQuery = (day) => ({ queryKey: ['membership', 'form', day], queryFn: () => apiGet(`/membership/form?date=${day || today()}`) });
const Head = () => (
  <>
    <Link to="/people" className="ops-back">← People</Link>
    <h1>Enter a membership form</h1>
  </>
);

// The form as the server sent it, then the screen: a blank form is made
// only once there is one to make it from.
export default function MembershipForm() {
  const first = useQuery(formQuery(BLANK.signedOn));
  const form = first.data?.form;
  if (!form) {
    return (
      <div className="ops-page mf-page">
        <Head />
        {noSignal(first) ? <NoSignal />
          : first.isError ? <p className="error" role="alert">Couldn’t load the form — {first.error.message}</p>
            : <p className="muted" role="status">Loading…</p>}
      </div>
    );
  }
  return <FormScreen first={form} />;
}

function FormScreen({ first }) {
  const { me } = useOutletContext() ?? {};
  const qc = useQueryClient();
  const online = useOnline();
  const blank = { ...BLANK, city: first.city || '' };
  const [f, setF] = useState(blank);
  const [personId, setPersonId] = useState(null); // one already on file, picked
  const [notThem, setNotThem] = useState(new Set()); // matches the desk said aren't this person
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v && v.target ? v.target.value : v }));
  const flip = (k, item) => (on) => setF((x) => ({ ...x, [k]: on ? [...x[k], item] : x[k].filter((y) => y !== item) }));

  // The day signed sets the year, and the year the club amounts: asked again
  // when the date changes, the form on screen kept until the answer is in.
  const asked = useQuery({ ...formQuery(f.signedOn), placeholderData: keepPreviousData });
  const form = asked.data?.form || first;
  const clubs = form.clubs || [];
  const clubOf = (pick) => clubs.find((c) => c.key === pick) || null;
  const dues = form.dues;
  const [youthFrom, youthTo] = dues.youth_ages;

  const fields = useFieldsList();
  const choicesOf = (name, fallback) => (fields.data?.fields || []).find((x) => x.name === name && !x.retired)?.choices?.filter((c) => c !== 'Other') || fallback || [];
  const langs = choicesOf('Language', form.fallback?.languages);
  const interests = choicesOf('Interests', form.fallback?.interests);
  // Campus: the Campus field's choices (school and campus together), then "Another campus".
  const campusField = (fields.data?.fields || []).find((x) => x.name === 'Campus' && !x.retired);
  const campuses = campusField?.kind === 'choice' ? campusField.choices : form.fallback?.campuses || [];

  // Already on file? Asked as the email, phone or name is typed.
  const [lookup, setLookup] = useState('');
  useEffect(() => {
    const q = new URLSearchParams({ email: f.email.trim(), phone: f.phone.trim(), first: f.first.trim(), last: f.last.trim() }).toString();
    const t = setTimeout(() => setLookup(q), 400);
    return () => clearTimeout(t);
  }, [f.email, f.phone, f.first, f.last]);
  const match = useQuery({ queryKey: ['membership', 'match', lookup], queryFn: () => apiGet(`/membership/match?${lookup}`), enabled: Boolean(lookup) && !personId });
  const maybe = (match.data?.people || []).filter((p) => !notThem.has(p.id));
  const picked = personId ? (match.data?.people || []).find((p) => p.id === personId) || { id: personId, name: 'the person on file' } : null;

  const age = useMemo(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.birth)) return null;
    const [by, bm, bd] = f.birth.split('-').map(Number);
    const [y, m, d] = (f.signedOn || today()).split('-').map(Number);
    return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
  }, [f.birth, f.signedOn]);
  const youth = age != null && age >= youthFrom && age <= youthTo;
  const rate = youth ? dues.youth_cents : dues.adult_cents;
  const minimum = f.term ? Number(f.term) * rate : 0;

  // A club, by the key the server gave it: one of them can go to the school
  // board's slate instead (the tick under the amounts).
  const gift = (pick, other) => {
    if (!pick) return null;
    const club = clubOf(pick);
    if (club) return { kind: club.key, slate: club.schoolBoard && f.schoolBoard ? 'school_board' : null };
    if (pick === 'other') return cents(other) ? { kind: 'amount', amount_cents: cents(other) } : null;
    return { kind: 'amount', amount_cents: Number(pick) };
  };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await action('membership.enter', {
        person_id: personId || undefined,
        first_name: f.first.trim() || undefined, last_name: f.last.trim() || undefined, gender: f.gender.trim() || undefined,
        birth_date: f.birth || undefined, email: f.email.trim() || undefined, phone: f.phone.trim() || undefined,
        address: f.address.trim() || undefined, city: f.city.trim() || undefined, postal: f.postal.trim() || undefined,
        citizenship: f.citizenship || undefined, union_member: f.union, union_local: f.local.trim() || undefined,
        // "Another campus": its words go to the person's Notes (the server says so).
        campus: f.campus === OTHER_CAMPUS ? (f.campusOther.trim() || undefined) : (f.campus || undefined),
        volunteer: f.volunteer, candidate: f.candidate, sign: f.sign || undefined,
        languages: f.languages, other_language: f.otherLang.trim() || undefined, interests: f.interests,
        term: f.term ? Number(f.term) : undefined,
        once: gift(f.once, f.onceOther) || undefined, monthly: gift(f.monthly, f.monthlyOther) || undefined,
        method: f.method || undefined, signed: f.signed, signed_on: f.signedOn || undefined, opt_in: f.optIn,
      });
      setDone(r);
      qc.invalidateQueries({ queryKey: ['persons'] });
      qc.invalidateQueries({ queryKey: ['person', r.person.id] });
      window.scrollTo?.({ top: 0 });
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const another = () => { setF({ ...blank, signedOn: f.signedOn }); setPersonId(null); setNotThem(new Set()); setDone(null); setError(null); };

  const head = <Head />;
  if (done) {
    const m = done.membership;
    return (
      <div className="ops-page mf-page">
        {head}
        <section className="card mf-done" aria-live="polite">
          <h2>✓ Saved — <Link to={`/people/${done.person.id}`}>{done.person.name}</Link></h2>
          <ul>
            {m && <li>Member {m.youth ? `(aged ${youthFrom} to ${youthTo}) ` : ''}from {m.starts_on} to {m.ends_on} — {m.term_years} year{m.term_years > 1 ? 's' : ''}</li>}
            {done.gifts.map((g) => <li key={g.id}>{dollars(g.amount_cents)} {g.cadence === 'monthly' ? 'this month (monthly)' : 'once'} to the {g.slate === 'school_board' ? 'school board' : 'council'} slate</li>)}
            {done.pledges.length > 0 && <li>Monthly pledge on file — log each month at Donations as it comes in</li>}
            {done.sign && <li>A {done.sign.kind} sign to put up</li>}
          </ul>
          {done.warnings.length > 0 && (
            <div className="mf-warn" role="alert"><strong>Check:</strong><ul>{done.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>
          )}
          <p className="mf-office">Office use: entered in base.win by <strong>{done.entered.by || me?.user?.name}</strong> on {done.entered.on} — tick the box on the paper form.</p>
          <button type="button" className="btn btn-primary" onClick={another}>Enter another form</button>
        </section>
      </div>
    );
  }

  return (
    <div className="ops-page mf-page">
      {head}
      <p className="muted">Type it as it’s written on the form. Card numbers are never entered here.</p>
      <form className="mf-form" onSubmit={save} aria-label="Membership form">
        <fieldset className="card mf-sec">
          <legend>Basic information</legend>
          <div className="mf-row">
            <label className="field">First name<input className="input" value={f.first} onChange={set('first')} maxLength={150} autoFocus /></label>
            <label className="field">Last name<input className="input" value={f.last} onChange={set('last')} maxLength={150} /></label>
            <label className="field mf-narrow">Gender<input className="input" value={f.gender} onChange={set('gender')} maxLength={60} /></label>
          </div>
          <div className="mf-row">
            <label className="field mf-narrow">Birth date<input className="input" type="date" value={f.birth} onChange={set('birth')} max={today()} /></label>
            <label className="field">Email<input className="input" type="email" value={f.email} onChange={set('email')} maxLength={320} /></label>
            <label className="field mf-narrow">Mobile phone<input className="input" type="tel" value={f.phone} onChange={set('phone')} maxLength={40} /></label>
          </div>
          {age != null && <p className="mf-hint">{age} on the day signed{youth ? ` — the ${dollars(dues.youth_cents)} youth rate applies (${youthFrom} to ${youthTo})` : age < dues.min_age ? ` — members are ${dues.min_age} or older` : ''}</p>}
          <div className="mf-row">
            <label className="field">Residential address<input className="input" value={f.address} onChange={set('address')} maxLength={400} /></label>
            <label className="field mf-narrow">City<input className="input" value={f.city} onChange={set('city')} maxLength={120} /></label>
            <label className="field mf-narrow">Postal code<input className="input" value={f.postal} onChange={set('postal')} maxLength={20} /></label>
          </div>
          {picked ? (
            <p className="mf-match is-picked">Updating <strong>{picked.name}</strong>’s record. <button type="button" className="btn-link" onClick={() => setPersonId(null)}>No — someone new</button></p>
          ) : maybe.length > 0 && (
            <div className="mf-match" role="status">
              <p>Already on file?</p>
              <ul>{maybe.map((p) => (
                <li key={p.id}>
                  <span><strong>{p.name}</strong> {[p.email, p.phone, p.address].filter(Boolean).join(' · ')}</span>
                  <button type="button" className="btn" onClick={() => setPersonId(p.id)}>That’s them</button>
                  <button type="button" className="btn-link" onClick={() => setNotThem((s) => new Set([...s, p.id]))}>Not them</button>
                </li>
              ))}</ul>
            </div>
          )}
          <div className="mf-line" role="radiogroup" aria-label="I’m a">
            <span className="mf-label">I’m a</span>
            <Radio name="cit" value="citizen" on={f.citizenship === 'citizen'} onPick={set('citizenship')}>Canadian citizen</Radio>
            <Radio name="cit" value="pr" on={f.citizenship === 'pr'} onPick={set('citizenship')}>Permanent resident</Radio>
            <Check on={f.union} onChange={set('union')}>Union member</Check>
            {f.union && <input className="input mf-inline" placeholder="local" aria-label="Union local" value={f.local} onChange={set('local')} maxLength={120} />}
          </div>
        </fieldset>

        <fieldset className="card mf-sec">
          <legend>Campus · Get involved</legend>
          <div className="mf-line mf-campus" role="radiogroup" aria-label="Campus">
            <span className="mf-label">Campus</span>
            {campuses.map((c) => <Radio key={c} name="campus" value={c} on={f.campus === c} onPick={set('campus')}>{c}</Radio>)}
            <Radio name="campus" value={OTHER_CAMPUS} on={f.campus === OTHER_CAMPUS} onPick={set('campus')}>Another campus</Radio>
            {f.campus === OTHER_CAMPUS && <input className="input mf-inline" aria-label="Another campus" value={f.campusOther} onChange={set('campusOther')} maxLength={120} />}
            {f.campus && <button type="button" className="btn btn-quiet ops-tap" onClick={() => setF((x) => ({ ...x, campus: '', campusOther: '' }))}>Clear</button>}
          </div>
          <div className="mf-line">
            <span className="mf-label">Get involved</span>
            <Check on={f.volunteer} onChange={set('volunteer')}>I’d like to volunteer</Check>
            <Check on={f.candidate} onChange={set('candidate')}>Interested in being a candidate</Check>
            <Check on={Boolean(f.sign)} onChange={(on) => set('sign')(on ? 'lawn' : '')}>A sign</Check>
            {f.sign && (
              <select className="input mf-inline" aria-label="Which sign" value={f.sign} onChange={set('sign')}>
                {SIGNS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            )}
          </div>
        </fieldset>

        <fieldset className="card mf-sec">
          <legend>Languages · Interests</legend>
          <div className="mf-grid">
            {langs.map((l) => <Check key={l} on={f.languages.includes(l)} onChange={flip('languages', l)}>{l}</Check>)}
            <label className="mf-check mf-other">Other: <input className="input mf-inline" aria-label="Other language" value={f.otherLang} onChange={set('otherLang')} maxLength={80} /></label>
          </div>
          <div className="mf-grid mf-grid--wide">
            {interests.map((i) => <Check key={i} on={f.interests.includes(i)} onChange={flip('interests', i)}>{i}</Check>)}
          </div>
        </fieldset>

        <fieldset className="card mf-sec">
          <legend>Membership contribution</legend>
          <div className="mf-line" role="radiogroup" aria-label="Membership">
            <span className="mf-label">Membership</span>
            {form.terms.map((t) => <Radio key={t} name="term" value={String(t)} on={f.term === String(t)} onPick={set('term')}>{t} year{t > 1 ? 's' : ''}</Radio>)}
            {f.term && <button type="button" className="btn-link" onClick={() => set('term')('')}>Clear</button>}
            {f.term && <span className="mf-hint">At least {dollars(minimum)} ({dollars(rate)} a year{youth ? `, aged ${youthFrom} to ${youthTo}` : ''})</span>}
          </div>
          <div className="mf-give">
            {[['once', 'Give once', form.once, 'onceOther'], ['monthly', 'Give monthly', form.monthly, 'monthlyOther']].map(([k, title, amounts, other]) => (
              <div key={k} className="mf-col" role="radiogroup" aria-label={title}>
                <h3>{title}</h3>
                {/* A club has an amount only when the year's limit is known. */}
                {clubs.filter((c) => c[`${k}_cents`] != null).map((c) => (
                  <Radio key={c.key} name={k} value={c.key} on={f[k] === c.key} onPick={set(k)}>{c.label} {dollars(c[`${k}_cents`])}</Radio>
                ))}
                <div className="mf-amounts">{amounts.map((a) => <Radio key={a} name={k} value={String(a)} on={f[k] === String(a)} onPick={set(k)}>{dollars(a)}</Radio>)}</div>
                <label className="mf-check mf-other"><input type="radio" name={k} checked={f[k] === 'other'} onChange={() => set(k)('other')} /> Other: $
                  <input className="input mf-inline mf-money" inputMode="decimal" aria-label={`${title}: other amount`} value={f[other]} onFocus={() => set(k)('other')} onChange={set(other)} />{k === 'monthly' ? ' a month' : ''}</label>
                {f[k] && <button type="button" className="btn-link" onClick={() => set(k)('')}>Clear</button>}
              </div>
            ))}
          </div>
          {(clubOf(f.once)?.schoolBoard || clubOf(f.monthly)?.schoolBoard) && <Check on={f.schoolBoard} onChange={set('schoolBoard')}>{form.schoolBoardLine}</Check>}
          {clubs.length > 0 && !asked.data?.clubs && asked.isSuccess && <p className="mf-hint">No contribution limit is on file for this year, so the club amounts can’t be shown — use Other.</p>}
          <div className="mf-line" role="radiogroup" aria-label="How they paid">
            <span className="mf-label">Paid by</span>
            {METHODS.map(([k, l]) => <Radio key={k} name="method" value={k} on={f.method === k} onPick={set('method')}>{l}</Radio>)}
          </div>
          {f.method === 'card' && <p className="mf-note">Run the card on the terminal, then black out the card number, expiry and CVV on the paper form. They’re never typed here.</p>}
          {f.method === 'pad' && <p className="mf-note">Keep the void cheque with the treasurer; the bank details aren’t typed here.</p>}
        </fieldset>

        <fieldset className="card mf-sec">
          <legend>Declaration</legend>
          <div className="mf-line">
            <Check on={f.signed} onChange={set('signed')}>Signed</Check>
            <label className="field mf-narrow">Date<input className="input" type="date" value={f.signedOn} max={today()} onChange={set('signedOn')} /></label>
          </div>
          <Check on={f.optIn} onChange={set('optIn')}>Emails and texts — joining opts them in (untick if they crossed it out)</Check>
          {(f.term || f.once || f.monthly) && !f.signed && <p className="mf-hint is-warn">A membership or a gift needs the declaration signed.</p>}
        </fieldset>

        {error && <p className="error" role="alert">{error}</p>}
        <div className="mf-foot">
          <button type="submit" className="btn btn-primary" disabled={busy || !online || (!personId && !f.first.trim() && !f.last.trim())}>{busy ? 'Saving…' : 'Save the form'}</button>
          {!online && <span className="muted">Needs signal</span>}
        </div>
      </form>
    </div>
  );
}
