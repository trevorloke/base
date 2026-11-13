// Email templates (server/ext/templates): the campaign's own and the
// ready-made ones (@starbase/shared/email/starters), for newsletters and
// emails to a list (use 'email', Outreach) and press releases ('press', Media).
//   useTemplates(use)   GET /templates?use=… — the lists, canSave, canHide,
//                       foot (the lines under every email) and links (the
//                       website's pages, for "Link to…")
//   loadTemplate()      one template's words (GET /templates/:ref), from the
//                       cache when it's there — no signal and not cached:
//                       "Needs signal"
//   StartFrom           the compose's first field: a blank email, or one of them
//   SaveAsTemplate      the compose's "Save as template" row (and "Update …")
//   FootBlock           the email's bottom lines, ending the Preview
//   TemplatesScreen     /outreach/templates and /media/templates: look after them
// Words are shown as words ("[first name]") and saved as codes.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { EMAIL_FILLS, toCodes, toWords } from '@starbase/shared/email/words';
import { renderMarkdown } from '@starbase/shared/markdown';
import { ApiError, action, apiGet } from '../api.js';
import { LOADING, Unavailable, fmt } from './AudienceBits.jsx';
import { NeedsSignal, useOnline } from './NoSignal.jsx';
import { MarkdownField, uploadImage } from './MarkdownField.jsx';
import { More } from '../pages/Outreach.jsx';
import './templates.css';

export const useOf = (kind) => (kind === 'press' ? 'press' : 'email');
const WORDS = {
  email: { blank: 'A blank email', title: 'Email templates', write: 'Write an email from this', back: ['/outreach/email', '← Outreach'] },
  press: { blank: 'A blank release', title: 'Release templates', write: 'Write a release from this', back: ['/media', '← Releases'] },
};
export const composeFrom = (use, ref) => (use === 'press'
  ? `/media?new=1&template=${encodeURIComponent(ref)}`
  : `/outreach/email?new=1&template=${encodeURIComponent(ref)}`);
const NAME_MAX = 80;
const NEEDS_SIGNAL = 'Needs signal';

export const useTemplates = (use, enabled = true) => useQuery({
  queryKey: ['templates', use],
  queryFn: () => apiGet(`/templates?use=${use}`),
  enabled,
});
const oneKey = (ref) => ['templates', 'one', ref];
export async function loadTemplate(qc, ref, { fresh = false } = {}) {
  const kept = !fresh && qc.getQueryData(oneKey(ref));
  if (kept) return kept;
  try {
    return await qc.fetchQuery({ queryKey: oneKey(ref), queryFn: () => apiGet(`/templates/${encodeURIComponent(ref)}`), staleTime: 0 });
  } catch (err) {
    if (!(err instanceof ApiError)) throw new Error(NEEDS_SIGNAL);
    throw err;
  }
}
// The starters shown (a manager's hidden ones are flagged, not shown).
const shownStarters = (data) => (data?.starters || []).filter((s) => !s.hidden);

// "12 ready-made · 3 of your own — start an email from one", under Lists.
export function TemplatesRow() {
  const q = useTemplates('email');
  const sub = q.data
    ? `${fmt(shownStarters(q.data).length)} ready-made · ${fmt(q.data.mine.length)} of your own`
    : q.isError ? 'Unavailable' : LOADING;
  return (
    <li className="ot-item">
      <Link className="ot-row" to="/outreach/templates">
        <span className="ot-row__main">
          <span className="ot-row__name">Templates</span>
          <span className="ot-row__sub"><span>{sub} — start an email from one</span></span>
        </span>
      </Link>
    </li>
  );
}

// ── In the compose ──

