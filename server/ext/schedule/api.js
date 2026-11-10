// GET /places?kind=<code>      the chips for "Where": { places: [{ id, name,
//                              lat, lng, address, source, uses, kind_uses }],
//                              words: [{ name, uses, kind_uses }] } — saved
//                              places, this kind's most used first, then
//                              the words already on shifts (places.js)
// GET /places/name?lat=&lng=   a name for a point tapped on the map:
//                              { name, source, address? } (places.js nameFor)
// The desk's (deskOnlyReads), or a volunteer granted Shifts. Area: shifts
// (lib/perms.js). Not under /shifts/…: routes/api.js answers /shifts/:id
// and 404s anything else there before feature routes mount.
import { Hono } from 'hono';
import { SHIFT_KIND_CODES } from '@starbase/shared/shiftkinds';
import { nameFor, placesFor, pointOf } from './places.js';

export const api = new Hono();

api.get('/places', async (c) => {
  const kind = c.req.query('kind') || null;
  if (kind && !SHIFT_KIND_CODES.includes(kind)) return c.json({ error: 'not a kind of shift' }, 400);
  return c.json(await placesFor(c.get('db'), c.get('ctx').workspaceId, kind));
});

api.get('/places/name', async (c) => {
  const point = pointOf(c.req.query('lat'), c.req.query('lng'));
  if (!point) return c.json({ error: 'lat and lng: a point on the map' }, 400);
  return c.json(await nameFor(c.get('db'), c.get('ctx').workspaceId, point));
});
