// The voter guide on the public website (VG decisions 11, 16, 21), called
// from the site's routes (server/ext/site/public.js), which answer on every
// website of the campaign and under each language's prefix:
//   GET  <root>/api/guide/clock   { now } — the server's clock, never kept
//   POST <root>/api/guide/find    { address } → { lat, lng } to 3 decimals.
//        A typed address is looked up and forgotten: no row, no event, no
//        log line with it. 30 a minute from one address, 300 a minute for
//        the campaign in all (the B.C. service's rate is shared), each
//        checked before any lookup.
//   embed.js                      the snippet's script: sets the iframe's height
import { now } from '../../lib/clock.js';
import { clientIp, makeLimiter } from '../../lib/guard.js';
import { city as orgCity } from '../../lib/org.js';
import { geocodeAddress } from '../../lib/geocode.js';
import { UI_WORDS } from '../../../shared/site/ui-words.js';
import { guideFor } from './read.js';
import { inFence } from './api.js';

const perAddress = makeLimiter({ windowMs: 60_000, max: 30 });
const perCampaign = makeLimiter({ windowMs: 60_000, max: 300 });
const FIND_MS = 5000;
const off = () => String(process.env.GEOCODER || 'bc').trim().toLowerCase() === 'off';

export const clockRoute = (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ now: now() });
};

// The words go back in the page's language (w: the site's rc.w-like lookup).
export const findRoute = async (c, site, w = (k) => UI_WORDS[k]) => {
  c.header('Cache-Control', 'no-store');
  const guide = await guideFor(site.db, site.ws);
  if (guide.status !== 'published') return c.json({ error: w('vg.notOut') }, 404);
  if (perAddress(clientIp(c))) return c.json({ error: w('vg.tooMany') }, 429);
  if (perCampaign(site.ws.id)) return c.json({ error: w('vg.busy') }, 429);
  let body;
  try { body = await c.req.json(); } catch { body = null; }
  const address = String(body?.address ?? '').trim();
  if (!address || address.length > 200) return c.json({ error: w('vg.notFound') }, 400);
  if (off()) return c.json({ error: w('vg.lookupOff') }, 503);
  let r;
  try {
    r = await Promise.race([
      geocodeAddress({ address, city: orgCity() }),
      new Promise((resolve) => { setTimeout(() => resolve({ error: 'timeout' }), FIND_MS).unref?.(); }),
    ]);
  } catch { r = null; }
  if (!r || r.error || r.weak || !Number.isFinite(Number(r.lat)) || !inFence(Number(r.lat), Number(r.lng))) {
    return c.json({ error: w('vg.notFound') }, 400);
  }
  const round = (v) => Math.round(Number(v) * 1000) / 1000;
  return c.json({ lat: round(r.lat), lng: round(r.lng) });
};
