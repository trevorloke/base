// The cuts organizers live on, as People filters — so a saved list, an email
// or text blast and a phone bank built from a list get them too
// (lib/audience.js personsWhere; the keys are in its FILTER_KEYS):
//   knocked=never|7|14|30|60   nobody has knocked on their door (a door
//                              contact) ever / in the last N days
//   outcome=<code>             their latest contact, any channel, ended so
//                              (shared/canvass.js OUTCOMES: no_answer, left_lit…)
//   turf=<id>                  their pin is inside that turf
//   postal=V3T                 their postal code starts so (spaces ignored)
//   notag=a,b                  they have none of these tags
//   voted=no|yes               not marked as voted yet / marked (ext/voted) —
//                              GOTV's list: supporters who still have to vote
// A value it doesn't understand matches nobody, never everybody.
import { OUTCOMES } from '@base-ground/shared/canvass';
import { pointInPolygon } from '../../lib/geo.js';
import { isMoneyTag } from '../../lib/viewer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAYS = new Set(['7', '14', '30', '60']);
const str = (v, max = 80) => String(v ?? '').trim().slice(0, max);
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

const personsWhere = async (db, ctx, query, w) => {
  const none = () => { w.where += ' and false'; };
  const door = "select 1 from contacts c where c.person_id = p.id and c.workspace_id = p.workspace_id and c.channel = 'door'";
  const next = (v) => { w.params.push(v); return `$${w.params.length}`; };

  const knocked = str(query?.knocked, 10);
  if (knocked === 'never') w.where += ` and not exists (${door})`;
  else if (DAYS.has(knocked)) {
    w.where += ` and not exists (${door} and c.created_at > now() - make_interval(days => ${next(Number(knocked))}::int))`;
  } else if (knocked) none();

  const outcome = str(query?.outcome, 30);
  if (outcome && OUTCOMES.includes(outcome)) {
    w.where += ` and (select c.outcome from contacts c where c.person_id = p.id and c.workspace_id = p.workspace_id
                       order by c.created_at desc limit 1) = ${next(outcome)}`;
  } else if (outcome) none();

  const turf = str(query?.turf, 40);
  if (turf) {
    const t = UUID_RE.test(turf) ? (await db.query(
      'select polygon from turfs where id = $1 and workspace_id = $2 and deleted_at is null', [turf, ctx.workspaceId],
    )).rows[0] : null;
    const ring = t ? parse(t.polygon).map(([lat, lng]) => [Number(lat), Number(lng)]) : [];
    if (ring.length < 3) none();
    else {
      const lats = ring.map((r) => r[0]);
      const lngs = ring.map((r) => r[1]);
      const inBox = (await db.query(
        `select id, lat, lng from persons where workspace_id = $1 and deleted_at is null
           and lat between $2 and $3 and lng between $4 and $5`,
        [ctx.workspaceId, Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)],
      )).rows;
      const ids = inBox.filter((r) => pointInPolygon(Number(r.lat), Number(r.lng), ring)).map((r) => r.id);
      w.where += ` and p.id = any(${next(ids)}::uuid[])`;
    }
  }

  const postal = str(query?.postal, 10).toUpperCase().replace(/\s+/g, '');
  if (postal && /^[A-Z0-9]{1,6}$/.test(postal)) {
    w.where += ` and upper(replace(coalesce(p.postal, ''), ' ', '')) like ${next(`${postal}%`)}`;
  } else if (postal) none();

  const notag = str(query?.notag, 400);
  if (notag) {
    const tags = [...new Set(notag.split(',').map((t) => t.trim()).filter(Boolean))].slice(0, 20);
    // A volunteer can't sort by the money tags they can't see.
    if (ctx.role === 'volunteer' && tags.some(isMoneyTag)) { none(); return; }
    for (const t of tags) w.where += ` and not (p.tags @> ${next(JSON.stringify(t))}::jsonb)`;
  }

  const voted = str(query?.voted, 5);
  if (voted === 'no') w.where += ' and p.voted_at is null';
  else if (voted === 'yes') w.where += ' and p.voted_at is not null';
  else if (voted) none();
};

export const hooks = { personsWhere };
