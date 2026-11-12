// Ladders — the words and small pieces every ladder screen shares: what a
// trigger, a goal and a step are called, where a person is on a ladder
// ("Waiting until Fri, Oct 24", "Waiting — email isn't connected", "Waiting
// for texting hours", "Reached the goal"), the trigger and goal pickers,
// the engagement chip, and the profile's Ladders section. Desk only: the
// server refuses volunteers every ladder read.
import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, action } from '../api.js';
import { HOOK_STEP, UNKNOWN_STEP, hookLogLine, hookRowNote } from './LaddersWords.js';
import '../pages/ladders.css';

// What starts a ladder, grouped as the picker shows them (server:
// ext/ladders/shape.js TRIGGERS). ref: what the second picker names — a tag
// (typed), what was done on the website (required), a survey (optional).
export const TRIGGERS = [
  { kind: 'web', label: 'Did something on the website', ref: 'web', group: 'On the website' },
  { kind: 'newsletter', label: 'Joined the newsletter', group: 'People' },
  { kind: 'tag', label: 'Got a tag', ref: 'tag', group: 'People' },
  { kind: 'rating', label: 'Rated 1 or 2', group: 'People' },
  { kind: 'survey', label: 'Answered a survey', ref: 'survey', group: 'People' },
  { kind: 'shift_booked', label: 'Booked a shift', group: 'Shifts' },
  { kind: 'shift_attended', label: 'Came to a shift', group: 'Shifts' },
  { kind: 'shift_no_show', label: 'Didn’t show up for a shift', group: 'Shifts' },
  { kind: 'donation', label: 'First donation', group: 'Money and members' },
  { kind: 'gift', label: 'Gave (any gift)', group: 'Money and members' },
  { kind: 'member', label: 'Became a member (or renewed)', group: 'Money and members' },
];
const TRIGGER_GROUPS = [...new Set(TRIGGERS.map((t) => t.group))];
export const triggerLabel = (kind) => TRIGGERS.find((t) => t.kind === kind)?.label || kind;
// "Got a tag · host", "Did something on the website · Signed: SkyTrain to Langley".
export const triggerLine = (t) => {
  if (!t) return '';
  const label = t.label || triggerLabel(t.kind);
  return t.what ? `${label} · ${t.what}` : label;
};

// A goal: they come off the ladder as soon as they do it (shape.js GOALS).
export const GOALS = [
  { kind: 'shift_attended', label: 'Came to a shift', until: 'Until they come to a shift' },
  { kind: 'gift', label: 'Gave', until: 'Until they give' },
  { kind: 'member', label: 'Became a member', until: 'Until they become a member' },
  { kind: 'voted', label: 'Voted', until: 'Until they vote' },
];
export const goalOf = (kind) => GOALS.find((g) => g.kind === kind) || null;
export const GOAL_HINT = 'They come off the ladder as soon as they do it, whatever step they’re on.';

export const STEP_KINDS = [
  { kind: 'wait', label: 'Wait' },
  { kind: 'email', label: 'Email' },
  { kind: 'text', label: 'Text' },
  { kind: 'tag', label: 'Tag' },
  { kind: 'followup', label: 'Follow-up' },
  { kind: 'webhook', label: HOOK_STEP, more: true },
  { kind: 'untag', label: 'Remove a tag', more: true },
  { kind: 'stop', label: 'Stop', more: true },
];
// The step button that shows the rest (not "More": the page has its own).
export const OTHER_STEPS = 'Other steps';
export const STEP_WORD = { wait: 'Wait', email: 'Email', text: 'Text', tag: 'Tag', untag: 'Remove tag', followup: 'Follow-up', stop: 'Stop', webhook: HOOK_STEP };

// One step as one line ("Email · Thanks, [first name]") and the rest of the
// words a step is shown in: LaddersWords.js (plain JS, tested on the server).
export { plural, stepLine } from './LaddersWords.js';

