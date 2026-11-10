// "Send to a web address" — the leaf pieces of that ladder step: which
// addresses it may be pointed at, the campaign's signing secret, what is
// sent, and the one call that sends it. engine.js runs the step.
//
// The address is typed by the desk, so it is treated as hostile to the
// server's own network: https only, no name and password in it, never an
// address inside a private network — checked on the words when the step is
// saved, and again each time it sends, after the name is looked up: the call
// then goes to the very address that was checked (a name can't answer
// "public" to the check and "inside" to the call), a redirect is never
// followed, and only the answer's number is read, never its words.
//
// node:http(s), not fetch: fetch can't be told which address to connect to.
//
//   LADDER_WEBHOOK_API_BASE   tests only: a stand-in that receives every
//                             step's message instead (server/test/fake-receiver.js);
//                             no name is looked up while it is set
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { hkdfSync } from 'node:crypto';
import { signPayload } from '../../lib/signature.js';
import { isMoneyTag } from '../../lib/viewer.js';
import { e164 } from '../texting/rules.js';
import { siteSecret } from '../site/tokens.js';
import { TRIGGERS, tagsOf } from './shape.js';

export const HOOK_TIMEOUT_MS = 5000;
// Tests wait out an address that never answers in a fraction of that.
let hookTimeoutMs = HOOK_TIMEOUT_MS;
export const _setTimeoutForTest = (ms) => { hookTimeoutMs = ms || HOOK_TIMEOUT_MS; };
const LOOKUP_MS = 3000;
const standIn = () => String(process.env.LADDER_WEBHOOK_API_BASE || '').trim().replace(/\/+$/, '');

// ── Which addresses ──