export function StartFrom({ kind, value, onChange }) {
  const use = useOf(kind);
  const q = useTemplates(use);
  const id = `${kind}-start`;
  const off = !q.data;
  return (
    <div className="field tp-start">
      <label htmlFor={id}>Start from</label>
      <select id={id} className="input" value={off ? '' : value} disabled={off} onChange={(e) => onChange(e.target.value)}>
        {q.isPending && <option value="">{LOADING}</option>}
        {q.isError && !q.data && <option value="">Templates unavailable</option>}
        {q.data && <option value="">{WORDS[use].blank}</option>}
        {q.data?.mine.length > 0 && (
          <optgroup label="Your templates">
            {q.data.mine.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </optgroup>
        )}
        {q.data && shownStarters(q.data).length > 0 && (
          <optgroup label="Ready-made">
            {shownStarters(q.data).map((s) => <option key={s.key} value={`starter:${s.key}`}>{s.name}</option>)}
          </optgroup>
        )}
      </select>
    </div>
  );
}

// The email's last lines, as base.win adds them at send.
export function FootBlock({ foot, kind }) {
  if (!foot) return null;
  const stop = (v) => String(v || '').trim().replace(/\.+$/, '');
  const where = [foot.address, foot.contact].map(stop).filter(Boolean);
  return (
    <p className="tp-foot" aria-label="Added at the bottom of every email">
      Sent by {foot.name}.{where.map((l) => ` ${l}.`).join('')}
      {stop(foot.auth) && <><br />{stop(foot.auth)}.</>}
      <br />{kind === 'press' ? 'Don’t want press releases? Unsubscribe' : 'Unsubscribe'}
    </p>
  );
}

// "Save as template" (a new one), and "Update “…”" when the email was
// started from one of the campaign's own. startedFrom: { ref, name, mine,
// version }; onUpdated(version) keeps the version for a second Update.
export function SaveAsTemplate({ kind, subject, body, startedFrom, onUpdated }) {
  const use = useOf(kind);
  const q = useTemplates(use);
  const qc = useQueryClient();
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState(null);
  if (!q.data?.canSave) return null;
  const filled = subject.trim() && body.trim();
  const words = { subject: toCodes(subject.trim()), body: toCodes(body.trim()) };
  const run = async (input, done) => {
    setBusy(true);
    setSaid(null);
    try {
      const r = await action('template.save', { use, ...words, ...input });
      qc.invalidateQueries({ queryKey: ['templates', use] });
      qc.removeQueries({ queryKey: oneKey(r.template.id) });
      done(r.template);
    } catch (err) {
      setSaid({ error: true, line: err.message });
    } finally {
      setBusy(false);
    }
  };
  const save = (e) => {
    e.preventDefault();
    run({ name: name.trim() }, (t) => { setOpen(false); setSaid({ line: `Saved as “${t.name}”` }); });
  };
  const update = () => run({ id: startedFrom.ref, name: startedFrom.name, seen: startedFrom.version }, (t) => {
    onUpdated?.(t.version);
    setSaid({ line: `Updated “${t.name}”` });
  });
  const off = !filled || busy || !online;
  return (
    <div className="tp-keep">
      {open ? (
        <div className="tp-keep__row" role="group" aria-label="Save as template">
          <label className="tp-keep__label" htmlFor={`${kind}-tp-name`}>Name</label>
          <input id={`${kind}-tp-name`} className="input tp-keep__name" value={name} maxLength={NAME_MAX} autoFocus
            onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(e); }} />
          <button type="button" className="btn ot-btn-tap" disabled={off || !name.trim()} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
          <button type="button" className="btn btn-quiet ot-btn-tap" onClick={() => setOpen(false)}>Cancel</button>
        </div>
      ) : (
        <div className="tp-keep__row">
          <button type="button" className="btn btn-quiet ot-btn-tap" disabled={off}
            onClick={() => { setName(subject.trim().slice(0, NAME_MAX)); setSaid(null); setOpen(true); }}>
            Save as template
          </button>
          {startedFrom?.mine && (
            <button type="button" className="btn btn-quiet ot-btn-tap" disabled={off} onClick={update}>
              {busy ? 'Saving…' : `Update “${startedFrom.name}”`}
            </button>
          )}
        </div>
      )}
      {!online && <NeedsSignal />}
      <span className={said?.error ? 'error' : 'tp-said'} role="status" aria-live="polite">{said?.line || ''}</span>
    </div>
  );
}

// ── The Templates screen ──

