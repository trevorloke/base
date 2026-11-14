// A letter's page, the writer's own (/letters/:id; GET /api/letters/mine/:id).
// In order: a suggestion from the campaign (each change marked in place,
// Take or Leave, "Save my letter"; under More "Take all" and "Keep mine"),
// their letter (Edit), the notes; then the one thing to do now — "This is
// my final text" (a confirm, with the campaign's share of the words when
// it's 20% or more), "Send it" once Ready (the Send sheet: their own email
// opens with the paper's address, the subject and the agreed text; the
// text is copied first), or the published link once it's out.
// Edits, notes and "I sent it" go through the outbox (they may be typed in
// a dead zone); agreeing, details, withdraw and delete need signal.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { applyHunks, campaignShare, mailtoFor, mailtoMax, wordDiff } from '@starbase/shared/letters';
import { action, apiGet } from '../api.js';
import { newClientId, onOutboxSent, queueAction } from '../offline.js';
import { NeedsSignalLine, useOnline } from '../components/NoSignal.jsx';
import { clearDraft, copyText, readDraft, writeDraft } from '../components/letterDrafts.js';
import { queuedText } from '../components/queued.js';
import {
  CampaignWords, Count, KIND_WORDS, LOADING, More, STATUS_WORDS, Unavailable, dayWords, firstWords, rulesLine, useLetterOutlets,
} from '../components/LetterBits.jsx';

const OUT = ['sent', 'published', 'withdrawn'];
const pct = (x) => Math.round(x * 100);
const keepBody = (v) => Boolean(v?.queued || String(v?.body || '').trim());

// A draft kept on this phone (edit:<id>, note:<id>) a moment after each change.
function useKept(name, value, keep) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return undefined; }
    const t = setTimeout(() => (keep(value) ? writeDraft(name, value) : clearDraft(name)), 500);
    return () => clearTimeout(t);
  }, [name, value, keep]);
}

