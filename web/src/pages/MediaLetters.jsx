// Media → Letters and Media → Outlets (the desk; ext/letters, ext/media).
//   /media/letters       the queue: To do (New and Working on it) · Ready ·
//                        Sent · Published · Declined (Withdrawn under More);
//                        on a phone a row is the title, then "writer · paper";
//                        on a desk a table. Under More: Ideas for writers.
//   /media/letters/:id   a letter, in place: the writer's newest text (the
//                        campaign's suggestion marked when it's newer), how
//                        much of it is the campaign's, where it repeats the
//                        talking points, a release or another writer, the
//                        paper's card with Editors here, the sign-off for
//                        the paper to check, the notes; "Suggest an edit".
//                        No button marks it Ready and none sends it: the
//                        writer agrees and sends, from their own email.
//   /media/outlets       the papers, stations and shows, with each one's
//                        letters address or form, limits and rules.
// The queue holds writers' addresses and phones: desk roles only, never a
// volunteer granted Media (the server refuses the same).
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { wordDiff } from '@starbase/shared/letters';
import { action, apiGet } from '../api.js';
import { NeedsSignal, useOnline } from '../components/NoSignal.jsx';
import {
  Count, KIND_WORDS, LOADING, More, STATUS_WORDS, Unavailable, dayWords, firstWords, fmt,
} from '../components/LetterBits.jsx';
import './letters.css';

const FILTERS = [['todo', 'To do', 'new,working'], ['ready', 'Ready', 'ready'], ['sent', 'Sent', 'sent'], ['published', 'Published', 'published'], ['declined', 'Declined', 'declined']];
const pct = (x) => Math.round(Number(x) * 100);
const ago = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }) : dayWords(iso);
};

export { useLettersCount } from '../components/LettersCount.js';

function useRun(onDone) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (name, input) => {
    setBusy(true); setError(null);
    try { const r = await action(name, input); await onDone?.(r); return r || true; } catch (e) { setError(e.message); return null; } finally { setBusy(false); }
  };
  return { run, busy, error };
}

// ─────────────────────────────────────────────────────────────────────────────
// The queue
// ─────────────────────────────────────────────────────────────────────────────
const flagsOf = (l) => [
  l.not_printed_at ? ['chip chip-warn', `Not printed at ${l.not_printed_at}`] : null,
  l.sent_while_out ? ['chip chip-warn', l.while_out_name ? `Sent while out at ${l.while_out_name}` : 'Sent while out'] : null,
  l.mostly_campaign ? ['chip chip-warn', 'Mostly the campaign’s words'] : null,
].filter(Boolean);
const papers = (l) => l.outlets.map((o) => o.name).join(', ');

