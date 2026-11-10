// DMARC, looked up by base.win itself: no sender sets it up, and Gmail,
// Yahoo and Outlook all ask bulk senders for it. One TXT lookup at
// _dmarc.<the sender's domain>; for a sender on a subdomain
// (team@mail.example.org) the domain above it counts too, as it does for
// the mailbox providers.
//
//   dmarcOf(domain) → { found: true, at, value }   the record, and where it is
//                   | { found: false }             no record
//                   | { found: null }              the lookup itself failed —
//                                                  unknown, never "not found"
import { resolveTxt } from 'node:dns/promises';

const LOOKUP_MS = 5000;
// The lookup, swappable in tests (nothing here reaches real DNS there).
let resolver = resolveTxt;
export const _setResolverForTest = (fn) => { resolver = fn || resolveTxt; };

// Codes that mean "there is no such record", not "couldn't ask".
const NO_RECORD = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ENOENT']);

const lookup = async (name) => {
  const rows = await Promise.race([
    resolver(name),
    new Promise((_, reject) => { setTimeout(() => reject(Object.assign(new Error('no answer'), { code: 'ETIMEOUT' })), LOOKUP_MS).unref?.(); }),
  ]);
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
  return { found: false };
};

// The record to add when there is none: the least the mailbox providers ask
// for — a policy, set to "none" (watch, change nothing). The name is as a
// DNS host wants it, under the sender's domain.
export const DMARC_TO_ADD = { type: 'TXT', name: '_dmarc', value: 'v=DMARC1; p=none' };
