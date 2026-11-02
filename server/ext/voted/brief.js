// The numbers Today and the Election day screen share (lib/hooks.js brief):
//   body.voted = { on, election_day, total, today, supporters, supporters_voted }
// total: people marked as voted; today: marks made today, in the campaign's
// day (settings.tz, Vancouver by default — the dashboard's day boundary);
// supporters: people rated in the support band — the scale's 1 and 2 (the
// campaign renames the words, never the steps). Volunteers get the same
// numbers: there is no money or email in them.
import { DEFAULT_TZ } from '../../lib/org.js';

export const SUPPORT_CODES = ['1', '2'];
const START_OF_TODAY = "date_trunc('day', now() at time zone $2::text) at time zone $2::text";
const dateOnly = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

export const settingsOf = async (db, ws) => {
  const s = (await db.query('select on_day, election_day from voted_settings where workspace_id = $1', [ws])).rows[0];
  return { on: Boolean(s?.on_day), election_day: s?.election_day ? dateOnly(s.election_day) : null };
};

export const countsOf = async (db, ctx) => {
  const ws = ctx.workspaceId;
  const tz = ctx.workspace?.settings?.tz || DEFAULT_TZ;
  const r = (await db.query(
    `select (count(*) filter (where p.voted_at is not null))::int as total,
            (count(*) filter (where p.rating in ('1', '2')))::int as supporters,
            (count(*) filter (where p.rating in ('1', '2') and p.voted_at is not null))::int as supporters_voted
     from persons p where p.workspace_id = $1 and p.deleted_at is null`,
    [ws],
  )).rows[0];
  const today = (await db.query(
    `select count(*)::int as n from voted_marks where workspace_id = $1 and voted and created_at >= ${START_OF_TODAY}`,
    [ws, tz],
  )).rows[0].n;
  return { total: r.total, today, supporters: r.supporters, supporters_voted: r.supporters_voted };
};

export const briefVoted = async (db, ctx, body) => {
  const settings = await settingsOf(db, ctx.workspaceId);
  const counts = await countsOf(db, ctx);
  body.voted = { ...settings, ...counts };
};
