// GET /voted/summary (desk): the numbers by band, by turf and by voting
// place, kept 15 s per campaign (a settings commit drops them at once).
//   by_turf    from the turf index and one set of the supporters who voted —
//              never every located person in Node on every request
//   by_place   the voting places open today: names today, the last one's
//              time, scrutineers on duty, the close
//   held       the To check names waiting (names still on phones can't be
//              counted); marked_hour: scrutineer marks saved in the last hour
//   practice   ?practice=1 while practice runs: practice marks over the
//              record (only the Get out the vote screen asks)
import { SUPPORT_CODES, countsOf, settingsOf } from './brief.js';
import { turfIndex } from './turfindex.js';
import { hoursOf, tzOf, today, placesOpenOn, closeAt } from './clock.js';
import { rowOf } from './state.js';
import { startOfDay } from '../../lib/tzsql.js';

const KEEP_MS = 15_000;
const kept = new Map(); // `${ws}:${practice}` → { at, body }
export const forgetSummary = (ws, all) => {
  for (const [k, v] of kept) if (k.startsWith(`${ws}:`) && (all || Date.now() - v.at > KEEP_MS)) kept.delete(k);
};
const bandOfRating = (r) => {
  const c = String(r ?? '');
  if (!c) return 'unrated';
  if (SUPPORT_CODES.includes(c)) return 'support';
  return c[0] === '3' ? 'undecided' : 'opposed';
};
const iso = (d) => (d ? new Date(d).toISOString() : null);

export const summaryOf = async (db, ctx, wantPractice) => {
  const ws = ctx.workspaceId;
  const s = await rowOf(db, ws);
  const practice = Boolean(wantPractice && s.practice);
  const k = `${ws}:${practice ? 1 : 0}`;
  const hit = kept.get(k);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.body;
  const tz = tzOf(ctx);
  const settings = await settingsOf(db, ctx);
  const counts = await countsOf(db, ctx);
  // Practice: the latest practice mark of each person, over the record.
  const practiced = practice ? new Map((await db.query(
    `select distinct on (person_id) person_id, voted from gotv_practice where workspace_id = $1 order by person_id, feed_id desc`, [ws],
  )).rows.map((r) => [r.person_id, r.voted])) : null;
  const by_band = { support: 0, undecided: 0, opposed: 0, unrated: 0 };
  for (const b of (await db.query(
    'select rating, count(*)::int as n from persons where workspace_id = $1 and deleted_at is null and voted_at is not null group by rating', [ws],
  )).rows) by_band[bandOfRating(b.rating)] += b.n;
  const supporters = new Set((await db.query(
    `select id from persons where workspace_id = $1 and deleted_at is null and rating in ('1', '2')`, [ws],
  )).rows.map((r) => r.id));
  const voted = new Set((await db.query(
    `select id from persons where workspace_id = $1 and deleted_at is null and voted_at is not null and rating in ('1', '2')`, [ws],
  )).rows.map((r) => r.id));
  if (practiced) {
    for (const [id, v] of practiced) if (v && supporters.has(id)) voted.add(id);
    counts.supporters_voted = voted.size;
  }
  const idx = await turfIndex(db, ws);
  const turfs = (await db.query('select id, name from turfs where workspace_id = $1 and deleted_at is null order by created_at', [ws])).rows;
  const by_turf = turfs.map((t) => {
    const ids = idx.turfs.get(t.id)?.ids || new Set();
    let sup = 0; let v = 0;
    for (const id of ids) if (supporters.has(id)) { sup += 1; if (voted.has(id)) v += 1; }
    return { turf_id: t.id, name: t.name, supporters: sup, voted: v, people: ids.size };
  });
  // The voting places open today.
  const h = await hoursOf(db, ws);
  const day = today(tz);
  const open = placesOpenOn(h, day);
  const table = practice ? 'gotv_practice' : 'voted_marks';
  const marks = new Map((await db.query(
    `select place_id, count(*)::int as n, max(created_at) as last_at from ${table}
      where workspace_id = $1 and place_id is not null and voted and undoes is null and created_at >= ${startOfDay('$2::text')}
      group by place_id`, [ws, tz],
  )).rows.map((r) => [r.place_id, r]));
  const posts = (await db.query(
    "select place_id, days from gotv_posts where workspace_id = $1 and ended_at is null and role = 'scrutineer'", [ws],
  )).rows;
  const onDutyAt = (pid) => posts.filter((p) => p.place_id === pid && (() => {
    const days = typeof p.days === 'string' ? JSON.parse(p.days) : p.days || [];
    return !days.length || days.includes(day);
  })()).length;
  const by_place = open.map((p) => ({
    place_id: p.id, name: p.name, marks_today: marks.get(p.id)?.n || 0, last_at: iso(marks.get(p.id)?.last_at),
    scrutineers_on_duty: onDutyAt(p.id), closes_at: iso(closeAt(h, s, day, p.id, tz)),
  }));
  const held = (await db.query(
    'select count(*)::int as n from gotv_checks where workspace_id = $1 and resolved_at is null and practice = $2', [ws, practice],
  )).rows[0].n;
  const marked_hour = (await db.query(
    `select count(*)::int as n from ${table} where workspace_id = $1 and source = 'scrutineer' and voted and undoes is null and inserted_at > now() - interval '1 hour'`,
    [ws],
  )).rows[0].n;
  const body = { ...settings, ...counts, by_band, by_turf, by_place, held, marked_hour, practice };
  kept.set(k, { at: Date.now(), body });
  return body;
};
