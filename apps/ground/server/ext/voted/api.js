// GET /voted/status        anyone: { on, manual, auto, election_day, advance_days, voting_day } —
//                          whether GOTV mode is on (the screens offer "Voted ✓")
// GET /voted/summary       desk: the numbers by band and by turf (deskOnlyReads)
// GET /voted/persons/:id   anyone: one person's voted_at and their marks (who
//                          marked them only for desk roles)
import { Hono } from 'hono';
import { pointInPolygon } from '../../lib/geo.js';
import { SUPPORT_CODES, countsOf, settingsOf } from './brief.js';

export const api = new Hono();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const parseJ = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; } };
// The scale's bands by code: 1 · 2 support, 3 undecided, 4 (and 4B, 4D…)
// opposed (shared/scale.js bandOf); no rating is its own band here.
const bandOfRating = (r) => {
  const c = String(r ?? '');
  if (!c) return 'unrated';
  if (SUPPORT_CODES.includes(c)) return 'support';
  return c[0] === '3' ? 'undecided' : 'opposed';
};

api.get('/voted/status', async (c) => c.json(await settingsOf(c.get('db'), c.get('ctx'))));

api.get('/voted/summary', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const ws = ctx.workspaceId;
  const settings = await settingsOf(db, ctx);
  const counts = await countsOf(db, ctx);
  const by_band = { support: 0, undecided: 0, opposed: 0, unrated: 0 };
  for (const b of (await db.query(
    'select rating, count(*)::int as n from persons where workspace_id = $1 and deleted_at is null and voted_at is not null group by rating', [ws],
  )).rows) by_band[bandOfRating(b.rating)] += b.n;
  // By turf: the pins inside each polygon, as the turf list counts them.
  // voted: the turf's supporters who have voted (beside supporters, so the
  // row says how many are left to get out).
  const located = (await db.query(
    'select lat, lng, rating, voted_at from persons where workspace_id = $1 and deleted_at is null and lat is not null and lng is not null', [ws],
  )).rows;
  const turfs = (await db.query(
    'select id, name, polygon from turfs where workspace_id = $1 and deleted_at is null order by created_at', [ws],
  )).rows;
  const by_turf = turfs.map((t) => {
    const polygon = parseJ(t.polygon, []);
    const inside = located.filter((p) => pointInPolygon(p.lat, p.lng, polygon));
    const supporters = inside.filter((p) => SUPPORT_CODES.includes(String(p.rating ?? '')));
    return { turf_id: t.id, name: t.name, supporters: supporters.length, voted: supporters.filter((p) => p.voted_at).length, people: inside.length };
  });
  return c.json({ ...settings, ...counts, by_band, by_turf });
});

api.get('/voted/persons/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json({ error: 'not found' }, 404);
  const ctx = c.get('ctx');
  const db = c.get('db');
  const p = (await db.query(
    'select id, voted_at from persons where id = $1 and workspace_id = $2 and deleted_at is null', [id, ctx.workspaceId],
  )).rows[0];
  if (!p) return c.json({ error: 'not found' }, 404);
  const desk = ctx.role !== 'volunteer';
  const marks = (await db.query(
    desk
      ? `select m.voted, m.source, m.created_at, u.name as by_name from voted_marks m left join users u on u.id = m.marked_by
         where m.workspace_id = $1 and m.person_id = $2 order by m.created_at desc, m.id limit 100`
      : `select m.voted, m.source, m.created_at from voted_marks m
         where m.workspace_id = $1 and m.person_id = $2 order by m.created_at desc, m.id limit 100`,
    [ctx.workspaceId, id],
  )).rows;
  return c.json({ voted_at: p.voted_at, marks });
});
