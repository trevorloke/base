// Outreach — two modules, one job each.
//   email    (like Mailchimp) Write an email — to the newsletter's
//            subscribers or to any list (a saved filter or hand-picked) —
//            with two subject lines to test, a test send, files; then what
//            went out: waiting, testing, the last send, opens and clicks.
//            More: past sends, the subscribers (add, remove), automations.
//   texting  (like CallHub) Write a text to a list; the Inbox of replies;
//            phone banks and Calls; texting settings (quiet hours).
// The header holds the module's one yellow action. Older addresses still
// work: /outreach/newsletter, /eblast and /press open Email; /texts opens
// Texting; /outreach/connect is where email and texting stand (and the
// campaign's website address), linked from the screens that need them.
// An open compose form is ?new=1. Every write invalidates and confirms.
import { useEffect, useId, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, action } from '../api.js';
import {
  AB_MIN, AbFields, OpensNote, SendStats, TestingList, abAsk, abPlan, abPlanLine, abState, hasLinks,
  useBlastStat, useBlastStats,
} from '../components/AbTests.jsx';
import LaddersLink from '../components/LaddersLink.jsx';
import { useTextingStatus } from '../components/TextingStatus.js';
import { NeedsSignal, useOnline } from '../components/NoSignal.jsx';
import { MarkdownField, toDataUrl, uploadImage } from '../components/MarkdownField.jsx';
import './outreach.css';
import { BRAND } from '../brand.js';

const TABS = [
  { key: 'email',   label: 'Email' },
  { key: 'texting', label: 'Texting' },
];
// The one yellow button in the header, per module.
const PRIMARY = {
  email: 'Write an email',
  texting: 'Write a text',
};
// Older addresses → the module that has them now.
const MOVED = { newsletter: 'email', eblast: 'email', press: 'email', texts: 'texting' };
// The email kinds a send can be (press releases sent before stay in the record).
const EMAIL_KINDS = ['newsletter', 'eblast', 'press'];
const kindIs = (k, want) => (Array.isArray(want) ? want.includes(k) : k === want);
const DESK_ROLES = ['manager', 'treasurer', 'staff'];
// Volunteers get 403 on /api/subscriptions, /api/blasts and signature lists,
// so they only see the tabs whose reads they're allowed.
const VOLUNTEER_TABS = new Set([]);

// Tab icons (24×24, stroke = currentColor), same hand as the phone tab bar.
const TAB_ICONS = {
  email: <><rect x="3.5" y="5.5" width="17" height="13" rx="1.5" /><path d="m4 7 8 6 8-6" /></>,
  texting: <><path d="M4 5.5h16v10H9l-4 3.5z" /><path d="M8 9h8M8 12h5" /></>,
  newsletter: <><rect x="3.5" y="5.5" width="17" height="13" rx="1.5" /><path d="m4 7 8 6 8-6" /></>,
  eblast: <><rect x="3.5" y="5.5" width="17" height="13" rx="1.5" /><path d="m4 7 8 6 8-6" /><path d="M7 15.5h4" /></>,
  texts: <><path d="M4 5.5h16v10H9l-4 3.5z" /><path d="M8 9h8M8 12h5" /></>,
  press: <><path d="M4 5.5h12v13H6a2 2 0 0 1-2-2z" /><path d="M16 9h3.5v7.5a2 2 0 0 1-2 2H16" /><path d="M7 9h6M7 12h6M7 15h4" /></>,
  connect: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.4 2.6 3.6 5.4 3.6 8.5s-1.2 5.9-3.6 8.5c-2.4-2.6-3.6-5.4-3.6-8.5S9.6 6.1 12 3.5z" /></>,
};
const TabIcon = ({ name }) => (
  <svg className="ot-tab-svg" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {TAB_ICONS[name]}
  </svg>
);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const origin = () => (typeof window !== 'undefined' ? window.location.origin : '');
const plural = (n, one, many) => (n === 1 ? one : many);

