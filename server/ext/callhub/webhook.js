// POST /hooks/callhub/<key> — where CallHub sends each call's result (its
// `cc.notes` webhook), no sign-in.
//
// Nothing documents a signature on these deliveries, so the lock is the
// address itself: its last part is made from the API key (callhub.js) and
// compared whole, in constant time, before a byte of the body is read. A
// wrong one is "not found". What a result can do is bounded all the same:
// it can only land on someone whose number this campaign itself sent, each
// result once, and it never makes a person (results.js). One address may
// send 600 a minute.
//
// The bytes are read once, as they came — JSON or a form — and every result
// is kept as it came (callhub_results.raw). A failure answers 500 so a
// sender that retries sends it again.
import { Hono } from 'hono';
import { getDb } from '../../db/client.js';
import { clientIp, makeLimiter } from '../../lib/guard.js';
import { callhubOn, HOOK_PREFIX, pathKeyMatches } from './callhub.js';
import { fileResult, readDelivery } from './results.js';

const limited = makeLimiter({ windowMs: 60_000, max: 600 });

export const publicRoutes = new Hono();

publicRoutes.post(`${HOOK_PREFIX}:key`, async (c) => {
  if (limited(clientIp(c))) return c.json({ error: 'too many at once — send it again in a minute' }, 429, { 'Retry-After': '60' });
  if (!callhubOn()) return c.json({ error: 'CallHub isn’t connected here' }, 503);
  if (!pathKeyMatches(c.req.param('key'))) return c.json({ error: 'not found' }, 404);
  const delivery = readDelivery(Buffer.from(await c.req.arrayBuffer()), c.req.header('content-type') || '');
  if (!delivery) return c.json({ error: 'not a call’s result' }, 400);
  try {
    // What CallHub sees for the delivery: words, never a person.
    return c.json({ received: true, ...(await fileResult(await getDb(), delivery)) });
  } catch (e) {
    console.error('callhub: a result was not filed:', e.message);
    return c.json({ error: 'not done — send it again' }, 500);
  }
});
// Nothing else answers under that address (not the app's own page either).
publicRoutes.all(`${HOOK_PREFIX}*`, (c) => c.json({ error: 'not found' }, 404));
