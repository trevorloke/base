// The website's unsubscribes on Settings → Services (ext/connections lists
// it): whether base.win sends its own unsubscribes and text STOPs to the
// campaign's website, how many are waiting and why, how many the website
// refused — and Check, one call that writes nothing there.
//
// The key is never in an answer: only which settings are present, and the
// website's host.
import { timeZone } from '../../lib/org.js';
import { callWebsite, websiteUp } from './outbound.js';
import { KEY_ENV, URL_ENV, websiteState, withoutKey } from './website.js';

const NAME = 'The website — unsubscribes';
const FOR = 'Someone who unsubscribes or texts STOP here is taken off on the campaign’s website too';
const num = (n) => (Number(n) || 0).toLocaleString('en-CA');
// "Nov 9, 3:42 pm", on the campaign's clock.
const when = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: timeZone(), month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
  .format(new Date(iso)).replace(/\s*([ap])\.?m\.?$/i, (m, x) => ` ${x.toLowerCase()}m`);

// Why it is off, in one line.
const WHY = {
  staging: () => 'Off on staging: nothing is ever sent from here.',
  'not-set': () => 'Not set: an unsubscribe here stays here. The website’s own still come in with a website key.',
  'half-set': (s) => `Only one of the two is set: ${s.missing.join(', ')} is missing. Nothing is sent until both are.`,
  'not-address': () => `${URL_ENV} isn’t a web address: it starts with https:// and has no path.`,
  'not-https': () => `${URL_ENV} must start with https://, so the key is never sent in the open. Nothing is sent.`,
  own: () => `${URL_ENV} is this base.win’s own address. It is the website’s address that goes there. Nothing is sent.`,
  'base-win': () => `${URL_ENV} is a base.win address. Only a website hosted somewhere else is sent to. Nothing is sent.`,
  moved: (s) => `${URL_ENV} is this campaign’s own website, now on base.win (${s.host}). Take both settings away. Nothing is sent.`,
};
export const whyOff = (s = websiteState()) => (s.on ? null : WHY[s.problem](s));

// counts: what outbound.js websiteCounts answers (null: not read).
export const websiteService = (counts = null) => {
  const s = websiteState();
  const base = { key: 'website', name: NAME, for: FOR, launch: false, checkable: true };
  if (!s.on) {
    // On staging there is nothing to set: it never sends.
    return { ...base, missing: s.problem === 'staging' ? [] : s.missing, set: [URL_ENV, KEY_ENV].filter((k) => !s.missing.includes(k)), state: 'missing', detail: whyOff(s), checkable: s.problem !== 'staging' };
  }
  const lines = [`Sends each unsubscribe and text STOP to ${s.host}`];
  const noKey = counts && !counts.key;
  if (noKey) lines.push('Nothing is sent yet: this campaign has no website key. Make one under Website keys.');
  if (counts?.waiting) {
    lines.push(`${num(counts.waiting)} waiting${counts.waitingSaid ? `: ${counts.waitingSaid}${counts.waitingSince ? ` (since ${when(counts.waitingSince)})` : ''}` : ''}`);
  }
  if (counts?.refused) lines.push(`${num(counts.refused)} the website refused${counts.refusedSaid ? `: ${counts.refusedSaid}` : ''}`);
  // Set up, but something needs a look: no key to send with, held up, or refused.
  const flag = noKey ? 'needs a website key' : counts?.waitingSaid ? 'some are waiting' : counts?.refused ? 'the website refused some' : null;
  return {
    ...base, missing: [], set: [URL_ENV, KEY_ENV], state: 'ready', detail: lines.join('\n'), panel: 'website',
    ...(flag ? { flagged: true, flagWord: flag } : {}),
  };
};

// Under "Coming in".
export const websiteInbound = (base) => ({
  name: 'The website — unsubscribes in',
  url: `${String(base || '').replace(/\/+$/, '')}/in/v1/consent`,
  how: 'From the website’s server with the same website key: unsubscribes, text STOPs, preference changes',
});

// One call that writes nothing on the website: the real address and key, an
// empty body and no Idempotency-Key. The website checks, in order, that it
// has a key, that ours matches, that the body is JSON, then the
// Idempotency-Key — so "send an Idempotency-Key" means the address, the
// endpoint and the key are all right.
export const checkWebsite = async () => {
  const s = websiteState();
  if (!s.on) return { ok: false, said: whyOff(s) };
  const r = await callWebsite(s.target, { body: '{}', timeout: 7000 });
  const words = withoutKey(typeof r.body?.error === 'string' ? r.body.error : '').slice(0, 200);
  if (r.status === 400 && /idempotency-key/i.test(words)) { websiteUp(); return { ok: true, said: 'The website answers and takes this key' }; }
  if (r.status === 401) return { ok: false, said: 'The website refused the key: it must equal its STARBASE_INBOUND_KEY' };
  if (r.status === 503) return { ok: false, said: 'The website has no STARBASE_INBOUND_KEY yet' };
  if (r.status === 404) return { ok: false, said: 'No such address on the website. If the website now runs on base.win, take both settings away' };
  if (r.status === 429) return { ok: false, said: 'The website is busy (more than 120 requests a minute). Try again in a minute' };
  if (r.status === 0) return { ok: false, said: `${r.said} at ${s.host}` };
  if (r.status >= 300 && r.status < 400) return { ok: false, said: `The website sent us on to another address (${r.status}): set ${URL_ENV} to its final https:// address` };
  return { ok: false, said: `The website answered ${r.status}${words ? `: ${words}` : ''}` };
};
