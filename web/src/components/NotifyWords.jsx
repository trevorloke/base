// How a notice went, in words — shared by a shift's page (pages/Shifts.jsx),
// the week's "Tell them" and "Tell everyone on this week's shifts"
// (pages/ScheduleShift.jsx, ScheduleWeek.jsx). The statuses are the
// server's (lib/notify.js, ext/texting, ext/schedule):
//   sent · queued (that channel isn't connected: nothing was sent and
//   nothing sends later) · failed · skipped (nothing on file) · opted_out ·
//   quiet (a text held back by the campaign's hours) · suppressed (an email
//   left off: the address bounced for good or reported spam)
//
//   outcomeOf(email, text)   one person across both channels
//   notifySummary(results)   one line for a whole notice: { text, ok }
//   <NotifyChip channel status />
//   NOTIFIED_WORD            "Notified" · "Tried" · "Saved" beside a time
//   people(n)                "1 person" · "3 people"
const NOTIFY_CHIP = { sent: 'chip-ok', queued: 'chip-warn', failed: 'chip-danger', skipped: '', opted_out: '', quiet: 'chip-warn', suppressed: 'chip-warn' };
// What happened to one message, in plain words ("Email not sent"). 'queued'
// means the server sent nothing because that channel isn't connected, and
// nothing sends it later: connect it, then Notify again.
const NOTIFY_WORDS = {
  email: {
    sent: 'Email sent', queued: 'Email not sent', failed: 'Email didn’t send', skipped: 'No email on file',
    // A week's notice and the evening reminders leave out do-not-email (ext/schedule).
    opted_out: 'Opted out of email',
    // …and an address on the email service's suppression list (ext/mail).
    suppressed: 'Email left off — the address bounced',
  },
  text: {
    sent: 'Text sent', queued: 'Text not sent', failed: 'Text didn’t send', skipped: 'No phone on file',
    // The texting rules hold a notice back too (server/ext/texting).
    opted_out: 'Opted out of texts', quiet: 'Text not sent — quiet hours',
  },
};
const NOTIFY_TITLE = {
  email: {
    queued: 'Not sent — email isn’t connected', failed: 'Try again, or reach them another way',
    opted_out: 'They are marked do not email or do not contact',
    suppressed: 'An earlier email to this address bounced for good or was reported as spam',
  },
  text: {
    queued: 'Not sent — texting isn’t connected', failed: 'Try again, or reach them another way',
    opted_out: 'They replied STOP or are marked do not text', quiet: 'Texts go out only in the campaign’s hours',
  },
};

// One person's outcome across both channels:
//   reached — at least one message went out
//   failed  — nothing went out, and a provider turned one down
//   offline — nothing went out: that channel isn't connected
//   quiet   — nothing went out: the text waits for the campaign's hours
//   optedout — nothing went out: no email, and they opted out of texts
//   skipped — no email or phone on file
export const outcomeOf = (email, text) => {
  if (email === 'sent' || text === 'sent') return 'reached';
  if (email === 'failed' || text === 'failed') return 'failed';
  if (email === 'queued' || text === 'queued') return 'offline';
  if (text === 'quiet') return 'quiet';
  if (text === 'opted_out') return 'optedout';
  return 'skipped';
};
export const people = (n) => `${n} ${n === 1 ? 'person' : 'people'}`;

// The result of one Notify, counted per person, in one line:
//   "✓ Sent to 2 people"
//   "✓ Sent to 1 of 2 · 1 not reached — see Details"
//   "Not sent · 2 people — connect email and text, then Notify again"
// Green only when everyone was reached.
export function notifySummary(results) {
  const total = results.length;
  const n = { reached: 0, failed: 0, offline: 0, quiet: 0, optedout: 0, skipped: 0 };
  // Texts held back for quiet hours, whoever else reached them by email.
  const quietTexts = results.filter((r) => r.text === 'quiet');
  let offEmail = false;
  let offText = false;
  for (const r of results) {
    const o = outcomeOf(r.email, r.text);
    n[o] += 1;
    if (o === 'offline') {
      if (r.email === 'queued') offEmail = true;
      if (r.text === 'queued') offText = true;
    }
  }
  const connect = offEmail && offText ? 'email and text' : offEmail ? 'email' : 'text';
  const parts = [];
  if (n.reached) parts.push(n.reached === total ? `✓ Sent to ${people(total)}` : `✓ Sent to ${n.reached} of ${total}`);
  // The first part leads ("Not sent · 2 people …"); later ones are counts.
  const say = (lead, count) => parts.push(parts.length === 0 ? lead : count);
  if (n.failed) say(`Not reached · ${people(n.failed)} — see Details`, `${n.failed} not reached — see Details`);
  if (n.offline) {
    const next = `connect ${connect}, then Notify again`;
    say(`Not sent · ${people(n.offline)} — ${next}`, `${n.offline} not sent — ${next}`);
  }
  if (quietTexts.length) {
    // "Quiet hours — sending opens at 9 am" (the server's words).
    const note = quietTexts.find((r) => r.text_note)?.text_note || 'Quiet hours';
    const k = quietTexts.length;
    say(`${note} · ${k} ${k === 1 ? 'text' : 'texts'} not sent`, `${k} ${k === 1 ? 'text' : 'texts'} not sent — ${note.toLowerCase()}`);
  }
  if (n.optedout) say(`Opted out of texts · ${people(n.optedout)}`, `${n.optedout} opted out of texts`);
  if (n.skipped) say(`No email or phone on file · ${people(n.skipped)}`, `${n.skipped} with no email or phone`);
  return { text: parts.join(' · '), ok: total > 0 && n.reached === total && quietTexts.length === 0 };
}

export function NotifyChip({ channel, status }) {
  if (!status) return null;
  return (
    <span className={`chip ${NOTIFY_CHIP[status] ?? ''}`.trim()} title={NOTIFY_TITLE[channel]?.[status]}>
      {NOTIFY_WORDS[channel]?.[status] ?? `${channel} ${status}`}
    </span>
  );
}

export const NOTIFIED_WORD = { reached: 'Notified', failed: 'Tried', offline: 'Saved', quiet: 'Saved', optedout: 'Saved', skipped: 'Saved' };
