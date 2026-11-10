// CallHub on Settings → Services (ext/connections lists it): set up or not;
// Check — the key works, and CallHub sends each call's result to this
// base.win — reads only; Connect (callhub.connect, managers) is the one
// write: it gives CallHub the address results come back to.
//
// That address ends in a key made from the API key (callhub.js): it is
// given to CallHub and never shown, logged or put in an answer.
import { callhub, callhubOn, CallHubError, hookUrl, HOOK_PREFIX, idOf, listAll } from './callhub.js';

const NEEDS = ['CALLHUB_API_KEY'];
const EVENT = 'cc.notes'; // CallHub's webhook for a call-center agent saving a call's result
// What could not be confirmed is said where the manager sets it up.
export const UNCONFIRMED = 'Built from CallHub’s published documentation. Before your first calling night: press Check, then make one test call and see its result arrive on the person.';

export const callhubService = () => ({
  key: 'callhub',
  name: 'Phone dialer (CallHub)',
  for: 'Send a call list to CallHub’s dialer; each call’s result comes back onto the person',
  launch: false,
  missing: callhubOn() ? [] : NEEDS,
  set: callhubOn() ? NEEDS : [],
  state: callhubOn() ? 'ready' : 'missing',
  detail: UNCONFIRMED,
  checkable: true,
  ...(callhubOn() ? { connect: { action: 'callhub.connect', label: 'Connect' } } : {}),
});
// Under "Coming in": the address, without its last part.
export const callhubInbound = (base) => ({
  name: 'CallHub — each call’s result',
  url: `${String(base || '').replace(/\/+$/, '')}${HOOK_PREFIX}…`,
  how: 'Given to CallHub by Connect (Phone dialer, above). Its last part is made from the key and never shown',
});

const REFUSED = 'CallHub refused the key — is the address right? Some accounts use api-na1.callhub.io (CALLHUB_API_BASE)';
const refused = (e) => e instanceof CallHubError && (e.httpStatus === 401 || e.httpStatus === 403);
const words = (e) => String(e?.message || e).slice(0, 160);
const same = (a, b) => String(a || '').replace(/\/+$/, '') === String(b || '').replace(/\/+$/, '');
const plural = (n, one) => `${n.toLocaleString('en-CA')} ${n === 1 ? one : `${one}s`}`;

export const checkCallHub = async (db, ws, base) => {
  if (!callhubOn()) return { ok: false, said: 'CALLHUB_API_KEY isn’t set' };
  try {
    await callhub('GET', '/agents/', { timeoutMs: 8000 });
  } catch (e) {
    return { ok: false, said: refused(e) ? REFUSED : `CallHub didn’t answer: ${words(e)}` };
  }
  let hooks;
  try {
    hooks = await listAll('/webhooks/');
  } catch (e) {
    return { ok: false, said: `The key works, but CallHub wouldn’t list where it sends results: ${words(e)}` };
  }
  if (!hooks.some((h) => h?.event === EVENT && same(h.target, hookUrl(base)))) {
    return { ok: false, said: 'The key works, but CallHub isn’t sending results here yet — tap Connect' };
  }
  const n = (await db.query(
    'select count(*)::int as total, (count(*) filter (where contact_id is null))::int as unfiled from callhub_results where workspace_id = $1', [ws],
  )).rows[0];
  return {
    ok: true,
    said: `The key works · results come back here${n.total ? ` · ${plural(n.total, 'result')} so far` : ''}${n.unfiled ? ` · ${n.unfiled.toLocaleString('en-CA')} for numbers base.win never sent` : ''}`,
  };
};

// → { ok, said, made? } — never throws. Nothing is written when CallHub
// already sends results here.
export const connect = async (base) => {
  if (!callhubOn()) return { ok: false, said: 'CALLHUB_API_KEY isn’t set' };
  const want = hookUrl(base);
  try {
    const mine = (await listAll('/webhooks/')).filter((h) => h?.event === EVENT);
    if (mine.some((h) => same(h.target, want))) return { ok: true, said: 'CallHub already sends each call’s result here' };
    await callhub('POST', '/webhooks/', { body: { event: EVENT, target: want }, idempotencyKey: 'base-callhub-webhook' });
    // An address made from an earlier key answers nothing now: taken away.
    const old = `${String(base || '').replace(/\/+$/, '')}${HOOK_PREFIX}`;
    for (const h of mine) {
      if (String(h.target || '').startsWith(old) && idOf(h)) await callhub('DELETE', `/webhooks/${encodeURIComponent(idOf(h))}/`).catch(() => {});
    }
    return { ok: true, made: true, said: 'CallHub now sends each call’s result here' };
  } catch (e) {
    return { ok: false, said: refused(e) ? REFUSED : `CallHub didn’t take it: ${words(e)}` };
  }
};