export const fmtWhen = (ts) => new Date(ts).toLocaleString('en-CA', {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

const REASON = {
  no_email: 'no email', unsubscribed: 'unsubscribed', do_not_contact: 'do not contact',
  do_not_email: 'do not email', no_consent: 'didn’t ask for email', suppressed: 'the address bounced or reported spam',
  // A text step's (ext/ladders engine textSkip).
  no_phone: 'no mobile number', bad_number: 'a number that can’t be texted', do_not_text: 'do not text',
  opted_out: 'replied STOP', asked_to_stop: 'asked to stop in a reply', no_text_consent: 'said no to texts',
  in_conversation: 'a teammate is texting them',
};
const END = { finished: 'Finished', stopped: 'Stopped', taken_off: 'Taken off', person_removed: 'Finished', goal: 'Reached the goal' };

// Where a person is on a ladder, in a few words. Literally what the server
// knows: a waiting email or text says whether it's connected right now.
// Over: how it ended (run.last — the server's word, even when an answer
// came in after), and what never reached them or another tool.
export const whereLine = (run, emailConfigured, textConfigured) => {
  if (!run) return '';
  if (run.status === 'done') {
    const end = END[run.last?.kind === 'end' ? run.last.result : 'finished'] || 'Finished';
    const skip = (run.skipped || []).find((s) => s.kind === 'email' || s.kind === 'text');
    if (skip) return `${end} · ${STEP_WORD[skip.kind].toLowerCase()} skipped (${REASON[skip.reason] || skip.reason})`;
    // A web address that never got them ("not sent to Zapier").
    const missed = hookRowNote(run.log);
    return missed ? `${end} · ${missed}` : end;
  }
  if (run.status === 'paused') return `Paused · step ${run.step + 1} of ${run.steps}`;
  if (run.wait === 'email') return emailConfigured ? 'Email connected — sends within the hour' : 'Waiting — email isn’t connected';
  if (run.wait === 'text') return textConfigured ? 'Texting connected — sends within the hour' : 'Waiting — texting isn’t connected';
  // Held until it may go: a web address that has stopped answering, or a text outside texting hours.
  if (run.wait === 'quiet' && run.stepKind === 'webhook') return 'Waiting — the web address isn’t answering';
  if (run.wait === 'quiet') return run.next_at ? `Waiting for texting hours · ${fmtWhen(run.next_at)}` : 'Waiting for texting hours';
  if (run.wait === 'retry') return run.stepKind === 'webhook' ? 'The web address didn’t take it — trying again' : 'Email didn’t go — trying again';
  if (run.wait === 'sending') return run.stepKind === 'text' ? 'Sending text' : run.stepKind === 'webhook' ? 'Sending to the web address' : 'Sending email';
  if (run.wait === 'time' && run.next_at) return `Waiting until ${fmtWhen(run.next_at)}`;
  return `Step ${Math.min(run.step + 1, run.steps)} of ${run.steps}${STEP_WORD[run.stepKind] ? ` · ${STEP_WORD[run.stepKind]}` : ''}`;
};

// "3 in progress · 12 finished (5 reached the goal)" — while a ladder is
// off its people are paused.
export const countsLine = (l) => `${l.inProgress} ${l.active ? 'in progress' : 'paused'} · ${l.finished} finished${
  l.reached ? ` (${l.reached} reached the goal)` : ''}`;

// What one log entry says ("Email sent", "Text skipped — replied STOP",
// "Zapier: Sent · 200").
export const logLine = (e) => {
  const what = STEP_WORD[e.kind] || '';
  if (e.kind === 'end') return END[e.result] || 'Finished';
  if (!what) return UNKNOWN_STEP;
  if (e.kind === 'wait') return e.until ? `Waited until ${fmtWhen(e.until)}` : 'Wait';
  if (e.kind === 'webhook') return hookLogLine(e);
  if (e.result === 'skipped') return `${what} skipped — ${REASON[e.reason] || e.reason}`;
  if (e.kind === 'email') {
    if (e.result === 'sent') return 'Email sent';
    if (e.result === 'sending') return 'Sending email';
    if (e.result === 'unsure') return 'Email — not sure it went';
    if (e.result === 'waiting') return 'Email waiting — not connected';
    if (e.result === 'failed') return e.reason === 'gave_up' ? 'Email failed' : 'Email didn’t go — trying again';
  }
  if (e.kind === 'text') {
    if (e.result === 'sent') return 'Text sent';
    if (e.result === 'sending') return 'Sending text';
    if (e.result === 'unsure') return 'Text — not sure it went';
    if (e.result === 'waiting') return e.reason === 'quiet_hours' ? 'Text waiting for texting hours' : 'Text waiting — not connected';
    if (e.result === 'failed') return 'Text didn’t go';
  }
  if (e.kind === 'tag' || e.kind === 'untag') return `${what} · ${e.tag}`;
  if (e.kind === 'followup') return 'Follow-up added';
  return what;
};

// Where the screens send "Connect" (Outreach's Connections tab, Email & texting open).
export const CONNECT_TO = '/outreach/connect?connect=1';

// "← Ladders", or back to the screen that opened this one when it said who
// it is (router state, as Results does): Today's "2 follow-ups" → "← Today".
export function LadBack() {
  const from = useLocation().state?.from;
  return from?.to
    ? <Link className="ops-back" to={from.to}>← {from.label || 'Back'}</Link>
    : <Link className="ops-back" to="/ladders">← Ladders</Link>;
}

// ── Starts when: the trigger, and which tag / what on the website / survey ──
// The website's choices: what kind of thing, then each petition or pledge
// ("Signed: SkyTrain to Langley").
export function TriggerPicker({ value, onChange, options, idp, disabled }) {
  const t = TRIGGERS.find((x) => x.kind === value.kind) || TRIGGERS[0];
  const tags = options?.tags ?? [];
  const web = options?.web ?? [];
  const surveys = options?.surveys ?? [];
  const kinds = web.filter((o) => !o.value.startsWith('campaign:'));
  const campaigns = web.filter((o) => o.value.startsWith('campaign:'));
  return (
    <>
      <div className="field">
        <label htmlFor={`${idp}-kind`}>Starts when</label>
        <select id={`${idp}-kind`} className="input lad-select" value={t.kind} disabled={disabled}
          onChange={(e) => onChange({ kind: e.target.value, ref: '' })}>
          {TRIGGER_GROUPS.map((g) => (
            <optgroup key={g} label={g}>
              {TRIGGERS.filter((x) => x.group === g).map((x) => <option key={x.kind} value={x.kind}>{x.label}</option>)}
            </optgroup>
          ))}
        </select>
      </div>
      {t.ref === 'tag' && (
        <div className="field">
          <label htmlFor={`${idp}-ref`}>Which tag</label>
          <input id={`${idp}-ref`} className="input lad-input" list={`${idp}-tags`} required maxLength={40}
            autoComplete="off" placeholder="host" value={value.ref || ''} disabled={disabled}
            onChange={(e) => onChange({ ...value, ref: e.target.value })} />
          <datalist id={`${idp}-tags`}>{tags.map((x) => <option key={x} value={x} />)}</datalist>
        </div>
      )}
      {t.ref === 'web' && (
        <div className="field">
          <label htmlFor={`${idp}-ref`}>What they did</label>
          <select id={`${idp}-ref`} className="input lad-select" value={value.ref || ''} disabled={disabled}
            onChange={(e) => onChange({ ...value, ref: e.target.value })}>
            <option value="" disabled>Pick one</option>
            {kinds.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            {campaigns.length > 0 && (
              <optgroup label="One petition or pledge">
                {campaigns.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </optgroup>
            )}
          </select>
        </div>
      )}
      {t.ref === 'survey' && (
        <div className="field">
          <label htmlFor={`${idp}-ref`}>Which survey</label>
          <select id={`${idp}-ref`} className="input lad-select" value={value.ref || ''} disabled={disabled}
            onChange={(e) => onChange({ ...value, ref: e.target.value })}>
            <option value="">Any survey</option>
            {surveys.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      )}
    </>
  );
}

// What a trigger still needs before it can be saved, or null.
export const triggerMissing = (t) => {
  if (t.kind === 'tag' && !String(t.ref || '').trim()) return 'Pick a tag';
  if (t.kind === 'web' && !t.ref) return 'Pick what they did on the website';
  return null;
};

// ── The goal: none, or what takes them off ──
export function GoalPicker({ value, onChange, idp, disabled }) {
  return (
    <div className="field">
      <label htmlFor={`${idp}-goal`}>Goal</label>
      <select id={`${idp}-goal`} className="input lad-select" value={value || ''} disabled={disabled}
        aria-describedby={`${idp}-goal-hint`} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">No goal — they go through every step</option>
        {GOALS.map((g) => <option key={g.kind} value={g.kind}>{g.label}</option>)}
      </select>
      <p className="lad-hint" id={`${idp}-goal-hint`}>{GOAL_HINT}</p>
    </div>
  );
}

// ── Engagement ──
export const LEVEL_HINT = 'Contact → Supporter → Signer → Donor or volunteer → Leader';
export function EngagementChip({ level }) {
  if (!level) return null;
  return (
    <span className="chip lad-level" data-level={level.code} title={`Level ${level.step} of ${level.of}: ${LEVEL_HINT}`}>
      {level.label}
    </span>
  );
}

// ── The person profile (desk) ──
export const usePersonLadders = (id, desk) => useQuery({
  queryKey: ['person', id, 'ladders'],
  queryFn: () => apiGet(`/persons/${id}/ladders`),
  enabled: Boolean(desk && id),
});

export function PersonLadders({ data, name }) {
  const location = useLocation();
  // A ladder opened from here comes back here ("← Ana Souza").
  const from = { to: `${location.pathname}${location.search}`, label: name || 'Back' };
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const runs = data?.runs ?? [];
  const followups = data?.followups ?? [];
  const done = async (f) => {
    setBusy(true);
    setError(null);
    try {
      await action('ladder.followupDone', { id: f.id });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['person'] }),
        queryClient.invalidateQueries({ queryKey: ['ladders'] }),
      ]);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {followups.length > 0 && (
        <ul className="list-plain lad-pf-fu">
          {followups.map((f) => (
            <li key={f.id}>
              <span>{f.text}{f.assigned_name && <span className="lad-where"> · {f.assigned_name} has it</span>}</span>
              <button type="button" className="btn ops-tap lad-done-btn" disabled={busy} onClick={() => done(f)}>Done</button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {runs.length === 0 ? <p className="pf-empty">On no ladders.</p> : (
        <ul className="list-plain lad-pf-runs">
          {runs.map((r) => (
            <li key={r.id}>
              <Link to={`/ladders/${r.ladder.id}`} state={{ from }}>{r.ladder.name}</Link>
              <span className="lad-where">{r.ladder.active || r.status === 'done' ? whereLine(r, data.emailConfigured, data.textConfigured) : 'Ladder is off'}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
