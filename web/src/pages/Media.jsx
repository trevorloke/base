// Media — press releases to reporters and influencers, one tab of its own.
//   /media                 Releases: how many contacts, the last release and
//                          how it was opened, sends not gone yet; More: past
//                          releases. "Write a release" (?new=1): To (Media ·
//                          Influencers · Both), From, subject, message with
//                          pictures, files (video is a link), a test, Send.
//   /media/contacts        who is on the media list, why someone won't get
//                          releases, a contact's sheet (socials open their
//                          profile, to message them), Add a contact (desk)
//   /media/releases/:id    one release: who got it, opened it, bounced;
//                          Try again; Copy links (the video, the Drive folder);
//                          Use again (its words in a new release)
//   /media/templates       release templates (components/EmailTemplates.jsx)
// Everything reads /api/media (server/ext/media) and writes media.* — so
// someone given Media but not Outreach can do the whole job. Only the desk
// (manager, staff, treasurer) sees contacts' emails and phones, and adds or
// changes contacts; the server strips and refuses the same.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useOutletContext, useParams, useSearchParams, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SOCIAL_PLATFORMS } from '@starbase/shared/canvass';
import { platformWord, profileUrl, shownHandle } from '@starbase/shared/socials';
import { renderMarkdown } from '@starbase/shared/markdown';
import { action, apiGet } from '../api.js';
import { OpensNote, TestingList, fmtTime } from '../components/AbTests.jsx';
import { NeedsSignal, useOnline } from '../components/NoSignal.jsx';
import { LOADING, Unavailable, fmt } from '../components/AudienceBits.jsx';
import { MEDIA_SCOPE, SendScope } from '../components/SendScope.js';
import { useSenders } from '../components/SenderPick.jsx';
import {
  BlastResult, Big, ComposeCard, FailedList, More, PastList, UnsentList, copyText, fmtWhen, useAction, useBlastList,
} from './Outreach.jsx';
import { TemplatesScreen } from '../components/EmailTemplates.jsx';
import '../editor.css';
import './media.css';

