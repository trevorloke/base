// "Add to calendar" → "Apple & others": the file is made when the button
// asks for it and kept here under a short-lived ticket, so the link that
// opens it needs no cookie (a home-screen app on an iPhone may hand the
// link to Safari, whose cookies are its own). A ticket is good for 10
// minutes and 3 reads (iOS can fetch twice as it opens the Add sheet). In
// the process only (one server per campaign): a restart forgets them, and
// the button simply fetches a new one.
import { randomBytes } from 'node:crypto';

const TTL_MS = 10 * 60_000;
const READS = 3;
const MAX = 2000;
const kept = new Map(); // ticket → { body, filename, until, reads }
let clock = () => Date.now();
export const _setTicketClockForTest = (fn) => { clock = fn || (() => Date.now()); };

export const keepFile = (body, filename) => {
  const ticket = randomBytes(16).toString('base64url'); // 22 characters
  while (kept.size >= MAX) kept.delete(kept.keys().next().value); // the oldest first
  kept.set(ticket, { body, filename, until: clock() + TTL_MS, reads: 0 });
  return ticket;
};

// The file, or null when unknown, used up or expired.
export const readFile = (ticket) => {
  const t = kept.get(ticket);
  if (!t) return null;
  if (clock() > t.until) { kept.delete(ticket); return null; }
  t.reads += 1;
  if (t.reads >= READS) kept.delete(ticket);
  return t;
};