// One row's editor: Name, Subject, Message. t: null for a new one.
function Editor({ use, t, data, onSaved, onCancel, children }) {
  const qc = useQueryClient();
  const online = useOnline();
  const [name, setName] = useState(t?.name || '');
  const [subject, setSubject] = useState(toWords(t?.subject || ''));
  const [body, setBody] = useState(toWords(t?.body || ''));
  const [version, setVersion] = useState(t?.version);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState(null);
  const ids = `tp-${t?.ref || 'new'}`.replace(/[^a-z0-9-]/gi, '');
  const save = async () => {
    setBusy(true);
    setSaid(null);
    try {
      const r = await action('template.save', {
        use, name: name.trim(), subject: toCodes(subject.trim()), body: toCodes(body.trim()),
        ...(t ? { id: t.ref, seen: version } : {}),
      });
      setVersion(r.template.version);
      qc.invalidateQueries({ queryKey: ['templates', use] });
      // The open row keeps this editor (and its "Saved" line); the compose
      // reads it afresh.
      qc.setQueryData(oneKey(r.template.id), (old) => (old ? { ...old, ...r.template } : old));
      setSaid({ line: `Saved “${r.template.name}”` });
      onSaved?.(r.template);
    } catch (err) {
      setSaid({ error: true, line: err.message, stale: /changed this template/.test(err.message) });
    } finally {
      setBusy(false);
    }
  };
  const reload = async () => {
    setSaid(null);
    try {
      const fresh = await loadTemplate(qc, t.ref, { fresh: true });
      setName(fresh.name);
      setSubject(toWords(fresh.subject));
      setBody(toWords(fresh.body));
      setVersion(fresh.version);
    } catch (err) {
      setSaid({ error: true, line: err.message });
    }
  };
  return (
    <div className="tp-edit">
      <div className="field">
        <label htmlFor={`${ids}-name`}>Name</label>
        <input id={`${ids}-name`} className="input" value={name} maxLength={NAME_MAX} autoFocus={!t}
          onChange={(e) => setName(e.target.value.replace(/[\r\n]/g, ' '))} />
      </div>
      <div className="field">
        <label htmlFor={`${ids}-subject`}>Subject</label>
        <input id={`${ids}-subject`} className="input" value={subject} maxLength={300} onChange={(e) => setSubject(e.target.value)} />
      </div>
      <MarkdownField id={`${ids}-body`} label="Message" value={body} rows={12}
        onChange={(v) => setBody(v.slice(0, 50000))} fills={EMAIL_FILLS} links={data?.links}
        upload={(f) => uploadImage(f, use === 'press' ? 'media.picture' : 'blast.picture')} footer={<FootBlock foot={data?.foot} kind={use === 'press' ? 'press' : 'newsletter'} />} />
      <div className="tp-acts">
        <button type="button" className="btn btn-primary ot-btn-tap" disabled={busy || !online || !name.trim() || !body.trim()} onClick={save}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {!online && <NeedsSignal />}
        {children}
        {!t && <button type="button" className="btn btn-quiet ot-btn-tap" onClick={onCancel}>Cancel</button>}
      </div>
      <p className={said?.error ? 'error' : 'tp-said'} role="status" aria-live="polite">
        {said?.line || ''}
        {said?.stale && <> <button type="button" className="btn btn-quiet ot-btn-tap" onClick={reload}>Reload</button></>}
      </p>
    </div>
  );
}

