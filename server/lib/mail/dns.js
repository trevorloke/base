// DMARC, looked up by base.win itself: no sender sets it up, and Gmail,
// Yahoo and Outlook all ask bulk senders for it. One TXT lookup at
// _dmarc.<the sender's domain>; for a sender on a subdomain
// (team@mail.example.org) the domain above it counts too, as it does for
// the mailbox providers. (Which domain is "the organization's" they decide
// from a list of public suffixes; here each domain above is simply asked.)
//
//   dmarcOf(domain) → { found: true, at, value }   the record, and where it is
//                   | { found: false }             no record
//                   | { found: null }              the lookup itself failed —
//                                                  unknown, never "not found"
// "No record" is only said when DNS answers for the domain at all: a server
// whose DNS is down or filtered hears "no such name" for everything.
import { resolveSoa, resolveTxt } from 'node:dns/promises';

const LOOKUP_MS = 5000;
const within = (p) => Promise.race([
  p,
  new Promise((_, reject) => { setTimeout(() => reject(Object.assign(new Error('no answer'), { code: 'ETIMEOUT' })), LOOKUP_MS).unref?.(); }),
]);
// Codes that mean "there is no such record", not "couldn't ask".
const NO_RECORD = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ENOENT']);

// Does DNS answer for this domain? (Its start-of-authority record; a name
// inside someone's zone has none of its own, and that is an answer too.)
const answers = async (domain) => {
  try { await within(resolveSoa(domain)); return true; } catch (e) { return e?.code === 'ENODATA'; }
};
// The lookups, swappable in tests (nothing here reaches real DNS there):
// txt(name) → the TXT records; reach(domain) → whether DNS answers for it.
let txt = resolveTxt;
let reach = answers;
export const _setResolverForTest = (fn, reachFn) => {
  txt = fn || resolveTxt;
  reach = reachFn || (fn ? async () => true : answers);
};

const lookup = async (name) => {
  const rows = await within(txt(name));
  // A long TXT record arrives in pieces: joined, they are the record.
  return (rows || []).map((parts) => (Array.isArray(parts) ? parts.join('') : String(parts)).trim()).find((t) => /^v=DMARC1\b/i.test(t)) || null;
};

export const dmarcOf = async (domain) => {
  const labels = String(domain || '').toLowerCase().split('.').filter(Boolean);
  if (labels.length < 2) return { found: false };
  // The sender's own domain, then each one above it (never a bare suffix).
  const tries = labels.slice(0, Math.min(labels.length - 1, 5)).map((_, i) => labels.slice(i).join('.'));
  for (const d of tries) {
    const at = `_dmarc.${d}`;
    try {
      const value = await lookup(at);
      if (value) return { found: true, at, value };
    } catch (e) {
      if (!NO_RECORD.has(e?.code)) return { found: null };
    }
  }
  return (await reach(tries.at(-1)).catch(() => false)) ? { found: false } : { found: null };
};

// The record to add when there is none: the least the mailbox providers ask
// for — a policy, set to "none" (watch, change nothing). The name is as a
// DNS host wants it, under the sender's domain.
export const DMARC_TO_ADD = { type: 'TXT', name: '_dmarc', value: 'v=DMARC1; p=none' };