// The queue's table from 900 px (its columns are short; Media's own tables
// wait for 1000).
const WIDE_Q = '(min-width: 900px)';
function useQueueWide() {
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && Boolean(window.matchMedia?.(WIDE_Q).matches));
  useEffect(() => {
    const m = window.matchMedia?.(WIDE_Q);
    if (!m) return undefined;
    const on = () => setWide(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return wide;
}

export function LettersTab({ me }) {
  const navigate = useNavigate();
  const wide = useQueueWide();
  const [filter, setFilter] = useState('todo');
  const status = [...FILTERS, ['withdrawn', 'Withdrawn', 'withdrawn']].find(([k]) => k === filter)[2];
  const q = useQuery({ queryKey: ['letters', 'queue', status], queryFn: () => apiGet(`/media/letters?status=${status}`) });
  const letters = q.data?.letters || [];
  const chip = ([k, label]) => (
    <button key={k} type="button" role="radio" aria-checked={filter === k} className={`chip md-chip${filter === k ? ' is-on' : ''}`} onClick={() => setFilter(k)}>{label}</button>
  );
  const open = (id) => navigate(`/media/letters/${id}`);
  return (
    <>
      <div className="md-chips md-filter" role="radiogroup" aria-label="Show">
        {FILTERS.map(chip)}
        {filter === 'withdrawn' && chip(['withdrawn', 'Withdrawn'])}
      </div>
      {q.isPending && <p className="ot-note" role="status">{LOADING}</p>}
      {q.isError && <p className="error" role="alert"><Unavailable onRetry={() => q.refetch()} /></p>}
      {q.isSuccess && letters.length === 0 && <p className="ot-empty">{filter === 'todo' ? 'No letters to work on. Volunteers write them in the field app.' : 'None here.'}</p>}
      {letters.length > 0 && (wide ? (
        <table className="table lt-queue">
          <thead>
            <tr><th>Letter</th><th>Writer</th><th>Kind</th><th>Paper</th><th>Words</th><th>On it</th><th>Last</th><th><span className="ops-sr">Waiting</span></th></tr>
          </thead>
          <tbody>
            {letters.map((l) => (
              <tr key={l.id} className="rowlink">
                <td>
                  <button type="button" className="lt-title" onClick={() => open(l.id)}>{l.title || firstWords(l.first_words) || KIND_WORDS[l.kind]}</button>
                  <span className="lt-flags"><span className="chip">{STATUS_WORDS[l.status]}</span>{flagsOf(l).map(([c, w]) => <span key={w} className={c}>{w}</span>)}</span>
                </td>
                <td>{l.writer.name || '—'}</td>
                <td>{KIND_WORDS[l.kind]}</td>
                <td>{papers(l) || '—'}</td>
                <td className="mono">{fmt(l.size)}</td>
                <td>{l.assigned_to_name || '—'}</td>
                <td>{ago(l.last_at)}</td>
                <td>{l.waiting && <span className="lt-reply"><span className="lt-dot" aria-hidden="true" />Waiting</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <ul className="ot-list">
          {letters.map((l) => (
            <li key={l.id} className="ot-item">
              <Link className="ot-row" to={`/media/letters/${l.id}`}>
                <span className="ot-row__main">
                  <span className="ot-row__name">{l.title || firstWords(l.first_words) || KIND_WORDS[l.kind]}</span>
                  <span className="ot-row__sub"><span>{[l.writer.name, papers(l)].filter(Boolean).join(' · ')}</span></span>
                  {flagsOf(l).length > 0 && <span className="lt-flags">{flagsOf(l).map(([c, w]) => <span key={w} className={c}>{w}</span>)}</span>}
                </span>
                {l.waiting && <span className="lt-dot" aria-label="Waiting for you" />}
                <span className="chip">{STATUS_WORDS[l.status]}</span>
              </Link>
            </li>
          ))}
        </ul>
      ))}
      <More>
        {filter !== 'withdrawn' && <button type="button" className="btn btn-quiet ot-btn-tap" onClick={() => setFilter('withdrawn')}>Withdrawn letters</button>}
        <Points me={me} />
      </More>
    </>
  );
}

// Ideas for writers: facts and links, never a letter to copy.
function Points({ me }) {
  const qc = useQueryClient();
  const online = useOnline();
  const was = me?.workspace?.settings?.letters?.points || '';
  const [text, setText] = useState(was);
  const [said, setSaid] = useState(null);
  const act = useRun(async () => { await qc.invalidateQueries({ queryKey: ['me'] }); setSaid('Saved'); });
  return (
    <form className="lt-pubform" onSubmit={(e) => { e.preventDefault(); setSaid(null); act.run('letter.points', { text: text.trim() }); }}>
      <div className="field">
        <label htmlFor="lt-points">Ideas for writers</label>
        <textarea id="lt-points" className="input" rows={4} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} placeholder="Facts and links — never a letter to copy" />
        <span className="ops-meta">Writers see these, and are warned when they repeat them word for word.</span>
      </div>
      <div className="md-acts">
        <button type="submit" className="btn ot-btn-tap" disabled={act.busy || !online || text.trim() === was.trim()}>Save</button>
        <span className="ops-meta" role="status">{said || ''}</span>
      </div>
      {act.error && <p className="error" role="alert">{act.error}</p>}
    </form>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// A letter, in place
// ─────────────────────────────────────────────────────────────────────────────
export function DeskLetter({ id }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['letters', 'desk', id], queryFn: () => apiGet(`/media/letters/${id}`) });
  const loaded = Boolean(q.data);
  // Read is seen (desk_seen_at): the queue's and Today's counts follow.
  useEffect(() => { if (loaded) { qc.invalidateQueries({ queryKey: ['letters', 'count'] }); qc.invalidateQueries({ queryKey: ['letters', 'queue'] }); } }, [loaded, id, qc]);
  if (q.isPending) return <p className="ot-note" role="status">{LOADING}</p>;
  if (q.isError) return <p className="error" role="alert">{q.error?.status === 404 ? 'This letter isn’t here.' : <Unavailable onRetry={() => q.refetch()} />}</p>;
  return <DeskLetterBody key={id} l={q.data.letter} />;
}

function DeskLetterBody({ l }) {
  const qc = useQueryClient();
  const online = useOnline();
  const [suggesting, setSuggesting] = useState(false);
  const [said, setSaid] = useState(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['letters'] });
  const act = useRun(refresh);
  const drafts = l.drafts || [];
  const newest = drafts[drafts.length - 1] || null;
  const mine = [...drafts].reverse().find((d) => d.side === 'writer') || null;
  const theirsNewer = newest && newest.side === 'campaign' ? newest : null;
  const firstName = String(l.writer?.name || '').split(/\s+/)[0] || 'the writer';
  const openSend = [...(l.sends || [])].reverse().find((s) => !s.outcome) || null;
  const closed = ['sent', 'published', 'withdrawn'].includes(l.status);
  const share = Number(l.campaign_share) || 0;
  const go = async (name, input, words) => { const r = await act.run(name, input); if (r) setSaid(words); return r; };

  return (
    <article className="lt-desk" aria-label={l.title || 'Letter'}>
      <div className="lt-head">
        <h2 className="md-subject">{l.title || firstWords(mine?.body) || KIND_WORDS[l.kind]}</h2>
        <span className="chip">{STATUS_WORDS[l.status]}</span>
      </div>
      <p className="md-meta">{KIND_WORDS[l.kind]} · {l.writer?.name || 'A writer'}{l.outlets.length ? ` · ${l.outlets.map((o) => o.name).join(', ')}` : ''}</p>
      {said && <p className="ot-test-note" role="status">{said}</p>}
      {l.status === 'ready' && <p className="ot-note">Waiting for {firstName} to send it.</p>}
      {l.status === 'declined' && l.declined_note && <p className="ot-note">Declined: {l.declined_note}</p>}

      {mine && (
        <section className="lt-sec" aria-label="Their letter">
          <h3 className="lt-sub">{theirsNewer ? 'Their letter, with your suggestion' : 'Their letter'}</h3>
          {theirsNewer ? <DiffText from={mine.body} to={theirsNewer.body} /> : <div className="lt-text">{mine.body}</div>}
          {share >= 0.2 && <p className="lt-share">About {pct(share)}% of these words are the campaign’s{share > 0.5 && <> <span className="chip chip-warn">Mostly the campaign’s words</span></>}</p>}
          {(l.campaign_words || []).map((w, i) => (
            <p key={i} className="lt-words">{w.source === 'points' ? 'Repeats the talking points' : `Repeats the release of ${dayWords(w.release?.sent_at)}`}: <mark className="lt-mark">“{w.run}”</mark></p>
          ))}
          {(l.overlaps || []).map((o) => (
            <p key={o.letter_id} className="lt-words">
              Shares wording with <Link to={`/media/letters/${o.letter_id}`}>{o.writer_name || 'another writer'}’s letter</Link>{o.outlet_name ? ` to ${o.outlet_name}` : ''}{o.same_newsroom ? ' (same newsroom)' : ''}: <mark className="lt-mark">“{o.run}”</mark>
            </p>
          ))}
        </section>
      )}

      {!closed && l.status !== 'declined' && !suggesting && (
        <div className="md-acts">
          <button type="button" className="btn btn-primary ot-btn-tap" onClick={() => setSuggesting(true)}>Suggest an edit</button>
        </div>
      )}
      {suggesting && mine && <Suggest l={l} text={mine.body} onClose={() => setSuggesting(false)} onDone={(w) => { setSuggesting(false); setSaid(w); refresh(); }} />}

      {l.outlets.map((o) => (
        <section key={o.id} className="card lt-card" aria-label={o.name}>
          <h3 className="lt-sub">{o.name}</h3>
          {mine && <Count text={mine.body} outlet={o} />}
          {o.rules && <p className="ops-meta">{o.rules}</p>}
          <p>{o.confirmed_on ? <span className="ops-meta">Rules checked {dayWords(o.confirmed_on)}</span> : <span className="chip">Rules not checked</span>}</p>
          {(() => {
            const eds = (l.editors || []).filter((e) => String(e.outlet || '').toLowerCase() === o.name.toLowerCase());
            return eds.length > 0 && (
              <p>Editors here: <span className="lt-editors">{eds.map((e) => <Link key={e.person_id} to={`/people/${e.person_id}`}>{e.name}</Link>)}</span></p>
            );
          })()}
        </section>
      ))}
      {l.dropped_outlets?.length > 0 && <p className="ot-note">No longer on your outlets: {l.dropped_outlets.map((d) => d.name).filter(Boolean).join(', ') || 'one paper'}.</p>}

      <section className="lt-sec" aria-label="For the paper to check">
        <h3 className="lt-sub">For the paper to check</h3>
        <dl className="lt-dl">
          {[['Name', l.sign?.name], ['City', l.sign?.city], ['Phone', l.sign?.phone], ['Address', l.sign?.address]].map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v || '—'}</dd></div>
          ))}
        </dl>
        {l.writer?.person_id && <p className="ops-meta"><Link to={`/people/${l.writer.person_id}`}>Open their profile</Link></p>}
      </section>

      <DeskNotes l={l} onDone={refresh} />

      <DeskActions l={l} openSend={openSend} go={go} act={act} online={online} />

      {drafts.length > 1 && (
        <More label="Earlier drafts">
          <ul className="lt-notes">
            {drafts.slice(0, -1).reverse().map((d) => (
              <li key={d.id}>
                <span className="ops-meta">Draft {d.n} · {d.side === 'campaign' ? (d.by || 'Campaign') : firstName} · {dayWords(d.created_at)}</span>
                <span className="lt-note__body">{d.body}</span>
              </li>
            ))}
          </ul>
        </More>
      )}
      {act.error && <p className="error" role="alert">{act.error}</p>}
      {!online && <NeedsSignal />}
    </article>
  );
}

// The writer's text with a suggestion's changes marked (cut struck, new underlined).
function DiffText({ from, to }) {
  const hunks = useMemo(() => wordDiff(from, to), [from, to]);
  const t = (ps) => ps.map((p) => p.text).join('');
  return (
    <div className="lt-text lt-diff">
      {hunks.map((h, k) => (h.kind === 'same' ? <span key={k}>{t(h.from)}</span> : (
        <span key={k}>{t(h.from).trim() && <del>{t(h.from)}</del>}{t(h.to).trim() && <ins>{t(h.to)}</ins>}</span>
      )))}
    </div>
  );
}

function Suggest({ l, text, onClose, onDone }) {
  const online = useOnline();
  const [body, setBody] = useState(text);
  const [note, setNote] = useState('');
  const act = useRun();
  const save = async (e) => {
    e.preventDefault();
    const r = await act.run('letter.suggest', { id: l.id, body, ...(note.trim() ? { note: note.trim() } : {}) });
    if (r) onDone('Suggestion sent');
  };
  return (
    <form className="card lt-sheet" onSubmit={save} aria-label="Suggest an edit">
      <p className="ops-meta">Change only what helps — it’s their letter.</p>
      <label className="ops-sr" htmlFor="lt-sug">Your suggestion</label>
      <textarea id="lt-sug" className="input lt-body" rows={12} maxLength={20000} value={body} onChange={(e) => setBody(e.target.value)} />
      <Count text={body} outlet={l.outlets[0]} />
      <div className="field">
        <label htmlFor="lt-sug-note">A note <span className="muted">(optional)</span></label>
        <textarea id="lt-sug-note" className="input" rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {act.error && <p className="error" role="alert">{act.error}</p>}
      <div className="md-acts">
        <button type="submit" className="btn btn-primary ot-btn-tap" disabled={act.busy || !online || body === text || !body.trim()}>{act.busy ? 'Sending…' : 'Send the suggestion'}</button>
        <button type="button" className="btn btn-quiet ot-btn-tap" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

function DeskNotes({ l, onDone }) {
  const online = useOnline();
  const [note, setNote] = useState('');
  const act = useRun(onDone);
  const send = async (e) => {
    e.preventDefault();
    if (await act.run('letter.note', { id: l.id, body: note.trim() })) setNote('');
  };
  return (
    <section className="lt-sec" aria-labelledby="lt-dn-h">
      <h3 className="lt-sub" id="lt-dn-h">Notes</h3>
      {(l.notes || []).length > 0 && (
        <ul className="lt-notes">
          {l.notes.map((n) => (
            <li key={n.id} className={n.side === 'campaign' ? 'is-campaign' : ''}>
              <span className="ops-meta">{n.side === 'campaign' ? `Campaign${n.by ? ` · ${n.by}` : ''}` : (l.writer?.name || 'Writer')} · {dayWords(n.created_at)}</span>
              <span className="lt-note__body">{n.body}</span>
            </li>
          ))}
        </ul>
      )}
      <form className="lt-noteform" onSubmit={send}>
        <label className="ops-sr" htmlFor="lt-dnote">A note to the writer</label>
        <textarea id="lt-dnote" className="input" rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="A note to the writer" />
        <button type="submit" className="btn ot-btn-tap" disabled={act.busy || !online || !note.trim()}>Send</button>
      </form>
      {act.error && <p className="error" role="alert">{act.error}</p>}
    </section>
  );
}

// The quiet ones: Mark working, Assign to…, Decline, and the writer's word
// on a send. No Ready, no Send: the writer does both.
function DeskActions({ l, openSend, go, act, online }) {
  const [mode, setMode] = useState(null);
  const [text, setText] = useState('');
  const [on, setOn] = useState('');
  const [toldId, setToldId] = useState(l.outlets[0]?.id || null);
  const members = useQuery({ queryKey: ['members'], queryFn: () => apiGet('/members'), staleTime: 60_000, enabled: mode === 'assign' });
  const desk = (members.data?.members || []).filter((m) => m.role !== 'volunteer');
  const done = () => { setMode(null); setText(''); };
  return (
    <section className="lt-sec" aria-label="More for this letter">
      {!mode && (
        <div className="md-acts">
          {l.status === 'new' && <button type="button" className="btn btn-quiet ot-btn-tap" disabled={!online} onClick={() => go('letter.status', { id: l.id, status: 'working' }, 'Marked working')}>Mark working</button>}
          <button type="button" className="btn btn-quiet ot-btn-tap" onClick={() => setMode('assign')}>Assign to…</button>
          {['new', 'working', 'ready'].includes(l.status) && <button type="button" className="btn btn-quiet ot-btn-tap" onClick={() => setMode('decline')}>Decline</button>}
          {l.status === 'declined' && <button type="button" className="btn btn-quiet ot-btn-tap" disabled={!online} onClick={() => go('letter.reopen', { id: l.id }, 'Back to working on it')}>Work on it again</button>}
          {l.status === 'ready' && l.outlets.length > 0 && <button type="button" className="btn btn-quiet ot-btn-tap" onClick={() => setMode('told')}>They told us they sent it</button>}
          {openSend && <button type="button" className="btn btn-quiet ot-btn-tap" onClick={() => setMode('published')}>Published: paste the link</button>}
          {openSend && <button type="button" className="btn btn-quiet ot-btn-tap" disabled={!online} onClick={() => go('letter.not_published', { id: l.id, send_id: openSend.id }, 'Not published — back to Ready')}>Not published</button>}
        </div>
      )}
      {mode === 'assign' && (
        <div className="ot-confirm" role="group" aria-label="Assign to">
          {members.isPending && <span>{LOADING}</span>}
          <select className="input" aria-label="Who’s on it" value={text} onChange={(e) => setText(e.target.value)}>
            <option value="">No one</option>
            {desk.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <button type="button" className="btn ot-btn-tap" disabled={act.busy || !online} onClick={async () => { if (await go('letter.assign', { id: l.id, user_id: text || null }, 'Assigned')) done(); }}>Save</button>
          <button type="button" className="btn btn-quiet ot-btn-tap" onClick={done}>Cancel</button>
        </div>
      )}
      {mode === 'decline' && (
        <form className="ot-confirm" onSubmit={async (e) => { e.preventDefault(); if (await go('letter.decline', { id: l.id, note: text.trim() }, 'Declined')) done(); }}>
          <label className="ops-sr" htmlFor="lt-decline">Why (the writer sees this)</label>
          <textarea id="lt-decline" className="input" rows={2} maxLength={500} required value={text} onChange={(e) => setText(e.target.value)} placeholder="Why — the writer sees this" />
          <button type="submit" className="btn ot-btn-tap" disabled={act.busy || !online || !text.trim()}>Decline</button>
          <button type="button" className="btn btn-quiet ot-btn-tap" onClick={done}>Cancel</button>
        </form>
      )}
      {mode === 'told' && (
        <div className="ot-confirm" role="group" aria-label="They told us they sent it">
          <span>Which paper?</span>
          <div className="md-chips" role="radiogroup" aria-label="Paper">
            {l.outlets.map((o) => <button key={o.id} type="button" role="radio" aria-checked={toldId === o.id} className={`chip md-chip${toldId === o.id ? ' is-on' : ''}`} onClick={() => setToldId(o.id)}>{o.name}</button>)}
          </div>
          <button type="button" className="btn ot-btn-tap" disabled={act.busy || !online || !toldId} onClick={async () => { if (await go('letter.told_sent', { id: l.id, outlet_id: toldId }, 'Noted as sent')) done(); }}>Save</button>
          <button type="button" className="btn btn-quiet ot-btn-tap" onClick={done}>Cancel</button>
        </div>
      )}
      {mode === 'published' && openSend && (
        <form className="ot-confirm" onSubmit={async (e) => { e.preventDefault(); if (await go('letter.published', { id: l.id, send_id: openSend.id, url: text.trim(), ...(on ? { on } : {}) }, 'Published')) done(); }}>
          <label className="ops-sr" htmlFor="lt-purl">Link</label>
          <input id="lt-purl" className="input" type="url" required value={text} onChange={(e) => setText(e.target.value)} placeholder="https://…" />
          <label className="ops-sr" htmlFor="lt-pon">Date</label>
          <input id="lt-pon" className="input" type="date" value={on} onChange={(e) => setOn(e.target.value)} />
          <button type="submit" className="btn ot-btn-tap" disabled={act.busy || !online}>Save</button>
          <button type="button" className="btn btn-quiet ot-btn-tap" onClick={done}>Cancel</button>
        </form>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Outlets
// ─────────────────────────────────────────────────────────────────────────────
const OUTLET_KINDS = [['paper', 'Paper'], ['online', 'Online'], ['radio', 'Radio'], ['tv', 'TV'], ['podcast', 'Podcast'], ['other', 'Other']];
const kindWord = (k) => (OUTLET_KINDS.find(([x]) => x === k) || [null, k])[1];
export const useOutlets = (enabled = true) => useQuery({ queryKey: ['media', 'outlets'], queryFn: () => apiGet('/media/outlets'), enabled });
const limitsLine = (o) => {
  const unit = o.limit_unit === 'characters' ? ' characters' : '';
  return [o.letters_limit ? `Letters ≤${fmt(o.letters_limit)}${unit}` : (o.letters_email || o.letters_form ? 'Letters' : null),
    o.oped_limit ? `Op-eds ≤${fmt(o.oped_limit)}${unit}` : (o.oped_email || o.oped_form ? 'Op-eds' : null)].filter(Boolean).join(' · ');
};

export function OutletsScreen({ desk, adding, onCloseAdd, toast }) {
  const q = useOutlets();
  const [open, setOpen] = useState(null);
  const outlets = q.data?.outlets || [];
  const current = open && outlets.find((o) => o.id === open);
  return (
    <>
      {adding && desk && <OutletSheet key="new" onClose={onCloseAdd} onSaved={(w) => { toast(w); onCloseAdd(); }} />}
      {current && <OutletSheet key={current.id} o={current} desk={desk} onClose={() => setOpen(null)} onSaved={(w) => { toast(w); }} />}
      {q.isPending && <p className="ot-note" role="status">{LOADING}</p>}
      {q.isError && <p className="error" role="alert"><Unavailable onRetry={() => q.refetch()} /></p>}
      {q.isSuccess && outlets.length === 0 && !adding && <p className="ot-empty">Add the papers your volunteers write to.</p>}
      {outlets.length > 0 && (
        <ul className="ot-list">
          {outlets.map((o) => (
            <li key={o.id} className="ot-item">
              <button type="button" className="ot-row md-row" aria-expanded={open === o.id} onClick={() => setOpen(o.id)}>
                <span className="ot-row__main">
                  <span className="ot-row__name">{o.name}</span>
                  <span className="ot-row__sub"><span>{[kindWord(o.kind), o.language, limitsLine(o)].filter(Boolean).join(' · ')}</span></span>
                </span>
                {o.confirmed_on ? <span className="ops-meta">Rules checked {dayWords(o.confirmed_on)}</span> : <span className="chip">Rules not checked</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

const FIELDS = ['name', 'kind', 'newsroom', 'language', 'website', 'letters_email', 'letters_form', 'letters_limit', 'oped_email', 'oped_form', 'oped_limit',
  'limit_unit', 'subject_hint', 'asks_address', 'asks_phone', 'exclusive', 'local_only', 'no_candidates', 'disclose', 'rules'];
const NEW_OUTLET = { name: '', kind: 'paper', limit_unit: 'words', asks_address: false, asks_phone: true, exclusive: true, local_only: false, no_candidates: false, disclose: false };
const SWITCHES = [['exclusive', 'Wants it only for itself'], ['local_only', 'Prints local writers only'], ['no_candidates', 'Doesn’t print candidates'], ['disclose', 'Asks writers to say if they work with a campaign']];

function OutletSheet({ o, desk = true, onClose, onSaved }) {
  const qc = useQueryClient();
  const online = useOnline();
  const [f, setF] = useState(() => Object.fromEntries(FIELDS.map((k) => [k, o ? (o[k] ?? (typeof NEW_OUTLET[k] === 'boolean' ? NEW_OUTLET[k] : '')) : (NEW_OUTLET[k] ?? '')])));
  const [removing, setRemoving] = useState(false);
  const act = useRun(() => qc.invalidateQueries({ queryKey: ['media', 'outlets'] }));
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const input = (extra = {}) => {
    const out = { ...(o ? { id: o.id } : {}) };
    for (const k of FIELDS) {
      const v = f[k];
      if (k === 'letters_limit' || k === 'oped_limit') out[k] = v === '' || v == null ? null : Number(v);
      else if (typeof v === 'boolean') out[k] = v;
      else out[k] = String(v ?? '').trim();
    }
    return { ...out, ...extra };
  };
  const save = async (e, extra) => {
    e?.preventDefault();
    const r = await act.run('media.outlet.save', input(extra));
    if (r) onSaved(extra?.checked ? `${f.name.trim()}: rules checked today` : o ? 'Saved' : `Added ${f.name.trim()}`);
  };
  const remove = async () => {
    const r = await act.run('media.outlet.remove', { id: o.id });
    if (r) { onSaved(`${o.name} is off your outlets`); onClose(); }
  };
  const asks = [o?.asks_phone ? 'phone' : null, o?.asks_address ? 'address' : null].filter(Boolean).join(' · ');
  if (!desk && o) {
    return (
      <section className="card lt-outlet-sheet" aria-label={o.name}>
        <div className="md-sheet__head"><h2 className="md-sheet__name">{o.name}</h2><button type="button" className="btn btn-quiet ot-btn-tap" onClick={onClose}>Close</button></div>
        <dl className="lt-dl">
          <dt>Letters</dt><dd>{o.letters_email || o.letters_form || '—'}</dd>
          <dt>Limit</dt><dd>{limitsLine(o) || '—'}</dd>
          <dt>Asks for</dt><dd>{asks || '—'}</dd>
          {o.rules && <><dt>Rules</dt><dd>{o.rules}</dd></>}
        </dl>
      </section>
    );
  }
  const field = (k, label, props = {}) => (
    <div className="field"><label htmlFor={`lt-o-${k}`}>{label}</label>
      <input id={`lt-o-${k}`} className="input" value={f[k] ?? ''} onChange={set(k)} {...props} /></div>
  );
  return (
    <form className="card lt-outlet-sheet md-form" onSubmit={save} aria-label={o ? o.name : 'Add an outlet'}>
      <div className="md-sheet__head">
        <h2 className="md-sheet__name">{o ? o.name : 'Add an outlet'}</h2>
        <button type="button" className="btn btn-quiet ot-btn-tap" onClick={onClose}>Close</button>
      </div>
      {field('name', 'Name', { required: true, maxLength: 160, autoFocus: !o })}
      <div className="field"><label htmlFor="lt-o-kind">Kind</label>
        <select id="lt-o-kind" className="input" value={f.kind} onChange={set('kind')}>{OUTLET_KINDS.map(([k, w]) => <option key={k} value={k}>{w}</option>)}</select></div>
      {field('letters_email', 'Letters email', { type: 'email', maxLength: 320, autoCapitalize: 'none', spellCheck: false, placeholder: 'letters@example.org' })}
      {field('letters_form', 'Or its letters form', { type: 'url', maxLength: 300, placeholder: 'https://…' })}
      {field('letters_limit', `Letters limit (${f.limit_unit === 'characters' ? 'characters' : 'words'})`, { type: 'number', min: 50, max: 3000, inputMode: 'numeric' })}
      <fieldset className="lt-fs">
        <legend className="lt-label">Asks for</legend>
        <label className="lt-check"><input type="checkbox" checked={!!f.asks_phone} onChange={set('asks_phone')} /><span>Phone</span></label>
        <label className="lt-check"><input type="checkbox" checked={!!f.asks_address} onChange={set('asks_address')} /><span>Address</span></label>
      </fieldset>
      <div className="field"><label htmlFor="lt-o-rules">Rules writers see</label>
        <textarea id="lt-o-rules" className="input" rows={2} maxLength={500} value={f.rules ?? ''} onChange={set('rules')} placeholder="Name and city printed; phone for checking" /></div>
      <More label="More details">
        {field('oped_email', 'Op-ed email', { type: 'email', maxLength: 320, autoCapitalize: 'none', spellCheck: false })}
        {field('oped_form', 'Or its op-ed form', { type: 'url', maxLength: 300, placeholder: 'https://…' })}
        {field('oped_limit', `Op-ed limit (${f.limit_unit === 'characters' ? 'characters' : 'words'})`, { type: 'number', min: 100, max: 6000, inputMode: 'numeric' })}
        <div className="field"><label htmlFor="lt-o-unit">Limit in</label>
          <select id="lt-o-unit" className="input" value={f.limit_unit} onChange={set('limit_unit')}><option value="words">Words</option><option value="characters">Characters</option></select></div>
        {field('newsroom', 'Newsroom', { maxLength: 160, placeholder: 'Papers that share one: the same name' })}
        {field('language', 'Language', { maxLength: 40 })}
        {field('website', 'Website', { type: 'url', maxLength: 300, placeholder: 'https://…' })}
        {field('subject_hint', 'Subject line it asks for', { maxLength: 80, placeholder: 'Letters' })}
        {SWITCHES.map(([k, w]) => <label key={k} className="lt-check"><input type="checkbox" checked={!!f[k]} onChange={set(k)} /><span>{w}</span></label>)}
      </More>
      {o && <p className="ops-meta">{o.confirmed_on ? `Rules checked ${dayWords(o.confirmed_on)}${o.confirmed_by_name ? ` by ${o.confirmed_by_name}` : ''}` : 'Rules not checked'}</p>}
      {act.error && <p className="error" role="alert">{act.error}</p>}
      <div className="md-acts">
        <button type="submit" className="btn ot-solid ot-btn-tap" disabled={act.busy || !online || !String(f.name).trim()}>{act.busy ? 'Saving…' : o ? 'Save' : 'Add'}</button>
        <button type="button" className="btn btn-quiet ot-btn-tap" disabled={act.busy || !online || !String(f.name).trim()} onClick={(e) => save(e, { checked: true })}>I checked these today</button>
        {o && !removing && <button type="button" className="btn btn-quiet ot-btn-tap" onClick={() => setRemoving(true)}>Remove</button>}
        {!online && <NeedsSignal className="ot-confirm-note" />}
      </div>
      {removing && (
        <div className="ot-confirm" role="group" aria-label="Confirm remove">
          <span>Take {o.name} off your outlets? Letters to it keep its name.</span>
          <button type="button" className="btn btn-quiet ot-btn-tap" disabled={act.busy || !online} onClick={remove}>Yes, remove</button>
          <button type="button" className="btn btn-quiet ot-btn-tap" onClick={() => setRemoving(false)}>No</button>
        </div>
      )}
    </form>
  );
}
