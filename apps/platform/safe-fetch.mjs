// The one kind of request the control centre makes: an unauthenticated GET
// of a public health check. It goes only to https, and only to a public
// address: the address a name resolves to is checked when the connection
// is made (so a name that points at the platform's own network, or at a
// cloud's metadata address, is refused even if it changed since it was
// typed). No redirects followed, no cookies, 10 seconds, 16 KB read.
// OPS_ALLOW_LOCAL=1 (tests only) also allows http://127.0.0.1.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { cfg } from './config.mjs';

const BLOCKED = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) BLOCKED.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32]]) BLOCKED.addSubnet(a, p, 'ipv6');

class Refused extends Error { constructor(name) { super(name); this.name = name; } }

// May this address be reached? (127.0.0.1 only when local is allowed.)
export const addressAllowed = (ip, { allowLocal = cfg().allowLocal } = {}) => {
  const family = net.isIP(ip);
  if (!family) return false;
  if (allowLocal && ip === '127.0.0.1') return true;
  if (family === 6 && /^::ffff:/i.test(ip)) return addressAllowed(ip.replace(/^::ffff:/i, ''), { allowLocal: false });
  return !BLOCKED.check(ip, family === 4 ? 'ipv4' : 'ipv6');
};

// The lookup the connection uses: the real one, then every answer checked.
const guardedLookup = (lookup, allowLocal) => (hostname, options, callback) => {
  lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    const list = Array.isArray(address) ? address : [{ address, family }];
    if (!list.length || list.some((a) => !addressAllowed(a.address, { allowLocal }))) return callback(new Refused('blocked-address'));
    return callback(null, address, family);
  });
};

export const USER_AGENT = 'base.win-control-centre';
export const MAX_BYTES = 16 * 1024;

// → { status, body (string, at most 16 KB), ms }; throws an Error whose name says why.
export const safeGet = (url, { allowLocal = cfg().allowLocal, lookup = dns.lookup, timeoutMs = 10_000 } = {}) => new Promise((resolve, reject) => {
  let u;
  try { u = new URL(url); } catch { return reject(new Refused('bad-url')); }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const local = allowLocal && host === '127.0.0.1';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return reject(new Refused('not-https'));
  if (u.username || u.password) return reject(new Refused('bad-url'));
  if (net.isIP(host) && !addressAllowed(host, { allowLocal })) return reject(new Refused('blocked-address'));
  const started = Date.now();
  const mod = u.protocol === 'https:' ? https : http;
  const req = mod.request(u, {
    method: 'GET',
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    lookup: guardedLookup(lookup, allowLocal),
    agent: false,
    timeout: timeoutMs,
  }, (res) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve({ status: res.statusCode, body: Buffer.concat(chunks).subarray(0, MAX_BYTES).toString('utf8'), ms: Date.now() - started });
    };
    res.on('data', (d) => {
      chunks.push(d);
      size += d.length;
      if (size >= MAX_BYTES) { finish(); res.destroy(); }
    });
    res.on('end', finish);
    res.on('error', (e) => (done ? null : reject(new Refused(e.code || 'read-error'))));
  });
  // The whole answer within the time, not only each pause in it.
  const timer = setTimeout(() => req.destroy(new Refused('timeout')), timeoutMs);
  timer.unref?.();
  req.on('close', () => clearTimeout(timer));
  req.on('timeout', () => req.destroy(new Refused('timeout')));
  req.on('error', (e) => reject(e instanceof Refused ? e : new Refused(e.code || e.name || 'error')));
  req.end();
});