// A row opened in place: its words (read now), then what can be done.
function Opened({ use, refKey, data, mine, onDone, toast }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const online = useOnline();
  const [asking, setAsking] = useState(false);
  const [said, setSaid] = useState(null);
  const one = useQuery({ queryKey: oneKey(refKey), queryFn: () => apiGet(`/templates/${encodeURIComponent(refKey)}`), staleTime: 0 });
  if (one.isPending) return <p className="ot-note" role="status">{LOADING}</p>;
  if (one.isError) return <p className="error" role="alert"><Unavailable onRetry={() => one.refetch()} /></p>;
  const t = one.data;
  const write = () => navigate(composeFrom(use, refKey));
  const run = async (name, input, after) => {
    setSaid(null);
    try {
      const r = await action(name, input);
      qc.invalidateQueries({ queryKey: ['templates', use] });
      after(r);
    } catch (err) {
      setSaid(err.message);
    }
  };
  const copy = () => run('template.copy', { from: refKey }, (r) => toast(`Copied as “${r.template.name}”`));
  const canSave = data.canSave;
  const writeBtn = (primary) => (
    <button type="button" className={`btn ${primary ? 'btn-primary' : 'btn-quiet'} ot-btn-tap`} onClick={write}>{WORDS[use].write}</button>
  );
  const copyBtn = canSave && <button type="button" className="btn btn-quiet ot-btn-tap" disabled={!online} onClick={copy}>Make a copy</button>;
  if (mine && canSave) {
    const remove = () => run('template.remove', { id: refKey }, () => {
      onDone();
      toast(`Removed “${t.name}”`, () => run('template.restore', { id: refKey }, () => toast(`“${t.name}” is back`)));
    });
    return (
      <Editor key={refKey} use={use} t={t} data={data}>
        {writeBtn(false)}
        {copyBtn}
        <More>
          {asking ? (
            <span className="tp-ask" role="group" aria-label="Remove">
              Remove “{t.name}”?
              <button type="button" className="btn btn-quiet ot-btn-tap" disabled={!online} onClick={remove}>Yes</button>
              <button type="button" className="btn btn-quiet ot-btn-tap" onClick={() => setAsking(false)}>No</button>
            </span>
          ) : (
            <button type="button" className="btn btn-quiet ot-btn-tap" disabled={!online} onClick={() => setAsking(true)}>Remove</button>
          )}
          {said && <p className="error" role="alert">{said}</p>}
        </More>
      </Editor>
    );
  }
  const key = refKey.startsWith('starter:') ? refKey.slice('starter:'.length) : null;
  const hide = () => run('template.starters', { key, hidden: true }, () => {
    onDone();
    toast('Hidden — find it under More', () => run('template.starters', { key, hidden: false }, () => toast(`“${t.name}” is back`)));
  });
  return (
    <div className="tp-view">
      <p className="tp-view__subject"><span className="tp-view__label">Subject</span> {toWords(t.subject)}</p>
      {/* eslint-disable-next-line react/no-danger -- the email's own renderer: every character is escaped first */}
      <div className="ws-md__preview-body ws-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(toWords(t.body)) }} />
      {key && <p className="ops-meta">Words in [brackets] are yours to fill in.</p>}
      <div className="tp-acts">
        {writeBtn(true)}
        {copyBtn}
        {key && data.canHide && <button type="button" className="btn btn-quiet ot-btn-tap" disabled={!online} onClick={hide}>Hide</button>}
        {!online && (canSave || data.canHide) && <NeedsSignal />}
      </div>
      {said && <p className="error" role="alert">{said}</p>}
    </div>
  );
}

function Row({ name, sub, chip, open, onToggle, children }) {
  return (
    <li className="ot-item">
      <button type="button" className="ot-row" aria-expanded={open} onClick={onToggle}>
        <span className="ot-row__main">
          <span className="ot-row__name">{name}</span>
          <span className="ot-row__sub">
            {chip && <span className="chip tp-chip">{chip}</span>}
            {sub.filter(Boolean).map((s) => <span key={s}>{s}</span>)}
          </span>
        </span>
      </button>
      {open && <div className="ot-body tp-body">{children}</div>}
    </li>
  );
}

const dayOf = (ts) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-CA', { day: 'numeric', month: 'short' });
};