// Not public: this network, private ranges, carrier NAT, loopback,
// link-local (where a cloud keeps its metadata), documentation and test
// ranges, multicast, reserved.
const inside4 = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) inside4.addSubnet(net, bits, 'ipv4');
// IPv6: only the global range (2000::/3) is public — so not loopback,
// link-local, unique-local, multicast, or an IPv4 address written as IPv6 —
// less the parts of it that tunnel or document.
const global6 = new BlockList();
global6.addSubnet('2000::', 3, 'ipv6');
const inside6 = new BlockList();
for (const [net, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) inside6.addSubnet(net, bits, 'ipv6');

export const isPublicAddress = (address) => {
  const a = String(address || '');
  const family = isIP(a);
  if (family === 4) return !inside4.check(a, 'ipv4');
  if (family === 6) return global6.check(a, 'ipv6') && !inside6.check(a, 'ipv6');
  return false;
};

const PRIVATE = 'That address points inside a private network — it can’t be used';
const parse = (typed) => {
  const s = String(typed || '').trim();
  if (!/^https:\/\//i.test(s)) return { why: 'The address must start with https://' };
  let url;
  try { url = new URL(s); } catch { return { why: 'That isn’t a web address' }; }
  if (url.username || url.password) return { why: 'Leave the name and password out of the address' };
  // A written-out address ("https://10.0.0.5/…", in any spelling: the parser
  // reads 0x7f.1 as 127.0.0.1) is checked as it stands.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return isPublicAddress(host) ? { url, host } : { why: PRIVATE };
  if (host === 'localhost' || host.endsWith('.localhost')) return { why: PRIVATE };
  if (!host.replace(/\.$/, '').includes('.')) return { why: 'That isn’t a web address' };
  return { url, host };
};

// Why this address can't be used, from its words alone — or null.
export const addressProblem = (typed) => parse(typed).why || null;

// The address as it is kept: lower-case host, no default port, no #part.
export const cleanAddress = (typed) => {
  const url = new URL(String(typed).trim());
  url.hash = '';
  return url.href;
};

// Every address a name answers with: [{ address, family }].
let resolver = (host) => dns.promises.lookup(host, { all: true });
export const _setResolverForTest = (fn) => { resolver = fn || ((host) => dns.promises.lookup(host, { all: true })); };

class Inside extends Error {}
// A name's addresses, if every one of them is public (one inside answer
// among public ones is still a way in); a written-out address is itself.
const publicAddresses = async (host) => {
  const family = isIP(host);
  const found = family ? [{ address: host, family }] : await resolver(host);
  if (!found?.length) throw Object.assign(new Error(`no address for ${host}`), { code: 'ENOTFOUND' });
  if (!found.every((a) => isPublicAddress(a.address))) throw new Inside(host);
  return found;
};

const within = (ms, promise) => {
  let timer;
  const late = new Promise((_, no) => { timer = setTimeout(() => no(Object.assign(new Error('no answer'), { code: 'ETIMEDOUT' })), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};

// When a step is saved: why the name behind this address can't be used — it
// points inside a private network, or there is no such name — or null. A
// lookup that can't be made just now is not a no: each send looks again.
export const lookupProblem = async (typed) => {
  const { host, why } = parse(typed);
  if (why) return why;
  if (standIn()) return null;
  try {
    await within(LOOKUP_MS, publicAddresses(host));
    return null;
  } catch (e) {
    if (e instanceof Inside) return PRIVATE;
    return e?.code === 'ENOTFOUND' ? `We couldn’t find ${host} — check the address` : null;
  }
};

// ── The campaign's signing secret ──
// Made from the server's own secret (the website's: SITE_SECRET, or the one
// base.win keeps) and the campaign, so it is never stored and is the same
// every time it is asked for. Through HKDF: showing it to the desk says
// nothing about the server's secret or another campaign's.
export const signingSecret = async (workspaceId) => `sbw_${Buffer.from(
  hkdfSync('sha256', await siteSecret(), String(workspaceId), 'base.win/ladder-webhook/v1', 32),
).toString('hex')}`;

// ── What is sent ──
// Who they are and what started the ladder. An email or a mobile only when
// a ladder email or text could go to it (emailOk, textOk: engine.js); never
// a tag that gives money away, a rating, a note or an address. `text` says
// it in one line (what a chat tool shows); `id` is the same on every try.
// The tag that started the ladder is named there — unless it gives money
// away: then the line says only "Got a tag".
const eventWords = (event, ref) => `${TRIGGERS[event]?.label || event}${event === 'tag' && ref && !isMoneyTag(ref) ? ` · ${ref}` : ''}`;
// In that one line a name is only ever a name: it can come from a website
// form, and a chat tool reads <…> as its own marks (Slack: a link, @channel).
const plain = (name) => String(name || '').replace(/[<>]/g, '');
export const hookBody = ({ id, event, ref = null, ladder, step, at, campaign, person, emailOk, textOk }) => JSON.stringify({
  id,
  event,
  ladder,
  step,
  at,
  campaign,
  text: `${ladder}: ${plain(person.name)} — ${eventWords(event, ref)}`,
  person: {
    id: person.id,
    first_name: person.first_name || null,
    last_name: person.last_name || null,
    email: emailOk ? person.email || null : null,
    phone: textOk ? e164(person.phone) : null,
    postal: person.postal || null,
    tags: tagsOf(person).filter((t) => !isMoneyTag(t)),
  },
});

// ── Sending ──
const pinned = (found) => (hostname, options, cb) => (options?.all ? cb(null, found) : cb(null, found[0].address, found[0].family));

// One POST; the answer's status, nothing more. agent: false — its own
// connection, closed as soon as the status is in (an endless answer holds
// nothing open).
const post = (to, { body, headers, lookup, signal }) => new Promise((resolve, reject) => {
  const req = (to.protocol === 'https:' ? https : http).request(to, {
    method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }, lookup, signal, agent: false,
  }, (res) => {
    res.on('error', () => {});
    res.destroy();
    resolve(res.statusCode);
  });
  req.on('error', reject);
  req.end(body);
});

// Send `body` to `url`, signed, once. → { ok: true, status } when the
// address answered 2xx; { ok: false, status } for any other answer;
// { ok: false, why } when it never answered ('timeout'), has no such name
// ('not_found') or couldn't be reached ('unreachable'); and { ok: false,
// final: true, … } when trying again would meet the same wall — it answered
// with a redirect (status: never followed, and the same one would come
// back), it is not an address the step may have (why: 'bad_address'), or
// its name now points inside a private network (why: 'private').
const sendOnce = async ({ url, body, secret, key, timeoutMs = hookTimeoutMs }) => {
  const { url: target, host, why } = parse(url);
  if (why) return { ok: false, final: true, why: 'bad_address' };
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const base = standIn();
    const to = base ? Object.assign(new URL(base), { pathname: target.pathname, search: target.search }) : target;
    const lookup = base ? undefined : pinned(await within(timeoutMs, publicAddresses(host)));
    const status = await post(to, {
      body,
      lookup,
      signal,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'base.win',
        'Base-Signature': signPayload(body, secret),
        'Idempotency-Key': key,
      },
    });
    if (status >= 300 && status < 400) return { ok: false, final: true, status };
    return { ok: status >= 200 && status < 300, status };
  } catch (e) {
    if (e instanceof Inside) return { ok: false, final: true, why: 'private' };
    if (signal.aborted || e?.code === 'ETIMEDOUT') return { ok: false, why: 'timeout' };
    return { ok: false, why: e?.code === 'ENOTFOUND' ? 'not_found' : 'unreachable' };
  }
};

// ── An address that has stopped answering ──
// Jobs run one at a time (lib/jobs.js), so every call that waits out its
// five seconds holds whatever is queued behind it: other ladders, receipts,
// thank-you emails. After three calls in a row with no answer the address
// is left alone for five minutes: the engine tells whoever reaches the step
// meanwhile at once ("the address isn't answering") and tries them again on
// the usual clock — by then it may be back. Any answer at all, a 500 too,
// clears it. Kept in this server's memory: a restart starts the count again.
const SILENT_AFTER = 3;
const SILENT_MS = 5 * 60_000;
const SILENT_KEEP = 500;
const silent = new Map(); // address → { misses, until }
export const _silentForTest = silent;
export const notAnswering = (url) => (silent.get(url)?.until || 0) > Date.now();
const heard = (url, res) => {
  const misses = res.why === 'timeout' ? (silent.get(url)?.misses || 0) + 1 : 0;
  silent.delete(url);
  if (!misses) return res;
  silent.set(url, { misses, until: misses >= SILENT_AFTER ? Date.now() + SILENT_MS : 0 });
  if (silent.size > SILENT_KEEP) silent.delete(silent.keys().next().value);
  return res;
};

// The call itself, and what it says about whether the address answers.
export const postHook = async (args) => heard(args.url, await sendOnce(args));