const DESK_ROLES = ['manager', 'treasurer', 'staff'];
const plural = (n, one, many) => (n === 1 ? one : many);
const MEDIA_ACTIONS = { send: 'media.send', test: 'media.test', attach: 'media.attach', unattach: 'media.unattach', picture: 'media.picture' };
const FILES_HINT = 'Photos and PDFs up to 5 MB. Video: paste a link (YouTube, Vimeo, Drive).';
const TO = [
  { key: 'media', label: 'Media', kinds: ['media'], count: 'media', noun: ['media contact', 'media contacts'] },
  { key: 'influencer', label: 'Influencers', kinds: ['influencer'], count: 'influencer', noun: ['influencer', 'influencers'] },
  { key: 'both', label: 'Both', kinds: ['media', 'influencer'], count: 'all', noun: ['contact', 'contacts'] },
];
// Why a release won't reach someone (server lib/reach.js whyNot), in words.
const WHY = {
  no_email: 'no email', do_not_email: 'asked not to be emailed', do_not_contact: 'asked not to be contacted', suppressed: 'address bounced',
  left_media: 'unsubscribed from releases',
};
// A handle → its profile page and its shown name: social links' own helper,
// so Media's links are the same as a person's page.
const platformLabel = platformWord;
const socialsOf = (p) => SOCIAL_PLATFORMS.filter((k) => typeof p?.socials?.[k] === 'string' && p.socials[k].trim()).map((k) => [k, p.socials[k]]);
const addrOf = (raw) => (/<([^>]+)>/.exec(raw || '') || [null, raw || null])[1];
// Every http(s) link in a release's body, once each, in order.
const linksIn = (body) => [...new Set((String(body || '').match(/https?:\/\/[^\s)<>\]"']+/gi) || []).map((u) => u.replace(/[.,;:!?]+$/, '')))];
const fmtShort = (ts) => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.toLocaleDateString('en-CA', { day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' })}`;
};

// Wide enough for the desk table: 1000 px and up, since the side menu takes
// about 230 of them (narrower, the table could only fit by breaking words).
function useWide() {
  const q = '(min-width: 1000px)';
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(q).matches);
  useEffect(() => {
    const m = window.matchMedia?.(q);
    if (!m) return undefined;
    const on = () => setWide(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return wide;
}

const useContacts = () => useQuery({ queryKey: ['media', 'contacts'], queryFn: () => apiGet('/media/contacts') });

// ─────────────────────────────────────────────────────────────────────────────
// Releases
// ─────────────────────────────────────────────────────────────────────────────
function Counts({ contacts }) {
  const c = contacts.data?.counts;
  if (!c) return <Big n={null} q={contacts} one="" many="" />;
  return (
    <p className="ot-big md-big">
      <span className="n">{fmt(c.media)}</span>
      <span className="lbl">{plural(c.media, 'media contact', 'media contacts')} · {fmt(c.influencer)} {plural(c.influencer, 'influencer', 'influencers')}</span>
    </p>
  );
}

// The last release that went out: subject, when, and "18 of 24 opened" as a bar.
function LastRelease({ releases, skip }) {
  const b = (releases || []).find((x) => Number(x.sent_count) > 0);
  if (!b || b.id === skip) return null;
  const sent = Number(b.sent_count) || 0;
  const opened = Number(b.opened) || 0;
  const pct = sent ? Math.round((100 * opened) / sent) : 0;
  return (
    <section className="ot-sec" aria-label="Last release">
      <h2 className="ot-sec-h">Last release</h2>
      <Link className="card md-last" to={`/media/releases/${b.id}`}>
        <span className="md-last__subject">{b.subject}</span>
        <span className="md-last__when">Sent {fmtWhen(b.sent_at || b.created_at)}</span>
        <span className="md-bar" role="img" aria-label={`${opened} of ${sent} opened`}>
          <span className="md-bar__fill" style={{ width: `${pct}%` }} />
        </span>
        <span className="md-last__open">{fmt(opened)} of {fmt(sent)} opened</span>
      </Link>
    </section>
  );
}

function ReleasesTab({ creating, onClose }) {
  const list = useBlastList();
  const contacts = useContacts();
  const [result, setResult] = useState(null);
  const [to, setTo] = useState('media');
  const releases = list.data?.releases;
  const emailConfigured = list.data?.emailConfigured;
  const pick = TO.find((t) => t.key === to);
  const emailable = contacts.data?.counts?.emailable;
  const count = emailable ? emailable[pick.count] : null;
  const n = (t) => (emailable ? fmt(emailable[t.count]) : '…');

  return (
    <>
      {creating && (
        <div className="card ot-audience">
          <div className="field">
            <span className="md-label" id="md-to">To</span>
            <div className="md-chips" role="radiogroup" aria-labelledby="md-to">
              {TO.map((t) => (
                <button key={t.key} type="button" role="radio" aria-checked={to === t.key} className={`chip md-chip${to === t.key ? ' is-on' : ''}`}
                  onClick={() => setTo(t.key)}>
                  {t.label} ({n(t)})
                </button>
              ))}
            </div>
            {contacts.isError && <span className="error" role="alert"><Unavailable onRetry={() => contacts.refetch()} /></span>}
            <span className="ops-meta">Anyone who asked not to be emailed or contacted is left out.</span>
          </div>
        </div>
      )}
      {creating && (
        <ComposeCard
          kind="press"
          audienceCount={count}
          audienceNoun={{ one: pick.noun[0], many: pick.noun[1] }}
          emptyReason={<>No one to send to yet. <Link to="/media/contacts">Contacts</Link></>}
          emailConfigured={emailConfigured}
          actions={MEDIA_ACTIONS}
          listKey={MEDIA_SCOPE.listKey}
          extra={{ to: { kinds: pick.kinds } }}
          senderUse="press"
          confirmFrom
          sendLabel={count == null ? 'Send' : `Send to ${fmt(count)}`}
          filesHint={FILES_HINT}
          onCancel={onClose}
          onSent={(b) => { setResult(b); onClose(); }}
        />
      )}
      <BlastResult blast={result} emailConfigured={emailConfigured} canWrite onDismiss={() => setResult(null)} onRetried={setResult} />
      {!creating && (
        <>
          <Counts contacts={contacts} />
          {list.isPending && <p className="ot-note" role="status">{LOADING}</p>}
          {list.isError && <p className="error" role="alert"><Unavailable onRetry={() => list.refetch()} /></p>}
          {list.isSuccess && !(releases || []).length && <p className="ot-empty">No releases yet.</p>}
          <FailedList blasts={releases} kind="press" emailConfigured={emailConfigured} canWrite skip={result?.id}
            linkTo={(b) => `/media/releases/${b.id}`} />
          <LastRelease releases={releases} skip={result?.id} />
          <UnsentList blasts={releases} kind="press" emailConfigured={emailConfigured} canWrite onResent={setResult} />
          <TestingList blasts={releases} kind="press" skip={result?.id} />
          {(releases || []).length > 0 && (
            <More>
              <section className="ot-sec" aria-label="Past releases">
                <h2 className="ot-sec-h">Past releases</h2>
                <PastList blasts={releases} loading={list.isPending} kindFilter="press" emailConfigured={emailConfigured} canWrite
                  linkTo={(b) => `/media/releases/${b.id}`} />
                <OpensNote />
              </section>
            </More>
          )}
        </>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Contacts
// ─────────────────────────────────────────────────────────────────────────────
function WontGet({ c }) {
  if (c.reachable) return null;
  return <span className="chip chip-warn md-wont">Won’t get releases: {WHY[c.why] || 'can’t be emailed'}</span>;
}
function Handles({ person, max = Infinity }) {
  const list = socialsOf(person).slice(0, max);
  if (!list.length) return null;
  return (
    <span className="md-handles">
      {list.map(([p, v]) => {
        const url = profileUrl(p, v);
        const label = `${platformLabel(p)} ${shownHandle(p, v)}`;
        return url
          ? <a key={p} href={url} target="_blank" rel="noopener noreferrer" aria-label={`${label} (opens a new tab)`} title={shownHandle(p, v)}>{shownHandle(p, v)}</a>
          : <span key={p} title={shownHandle(p, v)}>{shownHandle(p, v)}</span>;
      })}
    </span>
  );
}
const lastWords = (c) => (c.last ? (c.last.bounced ? 'Bounced' : c.last.opened ? 'Opened' : 'Not opened') : '—');
const subOf = (c) => {
  const first = socialsOf(c.person)[0];
  return [c.outlet || (c.kind === 'influencer' && first ? shownHandle(first[0], first[1]) : null), c.beat].filter(Boolean).join(' · ');
};

// A contact's sheet, in place: everything on file, Edit, Open profile, Take off.
function Sheet({ c, desk, onClose, onChanged }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [form, setForm] = useState({ kind: c.kind, outlet: c.outlet || '', beat: c.beat || '', note: c.note || '' });
  const ref = useRef(null);
  const online = useOnline();
  useEffect(() => { ref.current?.focus(); }, [c.person.id]);
  const act = useAction(() => qc.invalidateQueries({ queryKey: ['media'] }));
  const save = async (e) => {
    e.preventDefault();
    const r = await act.run('media.contact.save', { person_id: c.person.id, ...form });
    if (r) { setEditing(false); onChanged?.('Saved'); }
  };
  const takeOff = async () => {
    const r = await act.run('media.contact.remove', { person_id: c.person.id });
    if (r) { onChanged?.(`${c.person.name} is off the media list`); onClose(); }
  };
  const p = c.person;
  return (
    <section className="card md-sheet" aria-label={`${p.name}`}>
      <div className="md-sheet__head">
        <h2 className="md-sheet__name" tabIndex={-1} ref={ref}>{p.name}</h2>
        <button type="button" className="btn btn-quiet ot-btn-tap" onClick={onClose}>Close</button>
      </div>
      <WontGet c={c} />
      {!editing ? (
        <dl className="md-dl">
          <div><dt>Kind</dt><dd>{c.kind === 'media' ? 'Media' : 'Influencer'}</dd></div>
          {c.outlet && <div><dt>Outlet</dt><dd>{c.outlet}</dd></div>}
          {c.beat && <div><dt>Beat</dt><dd>{c.beat}</dd></div>}
          {desk && <div><dt>Email</dt><dd className="md-wrap">{p.email ? <a href={`mailto:${p.email}`}>{p.email}</a> : '—'}</dd></div>}
          {desk && <div><dt>Phone</dt><dd>{p.phone ? <a href={`tel:${p.phone}`}>{p.phone}</a> : '—'}</dd></div>}
          {socialsOf(p).length > 0 && <div><dt>Socials</dt><dd><Handles person={p} /></dd></div>}
          {c.note && <div><dt>Note</dt><dd className="md-note">{c.note}</dd></div>}
          {(p.tags || []).length > 0 && <div><dt>Tags</dt><dd className="md-tags">{p.tags.map((t) => <span key={t} className="chip">{t}</span>)}</dd></div>}
          {c.last && <div><dt>Last release</dt><dd><Link to={`/media/releases/${c.last.release_id}`}>{c.last.subject}</Link> · {lastWords(c)}</dd></div>}
        </dl>
      ) : (
        <form className="md-form" onSubmit={save}>
          <KindChips value={form.kind} onChange={(kind) => setForm({ ...form, kind })} />
          <div className="field"><label htmlFor="md-e-outlet">Outlet</label>
            <input id="md-e-outlet" className="input" maxLength={160} value={form.outlet} onChange={(e) => setForm({ ...form, outlet: e.target.value })} /></div>
          <div className="field"><label htmlFor="md-e-beat">Beat</label>
            <input id="md-e-beat" className="input" maxLength={160} value={form.beat} onChange={(e) => setForm({ ...form, beat: e.target.value })} /></div>
          <div className="field"><label htmlFor="md-e-note">Note</label>
            <textarea id="md-e-note" className="input" rows={3} maxLength={500} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></div>
          <p className="ops-meta md-where">Email, phone and socials: <Link to={`/people/${p.id}`}>Open profile</Link></p>
          <div className="md-acts">
            <button type="submit" className="btn ot-solid ot-btn-tap" disabled={act.busy || !online}>{act.busy ? 'Saving…' : 'Save'}</button>
            <button type="button" className="btn btn-quiet ot-btn-tap" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </form>
      )}
      {!editing && (
        <div className="md-acts">
          {desk && <button type="button" className="btn ot-btn-tap" onClick={() => setEditing(true)}>Edit</button>}
          <Link className="btn btn-quiet ot-btn-tap" to={`/people/${p.id}`}>Open profile</Link>
          {desk && !confirming && <button type="button" className="btn btn-quiet ot-btn-tap" onClick={() => setConfirming(true)}>Take off the media list</button>}
        </div>
      )}
      {confirming && (
        <div className="ot-confirm" role="group" aria-label="Confirm take off">
          <span>Take {p.name} off the media list? They stay in People.</span>
          <button type="button" className="btn btn-quiet ot-btn-tap" disabled={act.busy || !online} onClick={takeOff}>Yes, take off</button>
          <button type="button" className="btn btn-quiet ot-btn-tap" onClick={() => setConfirming(false)}>No</button>
          {!online && <NeedsSignal className="ot-confirm-note" />}
        </div>
      )}
      {act.error && <p className="error" role="alert">{act.error}</p>}
    </section>
  );
}

function KindChips({ value, onChange }) {
  return (
    <div className="md-chips" role="radiogroup" aria-label="Kind">
      {[['media', 'Media'], ['influencer', 'Influencer']].map(([k, label]) => (
        <button key={k} type="button" role="radio" aria-checked={value === k} className={`chip md-chip${value === k ? ' is-on' : ''}`} onClick={() => onChange(k)}>{label}</button>
      ))}
    </div>
  );
}

// Add a contact (desk): name, kind, email, outlet; the rest under More.
function AddContact({ onClose, onAdded }) {
  const qc = useQueryClient();
  const online = useOnline();
  const [f, setF] = useState({ name: '', kind: 'media', email: '', outlet: '', phone: '', beat: '', note: '' });
  // Socials, one row per network, as on a person's page: an influencer is
  // often on two or three.
  const [socials, setSocials] = useState([{ platform: 'instagram', handle: '' }]);
  const setSocial = (i, k) => (e) => setSocials(socials.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)));
  const unused = SOCIAL_PLATFORMS.filter((p) => !socials.some((x) => x.platform === p));
  const filled = Object.fromEntries(socials.filter((x) => x.handle.trim()).map((x) => [x.platform, x.handle.trim()]));
  const act = useAction(() => qc.invalidateQueries({ queryKey: ['media'] }));
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    const r = await act.run('media.contact.add', {
      name: f.name.trim(), kind: f.kind,
      ...(f.email.trim() ? { email: f.email.trim() } : {}),
      ...(f.phone.trim() ? { phone: f.phone.trim() } : {}),
      ...(f.outlet.trim() ? { outlet: f.outlet.trim() } : {}),
      ...(f.beat.trim() ? { beat: f.beat.trim() } : {}),
      ...(f.note.trim() ? { note: f.note.trim() } : {}),
      ...(Object.keys(filled).length ? { socials: filled } : {}),
    });
    if (r) onAdded(r.existing ? 'Already in People — added to the media list' : `Added ${f.name.trim()}`);
  };
  return (
    <form className="card md-sheet md-form" onSubmit={submit} aria-label="Add a contact">
      <h2 className="md-sheet__name">Add a contact</h2>
      <div className="field"><label htmlFor="md-a-name">Name</label>
        <input id="md-a-name" className="input" autoFocus required maxLength={300} value={f.name} onChange={set('name')} /></div>
      <KindChips value={f.kind} onChange={(kind) => setF({ ...f, kind })} />
      <div className="field"><label htmlFor="md-a-email">Email</label>
        <input id="md-a-email" className="input" type="email" maxLength={320} autoCapitalize="none" spellCheck={false} value={f.email} onChange={set('email')} placeholder="name@example.org" /></div>
      <div className="field"><label htmlFor="md-a-outlet">Outlet</label>
        <input id="md-a-outlet" className="input" maxLength={160} value={f.outlet} onChange={set('outlet')} placeholder="Newspaper, station or channel" /></div>
      <More>
        <div className="field"><label htmlFor="md-a-phone">Phone</label>
          <input id="md-a-phone" className="input" type="tel" maxLength={40} value={f.phone} onChange={set('phone')} /></div>
        <div className="field"><label htmlFor="md-a-beat">Beat</label>
          <input id="md-a-beat" className="input" maxLength={160} value={f.beat} onChange={set('beat')} placeholder="City hall" /></div>
        <div className="field md-social">
          <label htmlFor="md-a-handle-0">Socials</label>
          {socials.map((x, i) => (
            <div key={i} className="md-social__row">
              <select className="input" aria-label={`Network ${i + 1}`} value={x.platform} onChange={setSocial(i, 'platform')}>
                {SOCIAL_PLATFORMS.filter((p) => p === x.platform || !socials.some((y) => y.platform === p)).map((p) => <option key={p} value={p}>{platformLabel(p)}</option>)}
              </select>
              <input id={`md-a-handle-${i}`} className="input" maxLength={300} aria-label={`${platformLabel(x.platform)} handle or link`} value={x.handle} onChange={setSocial(i, 'handle')}
                placeholder={x.platform === 'other' ? 'https://…' : '@handle or link'} />
            </div>
          ))}
          {unused.length > 0 && (
            <button type="button" className="btn btn-quiet ot-btn-tap md-social__more" onClick={() => setSocials([...socials, { platform: unused[0], handle: '' }])}>Add another</button>
          )}
        </div>
        <div className="field"><label htmlFor="md-a-note">Note</label>
          <textarea id="md-a-note" className="input" rows={3} maxLength={500} value={f.note} onChange={set('note')} /></div>
      </More>
      {act.error && <p className="error" role="alert">{act.error}</p>}
      <div className="md-acts">
        <button type="submit" className="btn ot-solid ot-btn-tap" disabled={act.busy || !f.name.trim() || !online}>{act.busy ? 'Adding…' : 'Add'}</button>
        <button type="button" className="btn btn-quiet ot-btn-tap" onClick={onClose}>Cancel</button>
        {!online && <NeedsSignal className="ot-confirm-note" />}
      </div>
    </form>
  );
}

function ContactsTab({ desk, adding, onCloseAdd, toast }) {
  const contacts = useContacts();
  const wide = useWide();
  const [filter, setFilter] = useState('all');
  const [moreBeats, setMoreBeats] = useState(false);
  const [open, setOpen] = useState(null);
  const all = contacts.data?.contacts || [];
  const beats = useMemo(() => [...new Set(all.map((c) => (c.beat || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [all]);
  const shown = all.filter((c) => (filter === 'all' ? true : filter === 'media' || filter === 'influencer' ? c.kind === filter : (c.beat || '').trim() === filter.slice(5)));
  const current = open && all.find((c) => c.person.id === open);
  const chip = (key, label) => (
    <button key={key} type="button" role="radio" aria-checked={filter === key} className={`chip md-chip${filter === key ? ' is-on' : ''}`} onClick={() => setFilter(key)}>{label}</button>
  );
  const beatChips = moreBeats ? beats : beats.slice(0, 8);
  return (
    <>
      {adding && desk && <AddContact onClose={onCloseAdd} onAdded={(line) => { toast(line); onCloseAdd(); }} />}
      {current && <Sheet key={current.person.id} c={current} desk={desk} onClose={() => setOpen(null)} onChanged={toast} />}
      {contacts.isPending && <p className="ot-note" role="status">{LOADING}</p>}
      {contacts.isError && <p className="error" role="alert"><Unavailable onRetry={() => contacts.refetch()} /></p>}
      {contacts.isSuccess && all.length === 0 && <p className="ot-empty">No media contacts yet.</p>}
      {all.length > 0 && (
        <>
          <div className="md-chips md-filter" role="radiogroup" aria-label="Show">
            {chip('all', `All (${fmt(all.length)})`)}
            {chip('media', 'Media')}
            {chip('influencer', 'Influencers')}
            {beatChips.map((b) => chip(`beat:${b}`, b))}
            {beats.length > 8 && !moreBeats && <button type="button" className="chip md-chip" onClick={() => setMoreBeats(true)}>More</button>}
          </div>
          {wide ? (
            <table className={`table md-table${desk ? ' is-desk' : ''}`}>
              <thead>
                <tr>
                  <th className="md-c-name">Name</th><th className="md-c-outlet">Outlet</th><th className="md-c-beat">Beat</th>
                  {desk && <th className="md-c-email">Email</th>}{desk && <th className="md-c-phone">Phone</th>}
                  <th className="md-c-socials">Socials</th><th className="md-c-last">Last release</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.person.id} className="rowlink" data-open={open === c.person.id ? '' : undefined}>
                    <td className="md-who">
                      <button type="button" className="md-name" onClick={() => setOpen(c.person.id)}>{c.person.name}</button>
                      {c.kind === 'influencer' && <span className="chip md-kind">Influencer</span>}
                      <WontGet c={c} />
                    </td>
                    <td className="md-outlet">{c.outlet || ''}</td>
                    <td className="md-cut md-beat" title={c.beat || undefined}>{c.beat || ''}</td>
                    {desk && <td className="md-cut" title={c.person.email || undefined}>{c.person.email || '—'}</td>}
                    {desk && <td className="md-one">{c.person.phone || '—'}</td>}
                    <td><Handles person={c.person} /></td>
                    <td className="md-one">{lastWords(c)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <ul className="ot-list md-rows">
              {shown.map((c) => (
                <li key={c.person.id} className="ot-item">
                  <button type="button" className="ot-row md-row" aria-expanded={open === c.person.id} onClick={() => setOpen(c.person.id)}>
                    <span className="ot-row__main">
                      <span className="ot-row__name">{c.person.name}</span>
                      {subOf(c) && <span className="ot-row__sub"><span>{subOf(c)}</span></span>}
                      <WontGet c={c} />
                    </span>
                    {c.kind === 'influencer' && <span className="chip md-kind">Influencer</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {shown.length === 0 && <p className="ot-empty">No one here.</p>}
        </>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// A release's page
// ─────────────────────────────────────────────────────────────────────────────
const chipFor = (r) => {
  if (r.held) return ['chip', 'Waits for the winner'];
  if (r.status === 'sent' && r.bounced) return ['chip chip-danger', 'Bounced'];
  if (r.status === 'sent' && r.opened_at) return ['chip chip-ok', `Opened ${fmtTime(r.opened_at)}`];
  if (r.status === 'sent') return ['chip', 'Not opened'];
  if (r.status === 'sending') return ['chip chip-warn', 'Not sure'];
  return ['chip chip-warn', 'Didn’t go'];
};

// Its outcome is said by the page (onDone): once the rows went, this button goes.
function RetryRelease({ b, n, onDone }) {
  const qc = useQueryClient();
  const online = useOnline();
  const [confirming, setConfirming] = useState(false);
  const act = useAction(() => qc.invalidateQueries({ queryKey: ['media'] }));
  const go = async () => {
    const r = await act.run('media.resend', { id: b.id });
    setConfirming(false);
    if (r) onDone(`Tried again: ${fmt(r.resent?.sent ?? 0)} sent${r.resent?.failed ? `, ${fmt(r.resent.failed)} failed` : ''}.`);
  };
  return (
    <div className="md-retry">
      {!confirming ? (
        <button type="button" className="btn btn-primary ot-btn-tap" onClick={() => { setConfirming(true); act.clearError(); }}>Try again · {fmt(n)}</button>
      ) : (
        <div className="ot-confirm" role="group" aria-label="Confirm try again">
          <span>Send to <strong>{fmt(n)}</strong> {plural(n, 'contact', 'contacts')} now?</span>
          <button type="button" className="btn btn-primary ot-btn-tap" disabled={act.busy || !online} onClick={go}>{act.busy ? 'Sending…' : 'Yes, send'}</button>
          <button type="button" className="btn btn-quiet ot-btn-tap" disabled={act.busy} onClick={() => setConfirming(false)}>No</button>
          {!online && <NeedsSignal className="ot-confirm-note" />}
        </div>
      )}
      {act.error && <p className="error" role="alert">{act.error}</p>}
    </div>
  );
}

function CopyLinks({ links }) {
  const [said, setSaid] = useState(null);
  if (!links.length) return null;
  const go = async () => {
    const ok = await copyText(links.join('\n'));
    setSaid(ok ? `Copied ${links.length} ${plural(links.length, 'link', 'links')}` : 'Couldn’t copy — select them below');
  };
  return (
    <span className="md-copy">
      <button type="button" className="btn btn-quiet ot-btn-tap" onClick={go}>Copy links</button>
      <span className="md-copy__said" role="status" aria-live="polite">{said || ''}</span>
    </span>
  );
}

function ReleasePage({ id }) {
  const q = useQuery({ queryKey: ['media', 'release', id], queryFn: () => apiGet(`/media/releases/${id}`) });
  const senders = useSenders();
  const [said, setSaid] = useState(null);
  if (q.isPending) return <p className="ot-note" role="status">{LOADING}</p>;
  if (q.isError) return <p className="error" role="alert"><Unavailable onRetry={() => q.refetch()} /></p>;
  const b = q.data.release;
  const rows = q.data.recipients || [];
  const from = addrOf(b.from_addr) || senders.data?.system?.email || null;
  const links = linksIn(b.body);
  // The rest of an A/B send wait for the winner: not "didn't go", not to try again.
  const retry = Math.max(0, (Number(b.retry_count) || 0) - (Number(b.held_count) || 0));
  const testing = b.ab_status === 'testing';
  const figures = [['Sent', b.sent_count], ['Opened', b.opened], ['Clicked', b.clicked], ['Bounced', b.bounced]];
  return (
    <>
      <h2 className="md-subject">{b.subject}</h2>
      <p className="md-meta">
        {b.sent_at ? `Sent ${fmtShort(b.sent_at)}`
          : testing ? (b.first_sent_at ? `Testing two subject lines · first sent ${fmtShort(b.first_sent_at)}`
            : `Testing two subject lines · saved ${fmtShort(b.created_at)} — not sent yet`)
            : b.first_sent_at ? `First sent ${fmtShort(b.first_sent_at)}`
              : `Saved ${fmtShort(b.created_at)} — not sent`}
        {from && <> · from {from}</>}
      </p>
      <dl className="md-figs">
        {figures.map(([k, v]) => <div key={k} className="md-fig"><dt>{k}</dt><dd>{fmt(Number(v) || 0)}</dd></div>)}
      </dl>
      <div className="md-acts">
        <Link className="btn btn-quiet ot-btn-tap" to={`/media?new=1&again=${b.id}`}>Use again</Link>
        {retry > 0 && q.data.emailConfigured !== false && <RetryRelease b={b} n={retry} onDone={setSaid} />}
        <CopyLinks links={links} />
      </div>
      {said && <p className="ot-test-note md-said" role="status">{said}</p>}
      {retry > 0 && q.data.emailConfigured === false && <p className="ot-note">Email isn’t connected — nothing more can go yet.</p>}
      <section className="ot-sec" aria-label="Who it went to">
        <h2 className="ot-sec-h">Who it went to <span className="ot-count">{fmt(rows.length)}</span></h2>
        <ul className="ot-list">
          {rows.map((r) => {
            const [cls, words] = chipFor(r);
            return (
              <li key={`${r.person_id}-${r.name}`} className="ot-item">
                <div className="ot-row ot-row--static">
                  <span className="ot-row__main">
                    <span className="ot-row__name">{r.name || 'Someone no longer on file'}</span>
                    {r.outlet && <span className="ot-row__sub"><span>{r.outlet}</span></span>}
                  </span>
                  <span className={cls}>{words}</span>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
      <More>
        <section className="ot-sec" aria-label="The message as sent">
          <h2 className="ot-sec-h">The message as sent</h2>
          {/* As the reader saw it: pictures as pictures, links as links (the
              compose's Preview renderer, which keeps only safe tags). */}
          <div className="md-body ws-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(b.body) }} />
          {(b.attachments || []).length > 0 && <p className="ot-note">Files: {b.attachments.map((a) => a.filename).join(', ')}</p>}
          {links.length > 0 && <ul className="md-links">{links.map((l) => <li key={l}><a href={l} target="_blank" rel="noopener noreferrer">{l}</a></li>)}</ul>}
        </section>
      </More>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The screen
// ─────────────────────────────────────────────────────────────────────────────
export default function Media() {
  const { me } = useOutletContext();
  const { id } = useParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [toastMsg, setToastMsg] = useState(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const toast = (m) => { clearTimeout(timer.current); setToastMsg(m); timer.current = setTimeout(() => setToastMsg(null), 3500); };
  const desk = DESK_ROLES.includes(me.role);
  const tab = id ? 'release' : /\/media\/contacts/.test(pathname) ? 'contacts' : /\/media\/templates/.test(pathname) ? 'templates' : 'releases';
  const creating = params.get('new') === '1';
  const openNew = () => setParams({ new: '1' });
  const closeNew = () => setParams({}, { replace: true });
  const primary = tab === 'releases' && !creating ? 'Write a release' : tab === 'contacts' && desk && !creating ? 'Add a contact' : null;
  if (tab === 'templates') return <TemplatesScreen use="press" />;
  return (
    <SendScope.Provider value={MEDIA_SCOPE}>
      <div className="ot-page md-page">
        <div className="ot-top">
          <h1>Media</h1>
          {primary && <button type="button" className="btn btn-primary ot-btn-tap" onClick={openNew}>{primary}</button>}
          {tab === 'releases' && !creating && <Link className="btn btn-quiet ot-btn-tap md-templates" to="/media/templates">Templates</Link>}
        </div>
        <nav className="ot-tabs md-tabs" aria-label="Media: releases and contacts" style={{ '--ot-tabs': 2 }}>
          {[['releases', 'Releases', '/media'], ['contacts', 'Contacts', '/media/contacts']].map(([k, label, to]) => {
            const on = tab === k || (k === 'releases' && tab === 'release');
            return (
              <Link key={k} to={to} className={`ot-tab${on ? ' active' : ''}`} aria-current={on ? 'page' : undefined}>
                <span className="ot-tab-label">{label}</span>
              </Link>
            );
          })}
        </nav>
        {tab === 'release' && (
          <p className="ot-note"><button type="button" className="md-back" onClick={() => navigate('/media')}>← Releases</button></p>
        )}
        {tab === 'releases' && <ReleasesTab creating={creating} onClose={closeNew} />}
        {tab === 'contacts' && <ContactsTab desk={desk} adding={creating} onCloseAdd={closeNew} toast={toast} />}
        {tab === 'release' && <ReleasePage id={id} />}
        <div className="md-live" role="status" aria-live="polite">
          {toastMsg && (
            <div className="toast ot-toast">
              <span>{toastMsg}</span>
              <button type="button" className="btn ot-btn-tap" onClick={() => setToastMsg(null)}>OK</button>
            </div>
          )}
        </div>
      </div>
    </SendScope.Provider>
  );
}