const fmtWhen = (ts) => {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const fmtDay = (ts) => {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
};

const slugify = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');

// Lighter normalizer for hand-typed slugs: keeps a trailing dash while typing.
const slugInput = (v) =>
  String(v || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').slice(0, 60);

// Where a subscriber came from, in plain words.
const sourceLabel = (s) => {
  if (!s) return null;
  if (s === 'signup-page') return 'signup page';
  return s.replace(/[-_:]+/g, ' ');
};
const KIND_LABEL = { newsletter: 'Newsletter', press: 'Press release', eblast: 'Email blast', text: 'Text' };
// The texting rules a blast follows (server: ext/texting/rules.js).
const TEXT_MAX = 1000;
const TEXT_FOOTER = 'Reply STOP to opt out';
// Files with a send (server: ext/abtests/attach.js — the same limits).
const ATTACH_MAX = 5 * 1024 * 1024;
const ATTACH_COUNT = 5;
const ATTACH_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.gif,.docx,.pptx,.xlsx,.txt,.csv,.ics';
const fmtBytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
// A picture in a message (blast.picture), so
// every mail app can fetch it from /media/<id>.
const uploadMessagePicture = (file) => uploadImage(file, 'blast.picture');
// Run an action with busy/error state; `onDone` gets the result.
function useAction(onDone) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (name, input) => {
    setBusy(true);
    setError(null);
    try {
      const res = await action(name, input);
      await onDone?.(res, name, input);
      return res;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, error, clearError: () => setError(null) };
}

// One toast at a time, auto-dismisses.
function useToast() {
  const [msg, setMsg] = useState(null);
  const timer = useRef(null);
  const show = (text, ms = 3500) => {
    clearTimeout(timer.current);
    setMsg(text);
    timer.current = setTimeout(() => setMsg(null), ms);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return { msg, show, clear: () => { clearTimeout(timer.current); setMsg(null); } };
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function CopyButton({ text, label = 'Copy', what, onCopied, className = '' }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const go = async () => {
    const ok = await copyText(text);
    if (!ok) { onCopied?.(false); return; }
    setCopied(true);
    onCopied?.(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  };
  return (
    <button
      type="button"
      className={`btn ot-copy ot-btn-tap ${className}`.trim()}
      data-copied={copied ? 'true' : 'false'}
      aria-label={what ? `${label} ${what}` : undefined}
      aria-live="polite"
      onClick={go}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

// "More" — a quiet toggle; what it reveals is only rendered when open.
function More({ label = 'More', defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className="ot-more-wrap">
      <button type="button" className="ot-more disclose" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        {label}
      </button>
      {open && <div id={id} className="ot-more-body">{children}</div>}
    </div>
  );
}

// A big number with a short label: "5 subscribers".
function Big({ n, one, many }) {
  return (
    <p className="ot-big">
      <span className="n">{n == null ? '…' : n}</span>
      <span className="lbl">{plural(n, one, many)}</span>
    </p>
  );
}

// A public page as a row: its name (opens it) and a Copy button.

function StatusChip({ status, label }) {
  const cls = status === 'sent' || status === 'subscribed' || status === 'active' ? 'chip chip-ok'
    : status === 'queued' ? 'chip ot-chip-queued'
    : status === 'failed' ? 'chip chip-danger'
    : 'chip ot-chip-ghost';
  return <span className={cls}>{label || status}</span>;
}

// ── What happened to a send, counted per recipient ──
// GET /api/blasts rows carry sent_count, failed_count and queued_count
// ('queued': saved while email wasn't connected — for a newsletter only the
// addresses still subscribed, the ones Send now would email). blast.send and
// blast.resend answer { blast, counts: { total, sent, failed, queued } }.
// An older server has neither, so the status says what it can: everyone
// sent → 'sent'; everyone failed → 'failed'; 'queued' with the no-provider
// note → nothing went out; any other 'queued' → partly sent (how many is
// unknown). Nothing saved sends by itself: once email is connected a person
// sends it — "Send now" for a saved one, "Try again" for the ones that
// failed (blast.resend retries both, never a 'sent' one). A send with a big
// list goes on in the background after the tap: going_count (counts.going)
// are on their way — "Sending · 40 of 340" — never "not sent", never tried
// again, and the list is read again every 2 s until they've gone.
const noProviderNote = (note) => /no (email|SMS) provider/i.test(note || '');
// What a send goes by: texts by texting, everything else by email.
const wayOf = (b) => (b?.kind === 'text' ? 'texting' : 'email');
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const countsOf = (b) => {
  if (!b) return null;
  // sending: no answer on record for these (the email service never
  // answered, or the server stopped mid-send) — not sure they went.
  if (b.counts) {
    return {
      total: num(b.counts.total) ?? 0, sent: num(b.counts.sent) ?? 0,
      failed: num(b.counts.failed) ?? 0, queued: num(b.counts.queued) ?? 0, sending: num(b.counts.sending) ?? 0,
      going: num(b.counts.going) ?? 0,
    };
  }
  const total = num(b.audience_count) ?? 0;
  if (num(b.sent_count) != null) {
    return {
      total, sent: num(b.sent_count), failed: num(b.failed_count) ?? 0, queued: num(b.queued_count) ?? 0,
      sending: num(b.sending_count) ?? 0, retry: num(b.retry_count), going: num(b.going_count) ?? 0,
    };
  }
  if (b.status === 'sent') return { total, sent: total, failed: 0, queued: 0 };
  if (b.status === 'failed') return { total, sent: 0, failed: total, queued: 0 };
  if (b.status === 'queued' && noProviderNote(b.provider_note)) return { total, sent: 0, failed: 0, queued: total };
  return { total, sent: null, failed: null, queued: 0 };
};
// Saved, and never went out: it waits on the first look under "Not sent".
const isWaiting = (b) => {
  const c = countsOf(b);
  return b?.status !== 'sent' && c.sent === 0 && c.failed === 0 && !c.sending && !c.going && c.queued > 0;
};
// The send list, read again every 2 s while a send is on its way (and the
// open/click stats once it has gone, so they match).
const anyGoing = (d) => (d?.blasts || []).some((b) => Number(b.going_count) > 0);
const useBlastList = () => {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ['blasts'],
    queryFn: async () => {
      const prev = qc.getQueryData(['blasts']);
      const next = await apiGet('/blasts');
      if (anyGoing(prev) && !anyGoing(next)) qc.invalidateQueries({ queryKey: ['blasts', 'stats'] });
      return next;
    },
    refetchInterval: (q) => (anyGoing(q.state.data) ? 2000 : false),
  });
};
// Who a retry would reach: the failed ones (and any still saved) — for a
// newsletter the server leaves out anyone who unsubscribed since (retry_count;
// it also counts the not-sure ones once they are ten minutes old).
const retryCount = (c) => (c && c.sent != null ? (c.retry ?? c.failed + c.queued) : 0);
// What isn't settled, in a few words: "1 failed · 2 not sent · 1 not sure".
const restWords = (c) => [
  c.failed ? `${c.failed} failed` : null, c.queued ? `${c.queued} not sent` : null, c.sending ? `${c.sending} not sure` : null,
].filter(Boolean).join(' · ');
// A/B: the rest a test holds for its winner, or that its winner is sending
// now — neither is "not sent", and neither is tried again.
const heldOf = (ab, fallback = 0) => (ab?.status === 'testing' ? (ab.rest?.held ?? fallback) : (ab?.rest?.going || 0));
// Why some didn't go out, in plain words — never the provider's raw reply.
const plainReason = (note) => {
  const t = String(note || '');
  if (/no SMS provider/i.test(t)) return 'Texting isn’t connected.';
  if (noProviderNote(t)) return 'Email isn’t connected.';
  if (/quiet hours/i.test(t)) return t;
  if (/unsubscribed/i.test(t)) return 'Everyone on it unsubscribed.';
  const code = Number((/provider (\d{3})/i.exec(t) || [])[1]) || 0;
  if (code === 429) return 'The email service was busy.';
  if (code === 401 || code === 403) return 'The email service refused the connection.';
  if (code >= 500) return 'The email service was down.';
  if (code >= 400) return 'The email service turned them down.';
  return 'The email service couldn’t be reached.';
};
const KIND_NOUN = { newsletter: ['subscriber', 'subscribers'], press: ['media contact', 'media contacts'], eblast: ['person', 'people'], text: ['number', 'numbers'] };
const nounFor = (kind, n) => plural(n, ...(KIND_NOUN[kind] || ['recipient', 'recipients']));
const audienceWords = (kind, n) => `${n} ${nounFor(kind, n)}`;
// Where "Connect" goes: the Links tab, with its More open on Email & texting.
const CONNECT_TO = '/outreach/connect?connect=1';
const ConnectLink = () => <Link className="ot-connect" to={CONNECT_TO}>Connect</Link>;
// A send's result as an object the screen can show: the blast plus its
// counts (and `resent` after a Send now / Try again: { sent, failed, skipped }).
const resultOf = (res) => (res?.blast ? { ...res.blast, counts: res.counts, resent: res.resent } : null);

// "Send to 3 subscribers now? Yes, send · No" — the quiet way to send a saved
// one (Send now) or the ones that failed (Try again). blast.resend sends only
// those, never anyone already sent.
function ResendButton({ b, n, label, ask, onDone, plainLabel = false }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const act = useAction(() => {
    queryClient.invalidateQueries({ queryKey: ['blasts'] });
  });
  const online = useOnline();
  const go = async () => {
    const res = await act.run('blast.resend', { id: b.id });
    setConfirming(false);
    if (res) onDone?.(resultOf(res));
  };
  return (
    <>
      {!confirming ? (
        <button type="button" className="btn btn-quiet ot-btn-tap" onClick={() => { setConfirming(true); act.clearError(); }}>
          {plainLabel ? label : `${label} · ${n}`}
        </button>
      ) : (
        <div className="ot-confirm" role="group" aria-label="Confirm send">
          <span>{ask || <>Send to <strong>{n}</strong> {nounFor(b.kind, n)} now?</>}</span>
          <button type="button" className="btn ot-solid ot-btn-tap" disabled={act.busy || !online} onClick={go}>
            {act.busy ? 'Sending…' : 'Yes, send'}
          </button>
          <button type="button" className="btn btn-quiet ot-btn-tap" disabled={act.busy} onClick={() => setConfirming(false)}>No</button>
          {!online && <NeedsSignal className="ot-confirm-note" />}
        </div>
      )}
      {act.error && <p className="error">{act.error}</p>}
    </>
  );
}

// The one place a send's outcome is said, counted per recipient:
// "Sent to 2 subscribers." · "Sent to 1 of 2 subscribers — 1 failed." ·
// "Failed — 2 subscribers not reached." · "Saved for 2 subscribers — not sent."
function BlastResult({ blast: answered, emailConfigured, canWrite, onDismiss, onRetried }) {
  const stat = useBlastStat(answered?.id);
  // Still going when the tap answered: the send as the list has it now.
  const list = useBlastList();
  const row = answered && list.data?.blasts?.find((b) => b.id === answered.id);
  const blast = row && (num(answered.counts?.going) > 0 || num(row.going_count) > 0)
    ? { ...answered, ...row, counts: null } : answered;
  if (!blast) return null;
  const c = countsOf(blast);
  const who = (n) => audienceWords(blast.kind, n);
  const gone = blast.resent?.skipped || 0;
  let line;
  let tone;
  if (c.total === 0) { line = 'Not sent — everyone on it unsubscribed.'; tone = 'failed'; }
  else if (c.sent == null) { line = `Partly sent to ${who(c.total)}.`; tone = 'queued'; }
  else if (c.sent === c.total) { line = `Sent to ${who(c.total)}.`; tone = 'sent'; }
  else if (c.sent > 0) {
    const rest = restWords(c);
    line = `Sent to ${c.sent} of ${who(c.total)}${rest ? ` — ${rest}` : ''}.`;
    tone = 'queued';
  } else if (c.failed > 0) { line = `Failed — ${who(c.failed)} not reached.`; tone = 'failed'; }
  else if (c.sending > 0) { line = `Not sure it went — ${who(c.sending)}.`; tone = 'queued'; }
  else { line = `Saved for ${who(c.total)} — not sent.`; tone = 'queued'; }
  // A/B (components/AbTests.jsx): a started test says where it stands; the
  // rest it holds for the winner are not "not sent" and not retried.
  const ab = stat?.ab || blast.ab || null;
  const abNow = abState(ab, stat, c);
  if (abNow) { line = /\.$/.test(abNow.line) ? abNow.line : `${abNow.line}.`; tone = abNow.tone; }
  const held = heldOf(stat?.ab || ab, Math.max(0, c.queued - c.going));
  // On its way (the rest of a big list): how many have gone so far.
  const going = c.going > 0;
  if (going) { line = `Sending · ${c.sent} of ${who(c.total - (ab?.status === 'testing' ? held : 0))}.`; tone = 'queued'; }
  const unsent = c.total > 0 && c.sent === 0 && c.failed === 0 && !c.sending && !going;
  const saved = ab?.status === 'saved';
  const retry = retryCount(c) - held;
  const canRetry = canWrite && emailConfigured === true && !unsent && !going && retry > 0 && !!blast.id;
  return (
    <div className="ot-result" data-status={tone} role="status">
      <div className="ot-result-head">
        <span className="ot-status-dot" data-status={tone} aria-hidden="true" />
        <strong>
          {line}
          {gone > 0 && c.total > 0 && <span className="ot-result-next"> {gone} unsubscribed first.</span>}
          {unsent && emailConfigured !== true && (
            <span className="ot-result-next"> <Link to={CONNECT_TO}>Connect {wayOf(blast)}</Link>, then {saved ? 'Start test' : 'Send now'}.</span>
          )}
        </strong>
        {onDismiss && <button type="button" className="btn btn-quiet ot-btn-tap" onClick={onDismiss}>OK</button>}
      </div>
      {ab?.status === 'testing' && !going && <div className="ot-result-why">A and B went to {c.sent} of {who(c.total)}.</div>}
      {saved && <div className="ot-result-why">{abPlanLine(abPlan(c.total, ab.pct), ab.wait_hours)}</div>}
      {c.sending > 0 && !going && <div className="ot-result-why">We don’t know if {c.sending} got it.</div>}
      {!unsent && !going && (c.failed > 0 || c.sent == null) && c.total > 0 && (
        <div className="ot-result-why">
          {plainReason(blast.provider_note)}
          {emailConfigured === false && <> <Link to={CONNECT_TO}>Connect {wayOf(blast)}</Link>, then try again.</>}
        </div>
      )}
      {canRetry && (
        <div className="ot-result-acts">
          <ResendButton b={blast} n={retry} label="Try again" onDone={onRetried} />
        </div>
      )}
    </div>
  );
}

// Compose shared by newsletter + press: subject, message, Send. The
// message is Markdown with the editor's toolbar (bold, italic,
// heading, link, list, picture, "Link to…" the campaign's pages) and a
// Preview that is the email's layout; files can go with it (5 at most,
// 5 MB each); "Send me a test" emails the writer a copy first. Sending asks
// once, in one line ("Send to 5 subscribers? Yes, send · No"). The server
// refuses an empty audience, so Send waits until there is someone to send to.
// Whatever happens the send is kept (sent, failed or saved), so the form
// closes and the result is said once under the tabs — a failed one is tried
// again from there, never sent a second time as a new copy.
function ComposeCard({ kind, slug, audience, audienceCount, audienceNoun, emptyReason, emailConfigured, onSent, onCancel, campaign }) {
  const queryClient = useQueryClient();
  const isText = kind === 'text';
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [confirming, setConfirming] = useState(false);
  // Files uploaded for this send: [{ id, filename, bytes }], bound on Send.
  const [files, setFiles] = useState([]);
  const [fileNote, setFileNote] = useState(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);
  // "Send me a test": what happened, in a line.
  const [test, setTest] = useState(null);
  // Two subject lines (components/AbTests.jsx): null = one; a list under 50 sends normally.
  const [ab, setAb] = useState(null);
  const act = useAction(() => {
    queryClient.invalidateQueries({ queryKey: ['blasts'] });
  });

  const testing = ab != null && audienceCount != null && audienceCount >= AB_MIN;
  // Winner by clicks needs a link in the message; without one it's by opens.
  const links = hasLinks(body);
  const plan = testing ? abPlan(audienceCount, ab.pct) : null;
  const textLen = body.trim().length + (body.trim() ? TEXT_FOOTER.length + 1 : 0);
  const textOk = !isText || (textLen <= TEXT_MAX && (!campaign || body.toLowerCase().includes(String(campaign).toLowerCase())));
  const ready = (isText || subject.trim().length > 0) && body.trim().length > 0 && textOk
    && (ab == null || audienceCount != null) && (!testing || ab.subject_b.trim().length > 0) && (!audience || audienceCount != null);
  const empty = audienceCount === 0;
  const noun = (n) => plural(n, audienceNoun.one, audienceNoun.many);
  // Without email connected nothing goes out — say so before, not after.
  const offline = emailConfigured === false;
  // No signal: nothing can go now (or be saved) — Yes is off, and says so.
  const online = useOnline();

  // A tap that got no answer (the server went down mid-send) may still be on
  // record, partly sent: look for it — a new send of this kind and subject —
  // and show it as it stands, so the next tap is its Try again (same people,
  // same keys), never a second copy. `before`: the sends known at the first
  // tap since a send last answered.
  const before = useRef(null);
  const unanswered = useRef(false);
  const onRecord = async () => {
    if (!before.current) return null;
    const list = await apiGet('/blasts').catch(() => null);
    return list?.blasts?.find((b) => b.kind === kind && b.subject === subject.trim() && !before.current.has(b.id)) || null;
  };
  const send = async () => {
    const known = queryClient.getQueryData(['blasts'])?.blasts;
    if (!before.current && known) before.current = new Set(known.map((b) => b.id));
    const kept = unanswered.current ? await onRecord() : null;
    if (kept) { setConfirming(false); onSent?.(kept); return; }
    const res = await act.run('blast.send', {
      kind, subject: isText ? '' : subject.trim(), body: body.trim(),
      ...(audience ? { audience } : {}),
      ...(testing && !isText ? { ab: { ...ab, subject_b: ab.subject_b.trim(), metric: links ? ab.metric : 'opens' } } : {}),
      ...(files.length && !isText ? { attachment_ids: files.map((f) => f.id) } : {}),
    });
    setConfirming(false);
    if (!res) {
      unanswered.current = true;
      const late = await onRecord();
      if (late) onSent?.(late);
      return;
    }
    before.current = null;
    unanswered.current = false;
    onSent?.(resultOf(res));
  };

  // Files: each goes up as it is picked (blast.attach) and is listed by
  // name; Remove takes it back. Too big or not a kind the server takes is
  // said here, the rest kept.
  const pickFiles = async (e) => {
    const picked = [...(e.target.files || [])];
    e.target.value = '';
    if (!picked.length) return;
    setFileNote(null);
    setUploading(true);
    const added = [];
    try {
      for (const f of picked) {
        if (files.length + added.length >= ATTACH_COUNT) throw new Error(`${ATTACH_COUNT} files at most on one send`);
        if (f.size > ATTACH_MAX) throw new Error(`${f.name} is too big — ${fmtBytes(ATTACH_MAX)} at most; link to it instead`);
        const r = await action('blast.attach', { data: await toDataUrl(f), name: f.name });
        added.push(r.attachment);
      }
    } catch (err) {
      setFileNote(err.message);
    } finally {
      if (added.length) setFiles((cur) => [...cur, ...added]);
      setUploading(false);
    }
  };
  const dropFile = (a) => {
    setFiles((cur) => cur.filter((x) => x.id !== a.id));
    action('blast.unattach', { id: a.id }).catch(() => {});
  };
  const sendTest = async () => {
    setTest({ busy: true });
    try {
      const r = await action('blast.test', {
        kind, subject: subject.trim(), body: body.trim(), ...(files.length ? { attachment_ids: files.map((f) => f.id) } : {}),
      });
      setTest(r.sent ? { ok: true, line: `Test sent to ${r.to}` } : { line: r.detail || 'The test didn’t go' });
    } catch (err) {
      setTest({ line: err.message });
    }
  };

  return (
    <form className="card ot-compose" onSubmit={(e) => { e.preventDefault(); if (ready && !empty && !confirming) setConfirming(true); }}>
      {isText ? (
        <div className="field">
          <label htmlFor="text-body">Message</label>
          <textarea id="text-body" className="input ot-textbody" rows={5} value={body} maxLength={TEXT_MAX}
            onChange={(e) => { setBody(e.target.value); setConfirming(false); }}
            placeholder={`Hi, it's ${campaign || 'the campaign'} — `} />
          <span className="ops-meta">
            <span className={`mono${textLen > TEXT_MAX ? ' error' : ''}`}>{textLen}/{TEXT_MAX}</span> · “{TEXT_FOOTER}” goes on the end of each.
            {campaign && !body.toLowerCase().includes(String(campaign).toLowerCase()) && body.trim() && <> Say it’s {campaign} in the text.</>}
          </span>
        </div>
      ) : (
      <div className="field">
        <label htmlFor={`${kind}-subject`}>{testing ? 'Subject A' : 'Subject'}</label>
        <input id={`${kind}-subject`} className="input" value={subject} maxLength={300} autoFocus
          onChange={(e) => { setSubject(e.target.value); setConfirming(false); }}
          placeholder={kind === 'press' ? 'Campaign unveils transit plan' : 'This week on the campaign'} />
      </div>
      )}
      {!isText && <AbFields idPrefix={kind} audienceCount={audienceCount} noun={noun} value={ab} links={links}
        onChange={(v) => { setAb(v); setConfirming(false); }} />}
      {!isText && <MarkdownField id={`${kind}-body`} label="Message" value={body} rows={10}
        onChange={(v) => { setBody(v.slice(0, 50000)); setConfirming(false); }}
        upload={uploadMessagePicture}
        placeholder={kind === 'press' ? 'FOR IMMEDIATE RELEASE …' : 'Hello friends,'} />}
      {!isText && <div className="ot-attach">
        <input ref={fileRef} type="file" multiple hidden accept={ATTACH_ACCEPT} onChange={pickFiles} />
        {files.length > 0 && (
          <ul className="ot-files" aria-label="Files with this send">
            {files.map((a) => (
              <li key={a.id} className="ot-file">
                <span className="ot-file__name">{a.filename}</span>
                <span className="ot-file__size">{fmtBytes(a.bytes)}</span>
                <button type="button" className="btn btn-quiet" onClick={() => dropFile(a)} aria-label={`Remove ${a.filename}`}>✕</button>
              </li>
            ))}
          </ul>
        )}
        <div className="ot-attach__row">
          <button type="button" className="btn btn-quiet ot-btn-tap" disabled={uploading || files.length >= ATTACH_COUNT || !online}
            onClick={() => fileRef.current?.click()}>
            {uploading ? 'Uploading…' : 'Attach a file'}
          </button>
          <span className="ot-attach__hint">PDF, pictures, Word, Excel, PowerPoint, .ics, .txt or .csv — {fmtBytes(ATTACH_MAX)} each, {ATTACH_COUNT} files</span>
        </div>
        {fileNote && <p className="error" role="alert">{fileNote}</p>}
      </div>}
      {act.error && <p className="error">{act.error}</p>}
      {empty && emptyReason && <p className="ot-note">{emptyReason}</p>}
      <div className="ot-foot">
        {confirming ? (
          <div className="ot-confirm" role="group" aria-label="Confirm send">
            <span>{testing && !offline ? abAsk(plan, ab.wait_hours)
              : <>{offline ? 'Save for' : 'Send to'} <strong>{audienceCount}</strong> {noun(audienceCount)}?</>}</span>
            <button type="button" className="btn btn-primary ot-btn-tap" disabled={act.busy || !online} onClick={send}>
              {act.busy ? (offline ? 'Saving…' : 'Sending…') : offline ? 'Yes, save' : 'Yes, send'}
            </button>
            <button type="button" className="btn btn-quiet ot-btn-tap" disabled={act.busy} onClick={() => setConfirming(false)}>No</button>
            {/* No Connect link here: leaving would drop the draft. */}
            {offline && online && <span className="ot-confirm-note">{isText ? 'Texting' : 'Email'} isn’t connected — nothing is sent.</span>}
            {!online && <NeedsSignal className="ot-confirm-note" />}
          </div>
        ) : (
          <>
            <button type="submit" className="btn btn-primary ot-btn-tap" disabled={!ready || empty || act.busy}>
              {offline ? 'Save — not sent yet' : 'Send'}
            </button>
            <span className="ot-audience">
              {audienceCount == null ? '…' : `${audienceCount} ${noun(audienceCount)}`}
            </span>
            {!offline && !isText && (
              <button type="button" className="btn btn-quiet ot-btn-tap" disabled={!ready || test?.busy || uploading || !online} onClick={sendTest}>
                {test?.busy ? 'Sending…' : 'Send me a test'}
              </button>
            )}
            <span className="spacer" />
            <button type="button" className="btn btn-quiet ot-btn-tap" onClick={onCancel}>Cancel</button>
          </>
        )}
      </div>
      {test?.line && <p className={test.ok ? 'ot-test-note' : 'error'} role="status">{test.line}</p>}
    </form>
  );
}

// ── Past sends: one row each, "1 of 2 reached" ──
// The row says how many it reached; one that didn't reach everyone offers a
// quiet "Try again · N" once email is connected, and says the outcome right
// there (this list lives under More, far from the top).
function PastRow({ b, showKind, emailConfigured, canWrite }) {
  const [result, setResult] = useState(null);
  const stat = useBlastStat(b.id);
  const c = countsOf(b);
  const allSent = b.status === 'sent' || (c.sent != null && c.total > 0 && c.sent === c.total);
  let reach;
  let chip;
  if (c.sent == null) { reach = audienceWords(b.kind, c.total); chip = { status: 'queued', label: 'partly sent' }; }
  else if (allSent) { reach = audienceWords(b.kind, c.total); chip = { status: 'sent', label: 'sent' }; }
  else if (c.sent === 0 && c.failed === 0 && !c.sending) { reach = c.total > 0 ? `saved for ${audienceWords(b.kind, c.total)}` : 'saved'; chip = { status: 'ghost', label: 'not sent' }; }
  else { reach = `${c.sent} of ${c.total} reached`; chip = c.sent > 0 || c.sending > 0 ? { status: 'queued', label: 'partly sent' } : { status: 'failed', label: 'failed' }; }
  // A/B: a running test holds the rest for the winner, and a picked winner
  // is sent to them by itself — neither is "partly sent", neither is retried.
  const ab = stat?.ab || null;
  const abNow = abState(ab, stat, c);
  const held = heldOf(ab);
  if (ab?.status === 'testing') { reach = audienceWords(b.kind, c.total); chip = { status: 'queued', label: 'testing' }; }
  else if (held > 0) { reach = audienceWords(b.kind, c.total); chip = { status: 'queued', label: 'sending' }; }
  // On its way (the rest of a big list): how many have gone so far.
  const going = c.going > 0;
  if (going) { reach = `${c.sent} of ${c.total} sent so far`; chip = { status: 'queued', label: 'sending' }; }
  const retry = retryCount(c) - held;
  const canRetry = canWrite && emailConfigured === true && !allSent && !going && retry > 0 && !result;
  let why = null;
  if (going) why = null;
  else if (!allSent && c.failed > 0) why = plainReason(b.provider_note);
  else if (!allSent && c.sending > 0 && !held) why = `We don’t know if ${c.sending} got it.`;
  else if (!allSent && c.sent === 0 && c.failed === 0) why = 'Everyone on it unsubscribed.';
  return (
    <li className="ot-item">
      <div className="ot-row ot-row--static ot-row--wrap">
        <span className="ot-row__main">
          <span className="ot-row__name">{b.subject}</span>
          <span className="ot-row__sub">
            {showKind && <span>{KIND_LABEL[b.kind] || b.kind}</span>}
            <span>{reach}</span>
            <span>{fmtWhen(b.sent_at || b.created_at)}</span>
            {b.attachments?.length > 0 && (
              <span className="ot-row__files" title={b.attachments.map((a) => a.filename).join(', ')}>
                {b.attachments.length === 1 ? b.attachments[0].filename : `${b.attachments.length} files`}
              </span>
            )}
          </span>
          {ab && <span className="ab-b">B · {ab.subject_b}</span>}
          {abNow && <span className="ab-line" data-tone={abNow.tone}>{abNow.line}</span>}
          <SendStats stat={stat} />
          {why && <span className="ot-row-note">{why}</span>}
        </span>
        <StatusChip status={chip.status} label={chip.label} />
      </div>
      {(canRetry || result) && (
        <div className="ot-body">
          {canRetry && <ResendButton b={b} n={retry} label="Try again" onDone={setResult} />}
          {result && (
            <BlastResult blast={result} emailConfigured={emailConfigured} canWrite={canWrite}
              onDismiss={() => setResult(null)} onRetried={setResult} />
          )}
        </div>
      )}
    </li>
  );
}

// Past newsletters and press releases, newest first. Saves that never went
// out are not here: they sit on the first look under "Not sent".
function PastList({ blasts, loading, kindFilter, emailConfigured, canWrite }) {
  const rows = (blasts || []).filter((b) => (!kindFilter || kindIs(b.kind, kindFilter)) && !isWaiting(b));
  if (loading) return <p className="ot-note">Loading…</p>;
  if (rows.length === 0) return <p className="ot-empty">Nothing sent yet.</p>;
  return (
    <ul className="ot-list">
      {rows.map((b) => (
        <PastRow key={b.id} b={b} showKind={!kindFilter || Array.isArray(kindFilter)} emailConfigured={emailConfigured} canWrite={canWrite} />
      ))}
    </ul>
  );
}

// The latest send that went out, on the tab's first look: one row with how
// it did ("Opened 18% · Clicked 8%"). A test still running has its own
// section; a send whose result is on screen isn't said twice.
function LastSent({ blasts, kind, skip, emailConfigured, canWrite }) {
  const stats = useBlastStats();
  if (!stats.data) return null;
  const testing = (id) => stats.data.stats?.find((s) => s.id === id)?.ab?.status === 'testing';
  const b = (blasts || []).find((x) => kindIs(x.kind, kind) && !isWaiting(x) && !testing(x.id));
  if (!b || b.id === skip) return null;
  return (
    <section className="ot-sec" aria-label="Last sent">
      <h2 className="ot-sec-h">Last sent</h2>
      <ul className="ot-list">
        <PastRow b={b} emailConfigured={emailConfigured} canWrite={canWrite} />
      </ul>
    </section>
  );
}

// Saved while email wasn't connected: nothing went out, and nothing goes out
// by itself. Once email is connected each row offers a quiet "Send now · N"
// (N: the ones it would email now — a newsletter subscriber who unsubscribed
// since is left off), asked once in place.
function UnsentRow({ b, emailConfigured, canWrite, onResent }) {
  const n = countsOf(b).queued;
  const canSend = canWrite && emailConfigured === true;
  const [open, setOpen] = useState(false);
  // A saved A/B send: Send now starts the test — A and B now, the winner later.
  const stat = useBlastStat(b.id);
  const ab = stat?.ab?.status === 'saved' ? stat.ab : null;
  const notSent = emailConfigured ? 'Not sent' : `Not sent — ${wayOf(b)} isn’t connected`;
  // The plan, before anyone taps: who gets A, who gets B, who gets the winner.
  const plan = ab ? { a: ab.a.total, b: ab.b.total, rest: ab.rest.total } : null;
  return (
    <li className="ot-item" data-open={ab && open ? '' : undefined}>
      {ab ? (
        // Two subject lines: the subject, the plan and where it stands; Subject
        // B and when it was saved one tap away.
        <button type="button" className="ot-row" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className="ot-row__main">
            <span className="ot-row__name">{b.subject}</span>
            <span className="ab-line" data-testid="ab-plan">{abPlanLine(plan, ab.wait_hours)}</span>
            {!emailConfigured && <span className="ot-row-note">{notSent}</span>}
          </span>
          {emailConfigured && <StatusChip status="ghost" label="not sent" />}
        </button>
      ) : (
        <div className="ot-row ot-row--static ot-row--wrap">
          <span className="ot-row__main">
            <span className="ot-row__name">{b.subject}</span>
            <span className="ot-row__sub">
              <span>{audienceWords(b.kind, n)}</span>
              <span>saved {fmtWhen(b.created_at)}</span>
            </span>
            <span className="ot-row-note">{notSent}</span>
          </span>
        </div>
      )}
      {ab && open && (
        <div className="ot-body" data-testid="ab-saved-more">
          <span className="ab-b">B · {ab.subject_b}</span>
          <span className="ab-b">{audienceWords(b.kind, n)} · saved {fmtWhen(b.created_at)}</span>
        </div>
      )}
      {canSend && (
        <div className="ot-body">
          {ab ? (
            <ResendButton b={b} label="Start test" plainLabel onDone={onResent} ask={abAsk(plan, ab.wait_hours)} />
          ) : <ResendButton b={b} n={n} label="Send now" onDone={onResent} />}
        </div>
      )}
    </li>
  );
}

function UnsentList({ blasts, kind, emailConfigured, canWrite, onResent }) {
  const rows = (blasts || []).filter((b) => kindIs(b.kind, kind) && isWaiting(b));
  if (rows.length === 0) return null;
  return (
    <section className="ot-sec" aria-label="Not sent">
      <h2 className="ot-sec-h">Not sent <span className="ot-count">{rows.length}</span></h2>
      <ul className="ot-list">
        {rows.map((b) => (
          <UnsentRow key={b.id} b={b} emailConfigured={emailConfigured} canWrite={canWrite} onResent={onResent} />
        ))}
      </ul>
    </section>
  );
}

// Provider status, said once (lives under More).
function EmailStatus({ configured }) {
  if (configured == null) return null;
  return (
    <p className="ot-pay">
      <span className="ot-status-dot" data-status={configured ? 'sent' : 'queued'} aria-hidden="true" />
      {configured ? 'Email connected' : <>Email not connected · <ConnectLink /></>}
    </p>
  );
}

function TextStatus({ configured, quiet }) {
  if (configured == null) return null;
  return (
    <p className="ot-pay">
      <span className="ot-status-dot" data-status={configured ? 'sent' : 'queued'} aria-hidden="true" />
      {configured ? <>Texting connected{quiet ? ` · texts go ${quiet.label} (${quiet.weekends} on weekends)` : ''}</> : <>Texting not connected · <ConnectLink /></>}
    </p>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL BLAST · TEXTS — to a list (Lists: a saved filter or a hand-picked list)
// ─────────────────────────────────────────────────────────────────────────────
function ListBlastTab({ kind, me, canWrite, creating, onClose }) {
  const blastKind = kind === 'texts' ? 'text' : 'eblast';
  const reach = blastKind === 'text' ? 'with_phone' : 'with_email';
  const [params] = useSearchParams();
  const lists = useQuery({ queryKey: ['lists', 'all'], queryFn: () => apiGet('/lists') });
  const blasts = useBlastList();
  const texting = useQuery({ queryKey: ['texting', 'settings'], queryFn: () => apiGet('/texting/settings'), enabled: blastKind === 'text' });
  const [listId, setListId] = useState(params.get('list') || '');
  const [result, setResult] = useState(null);
  const composing = canWrite && creating;
  const all = lists.data?.lists ?? [];
  const chosen = all.find((l) => l.id === listId) || null;
  const configured = blastKind === 'text' ? blasts.data?.textConfigured : blasts.data?.emailConfigured;
  const count = chosen ? chosen.counts[reach] : (lists.isSuccess && !listId ? 0 : null);
  const noun = blastKind === 'text' ? { one: 'number', many: 'numbers' } : { one: 'person', many: 'people' };
  const quiet = texting.data?.quiet;

  return (
    <>
      {composing && (
        <div className="card ot-audience">
          <div className="field">
            <label htmlFor={`${kind}-list`}>To</label>
            <select id={`${kind}-list`} className="input" value={listId} onChange={(e) => setListId(e.target.value)}>
              <option value="">Choose a list…</option>
              {all.map((l) => <option key={l.id} value={l.id}>{l.name} — {l.counts[reach]} {plural(l.counts[reach], noun.one, noun.many)}</option>)}
            </select>
            <span className="ops-meta">
              {lists.isSuccess && !all.length ? <>No lists yet. </> : null}
              <Link to="/lists">Lists</Link> — a saved filter (a tag, a rating, a role) or a hand-picked list.
              {blastKind === 'text' ? ' Numbers that replied STOP, do-not-text and do-not-contact are left out.' : ' Do-not-email, do-not-contact and unsubscribed addresses are left out.'}
            </span>
          </div>
          {blastKind === 'text' && quiet?.now && <p className="ot-note">Quiet hours — sending opens at {quiet.opens}. A text sent now waits until then.</p>}
        </div>
      )}
      {composing && (
        <ComposeCard
          kind={blastKind}
          slug={me.workspace.slug}
          campaign={me.workspace.name}
          audience={listId ? { list_id: listId } : null}
          audienceCount={listId ? count : null}
          audienceNoun={noun}
          emptyReason={listId ? `No one on this list can be ${blastKind === 'text' ? 'texted' : 'emailed'}.` : 'Choose a list first.'}
          emailConfigured={configured}
          onCancel={onClose}
          onSent={(b) => { setResult(b); onClose(); }}
        />
      )}
      <BlastResult blast={result} emailConfigured={configured} canWrite={canWrite}
        onDismiss={() => setResult(null)} onRetried={setResult} />
      {!composing && (
        <>
          <Big n={all.length} one="list" many="lists" />
          <ul className="ot-list">
            <li className="ot-item"><Link className="ot-row" to="/lists"><span className="ot-row__main"><span className="ot-row__name">Lists</span><span className="ot-row__sub"><span>who a send goes to</span></span></span></Link></li>
          </ul>
          <UnsentList blasts={blasts.data?.blasts} kind={blastKind} emailConfigured={configured} canWrite={canWrite} onResent={setResult} />
          {blastKind === 'eblast' && <TestingList blasts={blasts.data?.blasts} kind={blastKind} skip={result?.id} />}
          <LastSent blasts={blasts.data?.blasts} kind={blastKind} skip={result?.id} emailConfigured={configured} canWrite={canWrite} />
        </>
      )}
      {!composing && <More>
        {blastKind === 'text' ? <TextStatus configured={configured} quiet={quiet} /> : <EmailStatus configured={configured} />}
        <section className="ot-sec" aria-label="Past sends">
          <h2 className="ot-sec-h">Past sends</h2>
          {blasts.isError && <p className="error">{blasts.error.message}</p>}
          <PastList blasts={blasts.data?.blasts} loading={blasts.isPending} kindFilter={blastKind}
            emailConfigured={configured} canWrite={canWrite} />
          {blastKind === 'eblast' && <OpensNote />}
        </section>
      </More>}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL — the newsletter's subscribers or any list; what went out
// ─────────────────────────────────────────────────────────────────────────────
function EmailTab({ me, canWrite, creating, onClose, toast }) {
  const [params] = useSearchParams();
  const subs = useQuery({ queryKey: ['subscriptions'], queryFn: () => apiGet('/subscriptions') });
  const lists = useQuery({ queryKey: ['lists', 'all'], queryFn: () => apiGet('/lists') });
  const blasts = useBlastList();
  // Who it goes to: 'newsletter' (the subscribers) or a list's id.
  const [to, setTo] = useState(params.get('list') || 'newsletter');
  const [result, setResult] = useState(null);
  const composing = canWrite && creating;
  const all = lists.data?.lists ?? [];
  const isNews = to === 'newsletter';
  const chosen = isNews ? null : all.find((l) => l.id === to) || null;
  const subscribed = subs.data?.subscribed ?? null;
  const emailConfigured = blasts.data?.emailConfigured;
  const count = isNews ? subscribed : chosen ? chosen.counts.with_email : null;

  return (
    <>
      {composing && (
        <div className="card ot-audience">
          <div className="field">
            <label htmlFor="em-to">To</label>
            <select id="em-to" className="input" value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="newsletter">Newsletter subscribers — {subscribed ?? '…'}</option>
              {all.map((l) => <option key={l.id} value={l.id}>{l.name} — {l.counts.with_email} {plural(l.counts.with_email, 'person', 'people')}</option>)}
            </select>
            <span className="ops-meta">
              The newsletter: everyone who signed up. A list: a saved filter or hand-picked people (<Link to="/lists">Lists</Link>).
              Do-not-email, do-not-contact and unsubscribed addresses are left out.
            </span>
          </div>
        </div>
      )}
      {composing && (
        <ComposeCard
          kind={isNews ? 'newsletter' : 'eblast'}
          slug={me.workspace.slug}
          campaign={me.workspace.name}
          audience={isNews ? undefined : { list_id: to }}
          audienceCount={count}
          audienceNoun={isNews ? { one: 'subscriber', many: 'subscribers' } : { one: 'person', many: 'people' }}
          emptyReason={isNews ? 'No subscribers yet — share the signup page first.' : 'No one on this list can be emailed.'}
          emailConfigured={emailConfigured}
          onCancel={onClose}
          onSent={(b) => { setResult(b); onClose(); }}
        />
      )}
      <BlastResult blast={result} emailConfigured={emailConfigured} canWrite={canWrite}
        onDismiss={() => setResult(null)} onRetried={setResult} />
      {!composing && (
        <>
          <Big n={subscribed} one="subscriber" many="subscribers" />
          <ul className="ot-list">
            <li className="ot-item"><Link className="ot-row" to="/lists"><span className="ot-row__main"><span className="ot-row__name">Lists</span><span className="ot-row__sub"><span>{all.length} {plural(all.length, 'list', 'lists')} — who else an email can go to</span></span></span></Link></li>
          </ul>
          <UnsentList blasts={blasts.data?.blasts} kind={EMAIL_KINDS} emailConfigured={emailConfigured} canWrite={canWrite} onResent={setResult} />
          <TestingList blasts={blasts.data?.blasts} kind={EMAIL_KINDS} skip={result?.id} />
          <LastSent blasts={blasts.data?.blasts} kind={EMAIL_KINDS} skip={result?.id} emailConfigured={emailConfigured} canWrite={canWrite} />
        </>
      )}
      {!composing && <More>
        <EmailStatus configured={emailConfigured} />
        <section className="ot-sec" aria-label="Past sends">
          <h2 className="ot-sec-h">Past sends</h2>
          {blasts.isError && <p className="error">{blasts.error.message}</p>}
          <PastList blasts={blasts.data?.blasts} loading={blasts.isPending} kindFilter={EMAIL_KINDS}
            emailConfigured={emailConfigured} canWrite={canWrite} />
          <OpensNote />
        </section>
        <Subscribers subs={subs} canWrite={canWrite} toast={toast} />
      </More>}
    </>
  );
}

// The newsletter's subscribers: who, from where; add one; remove one.
function Subscribers({ subs, canWrite, toast }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [removing, setRemoving] = useState(null);
  const act = useAction(() => {
    queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
    queryClient.invalidateQueries({ queryKey: ['brief'] });
  });

  const list = subs.data?.subscriptions ?? [];
  const subscribed = subs.data?.subscribed ?? null;
  const unsubscribed = subs.data?.unsubscribed ?? 0;
  const visible = showAll ? list : list.slice(0, 50);

  const add = async (e) => {
    e.preventDefault();
    const res = await act.run('subscription.add', { email: email.trim(), name: name.trim() || undefined });
    if (!res) return;
    toast(`Added ${email.trim()}`);
    setEmail(''); setName('');
  };
  // Off the list is for good from here: only they can rejoin (signup page),
  // so Remove asks first and there is no Re-subscribe.
  const remove = async (s) => {
    const res = await act.run('subscription.remove', { id: s.id });
    setRemoving(null);
    if (res) toast(`Unsubscribed ${s.email}`);
  };

  return (
        <section className="ot-sec" aria-label="Subscribers">
          <h2 className="ot-sec-h">Subscribers <span className="ot-count">{subs.isPending ? '…' : subscribed}{unsubscribed > 0 && ` · ${unsubscribed} unsubscribed`}</span></h2>
          {subs.isError && <p className="error">{subs.error.message}</p>}
          {list.length === 0 && !subs.isPending && <p className="ot-empty">No subscribers yet.</p>}
          {list.length > 0 && (
            <ul className="ot-list">
              {visible.map((s) => (
                <li key={s.id} className="ot-item" data-tone={s.status !== 'subscribed' ? 'past' : undefined}>
                  <div className="ot-row ot-row--static">
                    <span className="ot-row__main">
                      <span className="ot-row__name ot-email">{s.email}</span>
                      <span className="ot-row__sub">
                        {s.name && <span>{s.name}</span>}
                        {sourceLabel(s.source) && <span>{sourceLabel(s.source)}</span>}
                        <span>{s.status === 'subscribed' || !s.unsubscribed_at ? fmtDay(s.created_at) : `Left ${fmtDay(s.unsubscribed_at)}`}</span>
                      </span>
                    </span>
                    {s.status !== 'subscribed' && <StatusChip status={s.status} />}
                    {canWrite && s.status === 'subscribed' && removing !== s.id && (
                      <button type="button" className="btn btn-quiet ot-btn-tap" disabled={act.busy} onClick={() => setRemoving(s.id)}>Remove</button>
                    )}
                  </div>
                  {removing === s.id && (
                    <div className="ot-confirm" role="group" aria-label="Confirm unsubscribe">
                      <span>Unsubscribe? Only they can rejoin.</span>
                      <button type="button" className="btn btn-quiet ot-btn-tap" disabled={act.busy} onClick={() => remove(s)}>Yes</button>
                      <button type="button" className="btn btn-quiet ot-btn-tap" onClick={() => setRemoving(null)}>No</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {list.length > 50 && !showAll && (
            <button type="button" className="btn btn-quiet ot-btn-tap" onClick={() => setShowAll(true)}>Show all {list.length}</button>
          )}
          {canWrite && (
            <form className="ot-inline-add" onSubmit={add}>
              <div className="field">
                <label htmlFor="sub-email">Add — email</label>
                <input id="sub-email" className="input" type="email" required maxLength={320} autoCapitalize="none" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.org" />
              </div>
              <div className="field">
                <label htmlFor="sub-name">Name</label>
                <input id="sub-name" className="input" maxLength={300} value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" />
              </div>
              <button type="submit" className="btn ot-solid ot-btn-tap" disabled={act.busy || !email.trim()}>Add</button>
              {act.error && <span className="error">{act.error}</span>}
            </form>
          )}
        </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TEXTING — texts to a list, the replies, phone banks
// ─────────────────────────────────────────────────────────────────────────────
function TextingTab(props) {
  const unread = Number(useTextingStatus(props.me).data?.unread) || 0;
  return (
    <>
      {!props.creating && (
        <ul className="ot-list ot-texting-links">
          <li className="ot-item"><Link className="ot-row" to="/inbox"><span className="ot-row__main"><span className="ot-row__name">Inbox{unread > 0 && <> · <strong className="mono">{unread}</strong> new</>}</span><span className="ot-row__sub"><span>the replies, a conversation each</span></span></span></Link></li>
          <li className="ot-item"><Link className="ot-row" to="/banks"><span className="ot-row__main"><span className="ot-row__name">Phone banks</span><span className="ot-row__sub"><span>numbers handed to callers, with a script and call-backs</span></span></span></Link></li>
          <li className="ot-item"><Link className="ot-row" to="/calls?channel=text"><span className="ot-row__main"><span className="ot-row__name">Text one by one</span><span className="ot-row__sub"><span>Calls → Text: a person at a time, from your phone</span></span></span></Link></li>
          <li className="ot-item"><Link className="ot-row" to="/inbox/settings"><span className="ot-row__main"><span className="ot-row__name">Texting settings</span><span className="ot-row__sub"><span>the first text’s words, and the hours texts may go out</span></span></span></Link></li>
        </ul>
      )}
      <ListBlastTab kind="texts" {...props} />
    </>
  );
}

// Press releases sent before stay in the record (Email → past sends).
// eslint-disable-next-line no-unused-vars
function PressTab({ me, canWrite, creating, onClose }) {
  const blasts = useBlastList();
  const media = blasts.data?.mediaContacts ?? null;
  const emailConfigured = blasts.data?.emailConfigured;
  const [result, setResult] = useState(null);
  const composing = canWrite && creating;

  return (
    <>
      {composing && (
        <ComposeCard
          kind="press"
          slug={me.workspace.slug}
          audienceCount={media}
          audienceNoun={{ one: 'media contact', many: 'media contacts' }}
          emptyReason="Tag reporters “media” in People first."
          emailConfigured={emailConfigured}
          onCancel={onClose}
          onSent={(b) => { setResult(b); onClose(); }}
        />
      )}
      <BlastResult blast={result} emailConfigured={emailConfigured} canWrite={canWrite}
        onDismiss={() => setResult(null)} onRetried={setResult} />

      {!composing && (
        <>
          <Big n={media} one="media contact" many="media contacts" />
          <div className="ot-actions">
            <Link className="btn ot-btn-tap" to="/people?tag=media">Media list</Link>
          </div>
          <UnsentList blasts={blasts.data?.blasts} kind="press" emailConfigured={emailConfigured}
            canWrite={canWrite} onResent={setResult} />
          <TestingList blasts={blasts.data?.blasts} kind="press" skip={result?.id} />
          <LastSent blasts={blasts.data?.blasts} kind="press" skip={result?.id}
            emailConfigured={emailConfigured} canWrite={canWrite} />
        </>
      )}

      {!composing && <More>
        <EmailStatus configured={emailConfigured} />
        {canWrite && (
          <div className="ot-actions">
            <Link className="btn ot-btn-tap" to="/people?new=1">Add a contact</Link>
          </div>
        )}
        <section className="ot-sec" aria-label="Past press releases">
          <h2 className="ot-sec-h">Past sends</h2>
          {blasts.isError && <p className="error">{blasts.error.message}</p>}
          <PastList blasts={blasts.data?.blasts} loading={blasts.isPending} kindFilter="press"
            emailConfigured={emailConfigured} canWrite={canWrite} />
          <OpensNote />
        </section>
      </More>}
    </>
  );
}

// Email & texting: on or off, said once. They're switched on where Starbase
// is hosted, not here — so the line says who to ask.
function Connections({ focus, isManager }) {
  // A side read of Today's brief (its time isn't this screen's, KeptCopies.js).
  const brief = useQuery({ queryKey: ['brief'], queryFn: () => apiGet('/brief'), staleTime: Infinity, meta: { side: true } });
  const p = brief.data?.providers;
  const ref = useRef(null);
  // Arriving from a "Connect" link: bring this section into view.
  useEffect(() => {
    if (focus && p && ref.current?.scrollIntoView) ref.current.scrollIntoView({ block: 'center' });
  }, [focus, p]);
  if (!p) return null;
  return (
    <section ref={ref} className="ot-sec" aria-label="Email and texting" id="connect">
      <h2 className="ot-sec-h">Email &amp; texting</h2>
      <p className="ot-pay">
        <span className="ot-status-dot" data-status={p.email ? 'sent' : 'queued'} aria-hidden="true" />
        {p.email ? 'Email connected' : 'Email not connected'}
      </p>
      <p className="ot-pay">
        <span className="ot-status-dot" data-status={p.text ? 'sent' : 'queued'} aria-hidden="true" />
        {p.text ? 'Texting connected' : 'Texting not connected'}
      </p>
      {(!p.email || !p.text) && <p className="ot-note">{isManager ? <>Set them up under <Link to="/settings/services">Settings → Services</Link>.</> : 'Ask whoever set up Base to connect them.'}</p>}
    </section>
  );
}

// The campaign's own site: public pages link back to it. Managers set it.
function SiteSettings({ toast, current }) {
  const queryClient = useQueryClient();
  const [site, setSite] = useState(current);
  const act = useAction(() => queryClient.invalidateQueries({ queryKey: ['me'] }));
  useEffect(() => { setSite(current); }, [current]);
  // Accept a bare domain ("imaginesurrey.ca") and store a real link.
  const normalized = (() => {
    const v = site.trim();
    return v && !/^https?:\/\//i.test(v) ? `https://${v}` : v;
  })();
  const save = async (e) => {
    e.preventDefault();
    const v = normalized;
    const res = await act.run('workspace.update', { website: v });
    if (!res) return;
    setSite(v);
    toast(v ? 'Website saved' : 'Website cleared');
  };
  return (
    <form className="ot-inline-add ot-sec" onSubmit={save}>
      <div className="field">
        <label htmlFor="ws-site">Campaign website</label>
        <input id="ws-site" className="input mono" type="text" inputMode="url" autoComplete="url"
          autoCapitalize="none" spellCheck={false} value={site} maxLength={500}
          onChange={(e) => setSite(e.target.value)} placeholder={BRAND.sitePlaceholder} />
      </div>
      <button type="submit" className="btn ot-solid ot-btn-tap" disabled={act.busy || normalized === current}>
        {act.busy ? 'Saving…' : 'Save'}
      </button>
      {act.error && <span className="error">{act.error}</span>}
    </form>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CONNECTIONS — email & texting, and the campaign's website address
// ─────────────────────────────────────────────────────────────────────────────
function ConnectTab({ me, canWrite, toast }) {
  const isManager = me.role === 'manager';
  const [params] = useSearchParams();
  const connect = params.get('connect') === '1';
  const site = me.workspace.settings?.website || '';
  return (
    <>
      <Connections focus={connect} isManager={isManager} />
      {canWrite && isManager && <SiteSettings toast={toast} current={site} />}
      {canWrite && !isManager && !site && <p className="ot-note">No campaign website yet — a manager can add it.</p>}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The screen
// ─────────────────────────────────────────────────────────────────────────────
export default function Outreach() {
  const { me } = useOutletContext();
  const { tab } = useParams();
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const canWrite = DESK_ROLES.includes(me.role);
  const tabs = canWrite ? TABS : TABS.filter((t) => VOLUNTEER_TABS.has(t.key));
  const home = canWrite ? '/outreach/email' : '/outreach/connect';
  const creating = canWrite && params.get('new') === '1';
  const openNew = () => setParams({ new: '1' });
  const closeNew = () => setParams({}, { replace: true });

  if (!tab) return <Navigate to={home} replace />;
  if (MOVED[tab]) return <Navigate to={`/outreach/${MOVED[tab]}${params.toString() ? `?${params}` : ''}`} replace />;
  // Where email and texting stand (and the website address): not a tab,
  // but where "Connect" links land.
  if (tab === 'connect') {
    return (
      <div className="ot-page">
        <div className="ot-top"><h1>Email &amp; texting</h1></div>
        {canWrite && <p className="ot-note"><Link to="/outreach/email">← Outreach</Link></p>}
        <ConnectTab me={me} canWrite={canWrite} toast={toast.show} />
      </div>
    );
  }
  if (!tabs.some((t) => t.key === tab)) return <Navigate to={home} replace />;

  const primary = canWrite && !creating ? PRIMARY[tab] : null;
  const tabProps = { me, canWrite, creating, onClose: closeNew, toast: toast.show };

  return (
    <div className="ot-page">
      <div className="ot-top">
        <h1>Outreach</h1>
        {primary && (
          <button type="button" className="btn btn-primary ot-btn-tap" onClick={openNew}>{primary}</button>
        )}
      </div>

      <nav className="ot-tabs" aria-label="Outreach: email and texting" style={{ '--ot-tabs': tabs.length }}>
        {tabs.map((t) => (
          <Link key={t.key} to={`/outreach/${t.key}`} className={`ot-tab${tab === t.key ? ' active' : ''}`}
            aria-current={tab === t.key ? 'page' : undefined}>
            <span className="ot-tab-icon"><TabIcon name={t.key} /></span>
            <span className="ot-tab-label">{t.label}</span>
          </Link>
        ))}
      </nav>

      {tab === 'email' && <EmailTab {...tabProps} />}
      {tab === 'texting' && <TextingTab {...tabProps} />}
      {canWrite && !creating && tab === 'email' && <LaddersLink />}

      {toast.msg && (
        <div className="toast ot-toast" role="status">
          <span>{toast.msg}</span>
          <button type="button" className="btn ot-btn-tap" onClick={toast.clear}>OK</button>
        </div>
      )}
    </div>
  );
}