export default function LetterPage({ me, id }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['letters', 'mine', id], queryFn: () => apiGet(`/letters/mine/${id}`) });
  const l = q.data?.letter;
  const outletsQ = useLetterOutlets(me, l?.kind || 'letter');
  const [said, setSaid] = useState(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['letters'] });
    qc.invalidateQueries({ queryKey: ['brief'] });
  };
  // Read is seen (the server stamps it): the list's and Today's "Reply" go.
  const loaded = Boolean(q.data);
  useEffect(() => {
    if (!loaded) return;
    qc.invalidateQueries({ queryKey: ['letters', 'mine'], exact: true });
    qc.invalidateQueries({ queryKey: ['brief'] });
  }, [loaded, id, qc]);
  // Something of this letter reached the server from the outbox: read it again.
  useEffect(() => onOutboxSent(({ name, input }) => {
    if (name.startsWith('myletter.') && input?.id === id) refresh();
  }), [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (q.isPending) return <Page><p className="ops-meta" role="status">{LOADING}</p></Page>;
  if (q.isError) {
    return <Page><p className="error" role="alert">{q.error?.status === 404 ? 'This letter isn’t here.' : <Unavailable onRetry={() => q.refetch()} />}</p></Page>;
  }
  return <Letter me={me} l={l} outletsQ={outletsQ} said={said} setSaid={setSaid} refresh={refresh} />;
}

function Page({ children }) {
  return (
    <div className="ops-page lt-page">
      <Link to="/letters" className="ops-back">← Letters</Link>
      {children}
    </div>
  );
}

function Letter({ me, l, outletsQ, said, setSaid, refresh }) {
  // Papers the server dropped when the letter landed (taken off the list
  // while it waited on the phone): said once, as the letter opens.
  const dropped = [...(useLocation().state?.dropped || []), ...(l.dropped_outlets || [])];
  const drafts = l.drafts || [];
  const newest = drafts[drafts.length - 1] || null;
  const writerDrafts = drafts.filter((d) => d.side === 'writer');
  const mineNow = writerDrafts[writerDrafts.length - 1] || null;
  const firstMine = writerDrafts[0] || null;
  const suggestion = newest?.side === 'campaign' && !OUT.includes(l.status) && l.status !== 'declined' ? newest : null;
  const agreed = drafts.find((d) => d.id === l.agreed_version) || null;
  const openSend = [...(l.sends || [])].reverse().find((s) => !s.outcome) || null;
  const published = [...(l.sends || [])].reverse().find((s) => s.outcome === 'published') || null;
  const notPrinted = l.status === 'ready' ? [...(l.sends || [])].reverse().find((s) => s.outcome === 'not_published') : null;
  const kept = readDraft(`edit:${l.id}`);
  const [editing, setEditing] = useState(() => (kept ? { body: kept.body || '', from_version: kept.from_version || null, queued: kept.queued || null } : null));
  const [sending, setSending] = useState(false);
  const chip = notPrinted ? `Not printed at ${notPrinted.outlet_name || 'the paper'}` : STATUS_WORDS[l.status];
  const editable = !OUT.includes(l.status) && l.status !== 'declined';
  const canAgree = Boolean(mineNow && newest?.side === 'writer' && !l.agreed_version && editable && !editing);

  return (
    <Page>
      <div className="lt-head">
        <h1>{l.title || KIND_WORDS[l.kind]}</h1>
        <span className={`chip${notPrinted ? ' chip-warn' : ''}`}>{chip}</span>
      </div>
      {l.outlets.length > 0 && <p className="ops-meta">{l.outlets.map((o) => o.name).join(' · ')}</p>}
      {(l.outlets.length === 0 || l.dropped_outlets.length > 0) && editable && <PickAgain l={l} dropped={dropped} outletsQ={outletsQ} onDone={(m) => { setSaid(m); refresh(); }} />}
      {said && <p className="ops-done" role="status">{said}</p>}

      {suggestion && mineNow && !editing && (
        <Suggestion l={l} mine={mineNow} theirs={suggestion} onEdit={setEditing} onSaid={setSaid} />
      )}

      {editing ? (
        <EditBox l={l} editing={editing} setEditing={setEditing} onSaid={setSaid} />
      ) : mineNow && (
        <section className="lt-sec" aria-labelledby="lt-yours">
          <div className="lt-sec__head">
            <h2 className="lt-sub" id="lt-yours">Your letter</h2>
            {editable && <button type="button" className="btn btn-quiet ops-tap" onClick={() => setEditing({ body: mineNow.body, from_version: null })}>Edit</button>}
          </div>
          <div className="lt-text">{(agreed || mineNow).body}</div>
          {(l.campaign_words || []).slice(0, 1).map((w) => <CampaignWords key={w.source} run={w.run} />)}
        </section>
      )}

      {canAgree && <FinalText l={l} mine={mineNow} first={firstMine} drafts={drafts} onDone={(m) => { setSaid(m); refresh(); }} />}

      {l.status === 'ready' && agreed && !sending && (
        <div className="ops-actions lt-now">
          <button type="button" className="btn btn-primary ops-tap ops-wide" onClick={() => setSending(true)}>Send it</button>
        </div>
      )}
      {['ready', 'sent'].includes(l.status) && agreed && sending && (
        <SendSheet me={me} l={l} agreed={agreed} outletsQ={outletsQ} onClose={() => setSending(false)}
          onSent={(m) => { setSending(false); setSaid(m); refresh(); }} />
      )}
      {l.status === 'sent' && openSend && !sending && <SentLine l={l} send={openSend} onAnother={() => setSending(true)} onDone={(m) => { setSaid(m); refresh(); }} />}
      {published && (
        <p className="lt-pub">Published in {published.outlet_name || 'the paper'}{published.published_on ? ` · ${dayWords(published.published_on)}` : ''}
          {published.url && <> · <a href={published.url} target="_blank" rel="noopener noreferrer">Read it</a></>}</p>
      )}
      {l.status === 'declined' && (
        <section className="lt-sec" aria-label="The campaign’s answer">
          <p className="lt-note-campaign">{l.declined_note || 'The campaign won’t work on this one.'}</p>
        </section>
      )}

      <Notes l={l} onSaid={setSaid} />
      <LetterMore l={l} onDone={setSaid} />
    </Page>
  );
}

// ── Take or Leave, change by change ──
function Suggestion({ l, mine, theirs, onEdit, onSaid }) {
  const hunks = useMemo(() => wordDiff(mine.body, theirs.body), [mine.body, theirs.body]);
  const [taken, setTaken] = useState(() => new Set());
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const changes = hunks.map((h, k) => (h.kind === 'change' ? k : null)).filter((k) => k != null);
  const note = [...(l.notes || [])].reverse().find((n) => n.side === 'campaign' && new Date(n.created_at) >= new Date(theirs.created_at) - 5000);
  const flip = (k, on) => setTaken((t) => { const n = new Set(t); if (on) n.add(k); else n.delete(k); return n; });
  const textOf = (ps) => ps.map((p) => p.text).join('');
  const keepMine = async () => {
    setBusy(true);
    try {
      const r = await queueAction('myletter.revise', { id: l.id, body: mine.body, client_id: newClientId() });
      onSaid(r.queued ? queuedText(r, 'Kept yours —') : 'Kept your text');
    } catch (err) { onSaid(err.message); } finally { setBusy(false); }
  };
  return (
    <section className="lt-sec lt-sugg" aria-labelledby="lt-sugg-h">
      <h2 className="lt-sub" id="lt-sugg-h">A suggestion from the campaign</h2>
      <p className="ops-meta">{changes.length} {changes.length === 1 ? 'change' : 'changes'} · Take the ones you like</p>
      <div className="lt-text lt-diff">
        {hunks.map((h, k) => (h.kind === 'same' ? <span key={k}>{textOf(h.from)}</span> : (
          <span key={k} className={`lt-change${taken.has(k) ? ' is-taken' : ''}`}>
            {textOf(h.from).trim() && <del>{textOf(h.from)}</del>}
            {textOf(h.to).trim() && <ins>{textOf(h.to)}</ins>}
            <span className="lt-take" role="radiogroup" aria-label={`Change ${changes.indexOf(k) + 1}`}>
              <button type="button" role="radio" aria-checked={taken.has(k)} className={`chip lt-chip${taken.has(k) ? ' is-on' : ''}`} onClick={() => flip(k, true)}>Take</button>
              <button type="button" role="radio" aria-checked={!taken.has(k)} className={`chip lt-chip${!taken.has(k) ? ' is-on' : ''}`} onClick={() => flip(k, false)}>Leave</button>
            </span>
          </span>
        )))}
      </div>
      {note && <p className="lt-note-campaign"><span className="ops-meta">Campaign{note.by ? ` · ${note.by}` : ''}</span> {note.body}</p>}
      <div className="ops-actions">
        <button type="button" className="btn btn-primary ops-tap" onClick={() => onEdit({ body: applyHunks(mine.body, theirs.body, taken), from_version: taken.size ? theirs.id : null })}>Save my letter</button>
      </div>
      <More>
        {!all ? (
          <div className="ops-actions">
            <button type="button" className="btn ops-tap" onClick={() => setAll(true)}>Take all</button>
            <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={keepMine}>Keep mine</button>
          </div>
        ) : (
          <div className="lt-confirm" role="group" aria-label="Take all">
            <span>Use all of the campaign’s changes?</span>
            <button type="button" className="btn ops-tap" onClick={() => onEdit({ body: theirs.body, from_version: theirs.id })}>Yes</button>
            <button type="button" className="btn btn-quiet ops-tap" onClick={() => setAll(false)}>No</button>
          </div>
        )}
      </More>
    </section>
  );
}

// ── The edit box (from Edit, or Save my letter) ──
function EditBox({ l, editing, setEditing, onSaid }) {
  const name = `edit:${l.id}`;
  useKept(name, editing, keepBody);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const queued = Boolean(editing.queued);
  // The server has the edit: the box closes.
  useEffect(() => onOutboxSent(({ name: n, input }) => {
    if (n === 'myletter.revise' && editing.queued && input?.client_id === editing.queued) { clearDraft(name); setEditing(null); }
  }), [editing.queued, name, setEditing]);
  const save = async (e) => {
    e.preventDefault();
    if (!editing.body.trim()) { setError('Your letter is empty'); return; }
    const cid = newClientId();
    const held = { ...editing, queued: cid };
    writeDraft(name, held);
    setEditing(held);
    setBusy(true); setError(null);
    try {
      const r = await queueAction('myletter.revise', { id: l.id, body: editing.body, client_id: cid, ...(editing.from_version ? { from_version: editing.from_version } : {}) });
      if (!r.queued) { clearDraft(name); setEditing(null); onSaid('Saved'); } else onSaid(queuedText(r, 'Your edit is'));
    } catch (err) {
      const back = { body: editing.body, from_version: editing.from_version };
      writeDraft(name, back); setEditing(back); setError(err.message);
    } finally { setBusy(false); }
  };
  return (
    <form className="lt-sec" onSubmit={save} aria-label="Your letter">
      <label className="lt-sub" htmlFor="lt-edit">Your letter</label>
      <textarea id="lt-edit" className="input lt-body" rows={12} maxLength={20000} readOnly={queued} value={editing.body}
        onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
      <Count text={editing.body} outlet={l.outlets[0]} />
      {error && <p className="error" role="alert">{error}</p>}
      {queued ? <p className="ops-done ops-done--wait" role="status">Waiting to send</p> : (
        <div className="ops-actions">
          <button type="submit" className="btn btn-primary ops-tap" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          <button type="button" className="btn btn-quiet ops-tap" onClick={() => { clearDraft(name); setEditing(null); }}>Cancel</button>
        </div>
      )}
    </form>
  );
}

// ── "This is my final text" ──
function FinalText({ l, mine, first, drafts, onDone }) {
  const online = useOnline();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const share = useMemo(() => (first ? campaignShare(first.body, drafts.filter((d) => d.side === 'campaign').map((d) => d.body), mine.body) : 0), [first, drafts, mine.body]);
  const agree = async () => {
    setBusy(true); setError(null);
    try {
      await action('myletter.agree', { id: l.id, version_id: mine.id });
      onDone('Ready to send');
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <section className="lt-now" aria-label="Final text">
      {share >= 0.2 && <p className="lt-share">About {pct(share)}% of these words are the campaign’s — still yours to send?</p>}
      {!asking ? (
        <div className="ops-actions">
          <button type="button" className="btn btn-primary ops-tap ops-wide" onClick={() => setAsking(true)}>This is my final text</button>
        </div>
      ) : (
        <div className="lt-confirm" role="group" aria-label="Confirm final text">
          <span>Send this exact text, in your name, to the paper?</span>
          <button type="button" className="btn ops-tap" disabled={busy || !online} onClick={agree}>{busy ? 'Saving…' : 'Yes'}</button>
          <button type="button" className="btn btn-quiet ops-tap" onClick={() => setAsking(false)}>Not yet</button>
        </div>
      )}
      {asking && !online && <NeedsSignalLine>Needs signal — your agreement is to the text the campaign has now.</NeedsSignalLine>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

// ── Send it ──
const SIGN_LINES = [['name', 'Name'], ['city', 'City'], ['phone', 'Phone'], ['address', 'Address']];
function SendSheet({ me, l, agreed, outletsQ, onClose, onSent }) {
  const online = useOnline();
  const data = outletsQ.data;
  // A paper that has it now (no answer yet) isn't offered again.
  const out = new Set((l.sends || []).filter((s) => !s.outcome).map((s) => s.outlet_id));
  const choices = (l.outlets.length ? l.outlets : (data?.outlets || [])).filter((x) => !out.has(x.id));
  const blockedOf = (o) => l.blocked.find((b) => b.outlet_id === o.id) || null;
  const [pickId, setPickId] = useState(() => (choices.find((o) => !blockedOf(o)) || choices[0])?.id || null);
  const o = choices.find((x) => x.id === pickId) || null;
  const blocked = o ? blockedOf(o) : null;
  const [subject, setSubject] = useState(() => (o?.subject_hint || l.title || firstWords(agreed.body, 8)));
  const [sign, setSign] = useState(() => ({ ...l.sign }));
  const [changed, setChanged] = useState({});
  const [said, setSaid] = useState(null);
  const [shown, setShown] = useState(null); // the text, selected, when the clipboard said no
  const [missing, setMissing] = useState(null);
  const [busy, setBusy] = useState(false);
  const campaign = data?.campaign_name || me?.workspace?.name || 'the campaign';
  useEffect(() => { if (o?.subject_hint) setSubject(o.subject_hint); }, [o?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const signoff = [
    sign.name, sign.city, o?.asks_phone ? sign.phone : null, o?.asks_address ? sign.address : null,
    l.disclose_line ? `I volunteer with ${campaign}` : null,
  ].filter((x) => x && String(x).trim()).join('\n');
  const whole = `${agreed.body.trim()}\n\n${signoff}`;
  const link = o?.email ? mailtoFor({ to: o.email, subject, body: agreed.body, signoff, max: mailtoMax() }) : null;
  const need = () => {
    if (!String(sign.name || '').trim()) return 'Add your name — the paper prints it';
    if (!String(sign.city || '').trim()) return 'Add your city — the paper prints it';
    if (o?.asks_phone && !String(sign.phone || '').trim()) return 'Add your phone — the paper calls to check';
    if (o?.asks_address && !String(sign.address || '').trim()) return 'Add your address — the paper asks for it';
    return null;
  };
  const keepSign = () => {
    if (!online || !Object.keys(changed).length) return;
    action('myletter.details', { id: l.id, sign: Object.fromEntries(Object.keys(changed).map((k) => [k, String(sign[k] || '').trim()])) })
      .then(() => setChanged({})).catch(() => { /* kept in the sheet */ });
  };
  const copyFirst = async () => {
    const ok = await copyText(whole);
    if (!ok) setShown(whole);
    return ok;
  };
  const openEmail = (e) => {
    const m = need();
    if (m) { e.preventDefault(); setMissing(m); return; }
    setMissing(null);
    keepSign();
    copyFirst().then((ok) => setSaid(!link.bodyInLink ? (ok ? 'Text copied — paste it into the email' : 'Copy the text below and paste it into the email')
      : (ok ? 'Text also copied — paste if it’s missing' : null)));
  };
  const copyLetter = async () => {
    const m = need();
    if (m) { setMissing(m); return; }
    setMissing(null);
    keepSign();
    setSaid(await copyFirst() ? 'Copied — paste it into the paper’s form' : 'Copy the text below');
  };
  const sent = async () => {
    setBusy(true);
    try {
      const r = await queueAction('myletter.sent', { id: l.id, outlet_id: o.id, how: o.email ? 'email' : 'form', client_id: newClientId() });
      onSent(r.queued ? queuedText(r, 'Sent —') : `Sent to ${o.name}`);
    } catch (err) { setSaid(err.message); } finally { setBusy(false); }
  };
  const notOut = async (b) => {
    const s = [...l.sends].reverse().find((x) => !x.outcome && x.outlet_name === b.by);
    if (!s) return;
    const r = await queueAction('myletter.not_published', { id: l.id, send_id: s.id, client_id: newClientId() }).catch((err) => ({ error: err.message }));
    onSent(r.error || (r.queued ? queuedText(r, 'Not published —') : `Not published at ${b.by}`));
  };

  return (
    <section className="card lt-sheet" aria-labelledby="lt-send-h">
      <div className="lt-sec__head">
        <h2 className="lt-sub" id="lt-send-h">Send it</h2>
        <button type="button" className="btn btn-quiet ops-tap" onClick={onClose}>Close</button>
      </div>
      {choices.length === 0 && <p className="ops-meta">The campaign hasn’t added papers yet.</p>}
      <div className="lt-chips" role="radiogroup" aria-label="Paper">
        {choices.map((x) => {
          const b = blockedOf(x);
          return (
            <button key={x.id} type="button" role="radio" aria-checked={pickId === x.id} aria-disabled={Boolean(b)}
              className={`chip lt-chip${pickId === x.id ? ' is-on' : ''}${b ? ' is-blocked' : ''}`} onClick={() => setPickId(x.id)}>{x.name}</button>
          );
        })}
      </div>
      {o && blocked && (
        <div className="lt-remind">
          <p>Still out at {blocked.by} until {dayWords(blocked.until)}. Wait for them, or say they didn’t print it.</p>
          <button type="button" className="btn ops-tap" onClick={() => notOut(blocked)}>Mark Not published</button>
        </div>
      )}
      {o && !blocked && (
        <>
          <p className="lt-rules">{rulesLine(o) && <span>{rulesLine(o)}</span>}{o.rules && <span className="lt-rules__line">{o.rules}</span>}</p>
          <Count text={agreed.body} outlet={o} />
          <div className="field">
            <label htmlFor="lt-subject">Subject</label>
            <input id="lt-subject" className="input" maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div className="lt-text lt-agreed">{agreed.body}</div>
          <div className="lt-signoff">
            {SIGN_LINES.filter(([k]) => k === 'name' || k === 'city' || (k === 'phone' && o.asks_phone) || (k === 'address' && o.asks_address)).map(([k, label]) => (
              <div key={k} className="field">
                <label htmlFor={`lt-so-${k}`}>{label}</label>
                <input id={`lt-so-${k}`} className="input" type={k === 'phone' ? 'tel' : 'text'} maxLength={k === 'address' ? 300 : 120} value={sign[k] || ''}
                  onChange={(e) => { setSign({ ...sign, [k]: e.target.value }); setChanged({ ...changed, [k]: true }); setMissing(null); }} />
              </div>
            ))}
            {l.disclose_line && <p className="ops-meta">I volunteer with {campaign}</p>}
          </div>
          {missing && <p className="lt-remind" role="alert">{missing}</p>}
          <div className="ops-actions">
            {o.email ? (
              <a className="btn btn-primary ops-tap" href={link.href} onClick={openEmail}>Open my email</a>
            ) : (
              <>
                <button type="button" className="btn btn-primary ops-tap" onClick={copyLetter}>Copy my letter</button>
                {o.form && <a className="btn ops-tap" href={o.form} target="_blank" rel="noopener noreferrer">Open the paper’s form</a>}
              </>
            )}
          </div>
          {said && <p className="ops-meta" role="status">{said}</p>}
          {shown && <textarea className="input lt-body" readOnly rows={8} value={shown} ref={(t) => t?.select()} aria-label="Your letter, to copy" />}
          <div className="ops-actions lt-sent">
            <button type="button" className="btn ops-tap" disabled={busy} onClick={sent}>I sent it</button>
          </div>
        </>
      )}
    </section>
  );
}

// ── Sent: published, or not ──
function SentLine({ l, send, onAnother, onDone }) {
  const [pub, setPub] = useState(false);
  const [url, setUrl] = useState('');
  const [on, setOn] = useState('');
  const [error, setError] = useState(null);
  const run = async (name, input, words) => {
    setError(null);
    try {
      const r = await queueAction(name, { id: l.id, send_id: send.id, client_id: newClientId(), ...input });
      onDone(r.queued ? queuedText(r, `${words} —`) : words);
    } catch (err) { setError(err.message); }
  };
  return (
    <section className="lt-sec" aria-label="Sent">
      <p>Sent to {send.outlet_name || 'the paper'} · {dayWords(send.sent_at)}</p>
      {!pub ? (
        <div className="ops-actions">
          <button type="button" className="btn btn-quiet ops-tap" onClick={() => setPub(true)}>It was published</button>
          <button type="button" className="btn btn-quiet ops-tap" onClick={() => run('myletter.not_published', {}, 'Not published')}>Not published</button>
          <button type="button" className="btn btn-quiet ops-tap" onClick={onAnother}>Send to another paper</button>
        </div>
      ) : (
        <form className="lt-pubform" onSubmit={(e) => { e.preventDefault(); run('myletter.published', { url: url.trim(), ...(on ? { on } : {}) }, 'Published'); }}>
          <div className="field"><label htmlFor="lt-url">Link to it</label>
            <input id="lt-url" className="input" type="url" inputMode="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" /></div>
          <div className="field"><label htmlFor="lt-on">Date <span className="muted">(optional)</span></label>
            <input id="lt-on" className="input" type="date" value={on} onChange={(e) => setOn(e.target.value)} /></div>
          <div className="ops-actions">
            <button type="submit" className="btn ops-tap">Save</button>
            <button type="button" className="btn btn-quiet ops-tap" onClick={() => setPub(false)}>Cancel</button>
          </div>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

// ── Notes ──
function Notes({ l, onSaid }) {
  const name = `note:${l.id}`;
  const [note, setNote] = useState(() => readDraft(name)?.body || '');
  const value = useMemo(() => ({ body: note }), [note]);
  useKept(name, value, keepBody);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const send = async (e) => {
    e.preventDefault();
    if (!note.trim()) return;
    setBusy(true); setError(null);
    const cid = newClientId();
    try {
      writeDraft(name, { body: note, queued: cid });
      const r = await queueAction('myletter.note', { id: l.id, body: note.trim(), client_id: cid });
      setNote('');
      if (!r.queued) clearDraft(name);
      onSaid(r.queued ? queuedText(r, 'Your note is') : 'Note sent');
    } catch (err) { writeDraft(name, { body: note }); setError(err.message); } finally { setBusy(false); }
  };
  return (
    <section className="lt-sec" aria-labelledby="lt-notes-h">
      <h2 className="lt-sub" id="lt-notes-h">Notes</h2>
      {(l.notes || []).length > 0 && (
        <ul className="lt-notes">
          {l.notes.map((n) => (
            <li key={n.id} className={n.side === 'campaign' ? 'is-campaign' : ''}>
              <span className="ops-meta">{n.side === 'campaign' ? `Campaign${n.by ? ` · ${n.by}` : ''}` : 'You'} · {dayWords(n.created_at)}</span>
              <span className="lt-note__body">{n.body}</span>
            </li>
          ))}
        </ul>
      )}
      <form className="lt-noteform" onSubmit={send}>
        <label className="ops-sr" htmlFor="lt-note">A note to the campaign</label>
        <textarea id="lt-note" className="input" rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="A note to the campaign" />
        <button type="submit" className="btn ops-tap" disabled={busy || !note.trim()}>Send</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

// ── Pick a paper again (a paper was taken off the list) ──
function PickAgain({ l, dropped, outletsQ, onDone }) {
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const [ids, setIds] = useState(() => l.outlets.map((o) => o.id));
  const [error, setError] = useState(null);
  const outlets = outletsQ.data?.outlets || [];
  const save = async () => {
    setError(null);
    try { await action('myletter.details', { id: l.id, outlet_ids: ids }); setOpen(false); onDone('Saved'); } catch (err) { setError(err.message); }
  };
  return (
    <div className="lt-remind">
      <p>{dropped.length ? `${dropped.map((d) => d.name).filter(Boolean).join(', ') || 'A paper you picked'} isn’t on the campaign’s list any more.` : 'No paper picked yet.'}</p>
      {!open ? <button type="button" className="btn ops-tap" onClick={() => { setOpen(true); outletsQ.refetch(); }}>{dropped.length ? 'Pick a paper again' : 'Pick a paper'}</button> : (
        <>
          {outlets.length === 0 && <p className="ops-meta">The campaign hasn’t added papers yet.</p>}
          <div className="lt-chips" role="group" aria-label="Paper">
            {outlets.map((o) => (
              <button key={o.id} type="button" aria-pressed={ids.includes(o.id)} className={`chip lt-chip${ids.includes(o.id) ? ' is-on' : ''}`}
                onClick={() => setIds(ids.includes(o.id) ? ids.filter((x) => x !== o.id) : ids.length >= 3 ? ids : [...ids, o.id])}>{o.name}</button>
            ))}
          </div>
          <div className="ops-actions">
            <button type="button" className="btn ops-tap" disabled={!online} onClick={save}>Save</button>
            <button type="button" className="btn btn-quiet ops-tap" onClick={() => setOpen(false)}>Cancel</button>
          </div>
          {!online && <NeedsSignalLine>Needs signal — nothing saved</NeedsSignalLine>}
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

// ── More: withdraw, delete ──
function LetterMore({ l, onDone }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const online = useOnline();
  const [asking, setAsking] = useState(null);
  const [error, setError] = useState(null);
  const canWithdraw = !['published', 'withdrawn'].includes(l.status);
  const canDelete = (l.sends || []).length === 0;
  if (!canWithdraw && !canDelete) return null;
  const go = async (what) => {
    setError(null);
    try {
      await action(what === 'delete' ? 'myletter.delete' : 'myletter.withdraw', { id: l.id });
      qc.invalidateQueries({ queryKey: ['letters'] });
      if (what === 'delete') navigate('/letters', { replace: true }); else { setAsking(null); onDone('Withdrawn'); }
    } catch (err) { setError(err.message); }
  };
  const words = { withdraw: 'Withdraw this letter? The campaign stops working on it.', delete: 'Delete this letter and its drafts?' };
  return (
    <More>
      {!asking ? (
        <div className="ops-actions">
          {canWithdraw && <button type="button" className="btn btn-quiet ops-tap" onClick={() => setAsking('withdraw')}>Withdraw</button>}
          {canDelete && <button type="button" className="btn btn-quiet ops-tap" onClick={() => setAsking('delete')}>Delete</button>}
        </div>
      ) : (
        <div className="lt-confirm" role="group" aria-label={asking === 'delete' ? 'Delete' : 'Withdraw'}>
          <span>{words[asking]}</span>
          <button type="button" className="btn ops-tap" disabled={!online} onClick={() => go(asking)}>Yes</button>
          <button type="button" className="btn btn-quiet ops-tap" onClick={() => setAsking(null)}>No</button>
        </div>
      )}
      {asking && !online && <NeedsSignalLine>Needs signal — nothing changed</NeedsSignalLine>}
      {error && <p className="error" role="alert">{error}</p>}
    </More>
  );
}
