// GET /places?kind=<code>      the chips for "Where": { places: [{ id, name,
//                              lat, lng, address, source, uses, kind_uses }],
//                              words: [{ name, uses, kind_uses }] } — saved
//                              places, this kind's most used first, then
//                              the words already on shifts (places.js)
// GET /places/name?lat=&lng=   a name for a point tapped on the map:
//                              { name, source, address? } (places.js nameFor)
// GET /schedule/week?week=<day>  "Tell everyone on this week's shifts",
//                              before it is sent and after: { week, people,
//                              shifts, providers: { email, text }, jobs,
//                              quiet: { now, opens } | null, last: { batch_id,
//                              at, people, waiting, unsure, reached } | null,
//                              reminders: { on, next_at, can_set } }. `week`:
//                              any day of it (this week when left out).
// GET /schedule/notices/:id    one notice, a person a row: { batch_id, kind,
//                              week, at, people: [{ person_id, name, state,
//                              email, text, text_note }] } — how each went,
//                              never an address or a number; a volunteer
//                              granted Shifts gets the names only (tell.js)
// The desk's (deskOnlyReads), or a volunteer granted Shifts. Area: shifts
// (lib/perms.js). Not under /shifts/…: routes/api.js answers /shifts/:id
// and 404s anything else there before feature routes mount.
import { Hono } from 'hono';
import { dayOf, isDay } from '@starbase/shared/dayparts';
import { SHIFT_KIND_CODES } from '@starbase/shared/shiftkinds';
import { now } from '../texting/rules.js';
import { nameFor, placesFor, pointOf } from './places.js';
import { tzOf } from './rules.js';
import { noticeResults, weekState } from './tell.js';

export const api = new Hono();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

api.get('/schedule/week', async (c) => {
  const ctx = c.get('ctx');
  const day = c.req.query('week') || dayOf(now(), tzOf(ctx));
  if (!isDay(day)) return c.json({ error: 'week: a day, as YYYY-MM-DD' }, 400);
  return c.json(await weekState(c.get('db'), ctx, day));
});

api.get('/schedule/notices/:id', async (c) => {
  const id = c.req.param('id');
  const ctx = c.get('ctx');
  const found = UUID_RE.test(id) ? await noticeResults(c.get('db'), ctx.workspaceId, id, { full: ctx.role !== 'volunteer' }) : null;
  return found ? c.json(found) : c.json({ error: 'not found' }, 404);
});