export function TemplatesScreen({ use }) {
  const q = useTemplates(use);
  const qc = useQueryClient();
  const online = useOnline();
  const [open, setOpen] = useState(null);
  const [making, setMaking] = useState(false);
  const [note, setNote] = useState(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const toast = (msg, undo = null) => {
    clearTimeout(timer.current);
    setNote({ msg, undo });
    timer.current = setTimeout(() => setNote(null), 6000);
  };
  const w = WORDS[use];
  const data = q.data;
  const toggle = (ref) => { setMaking(false); setOpen((o) => (o === ref ? null : ref)); };
  const busy = open != null || making;
  const hidden = (data?.starters || []).filter((s) => s.hidden);
  const show = async (s) => {
    try {
      await action('template.starters', { key: s.key, hidden: false });
      qc.invalidateQueries({ queryKey: ['templates', use] });
      toast(`“${s.name}” is shown again`);
    } catch (err) {
      toast(err.message);
    }
  };
  return (
    <div className="ot-page tp-page">
      <div className="ot-top">
        <h1>{w.title}</h1>
        {data?.canSave && !busy && (
          <button type="button" className="btn btn-primary ot-btn-tap" disabled={!online} onClick={() => { setOpen(null); setMaking(true); }}>New template</button>
        )}
        {data?.canSave && !busy && !online && <NeedsSignal />}
      </div>
      <p className="ot-note"><Link to={w.back[0]}>{w.back[1]}</Link></p>
      {q.isPending && <p className="ot-note" role="status">{LOADING}</p>}
      {q.isError && !data && <p className="error" role="alert"><Unavailable onRetry={() => q.refetch()} /></p>}
      {making && (
        <section className="card tp-new" aria-label="New template">
          <Editor use={use} t={null} data={data} onCancel={() => setMaking(false)}
            onSaved={(t) => { setMaking(false); setOpen(t.id); toast(`Saved “${t.name}”`); }} />
        </section>
      )}
      {data && (
        <>
          <section className="ot-sec" aria-label="Your templates">
            <h2 className="ot-sec-h">Your templates <span className="ot-count">{fmt(data.mine.length)}</span></h2>
            {data.mine.length === 0 ? (
              <p className="ot-empty">No templates of your own yet. <span className="ops-meta">Save one from any email, or copy a ready-made one.</span></p>
            ) : (
              <ul className="ot-list">
                {data.mine.map((t) => (
                  <Row key={t.id} name={t.name} open={open === t.id} onToggle={() => toggle(t.id)}
                    sub={[toWords(t.subject), `Changed ${dayOf(t.updated_at)}${t.updated_by_name ? ` by ${t.updated_by_name}` : ''}`]}>
                    <Opened use={use} refKey={t.id} data={data} mine onDone={() => setOpen(null)} toast={toast} />
                  </Row>
                ))}
              </ul>
            )}
          </section>
          <section className="ot-sec" aria-label="Ready-made">
            <h2 className="ot-sec-h">Ready-made <span className="ot-count">{fmt(shownStarters(data).length)}</span></h2>
            <ul className="ot-list">
              {shownStarters(data).map((s) => {
                const ref = `starter:${s.key}`;
                return (
                  <Row key={s.key} name={s.name} chip="Ready-made" sub={[s.subject]} open={open === ref} onToggle={() => toggle(ref)}>
                    <Opened use={use} refKey={ref} data={data} mine={false} onDone={() => setOpen(null)} toast={toast} />
                  </Row>
                );
              })}
            </ul>
          </section>
          {data.canHide && hidden.length > 0 && (
            <More>
              <section className="ot-sec" aria-label="Hidden ready-made templates">
                <h2 className="ot-sec-h">Hidden ready-made templates</h2>
                <ul className="ot-list">
                  {hidden.map((s) => (
                    <li key={s.key} className="ot-item">
                      <div className="ot-row ot-row--static">
                        <span className="ot-row__main"><span className="ot-row__name">{s.name}</span></span>
                        <button type="button" className="btn btn-quiet ot-btn-tap" disabled={!online} onClick={() => show(s)}>Show</button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            </More>
          )}
        </>
      )}
      <div className="tp-live" role="status" aria-live="polite">
        {note && (
          <div className="toast ot-toast">
            <span>{note.msg}</span>
            {note.undo && <button type="button" className="btn ot-btn-tap" onClick={() => { const u = note.undo; setNote(null); u(); }}>Undo</button>}
            <button type="button" className="btn ot-btn-tap" onClick={() => setNote(null)}>OK</button>
          </div>
        )}
      </div>
    </div>
  );
}
