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

// GOTV mode: on by hand (manual), or by itself on a voting day — an
// advance-voting day or election day, in the campaign's day — while auto is
// on. voting_day: 'advance' | 'election' | null — what kind of day today is.
// { on, manual, auto, election_day, advance_days, voting_day }
const campaignDay = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const settingsOf = async (db, ctx) => {
  const ws = ctx.workspaceId;
  const tz = ctx.workspace?.settings?.tz || DEFAULT_TZ;
  const s = (await db.query('select on_day, election_day, advance_days, auto from voted_settings where workspace_id = $1', [ws])).rows[0];
  const election_day = s?.election_day ? dateOnly(s.election_day) : null;
  const raw = typeof s?.advance_days === 'string' ? JSON.parse(s.advance_days) : (s?.advance_days || []);
  const advance_days = [...new Set(raw.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
  const auto = s ? s.auto !== false : true;
  let day = null;
  try { day = campaignDay(tz); } catch { day = campaignDay(DEFAULT_TZ); }
  const voting_day = day === election_day ? 'election' : advance_days.includes(day) ? 'advance' : null;
  const manual = Boolean(s?.on_day);
  return { on: manual || (auto && Boolean(voting_day)), manual, auto, election_day, advance_days, voting_day };
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
  // People who voted today (a person marked twice is one), not marks.
  const today = (await db.query(
    `select count(*)::int as n from persons where workspace_id = $1 and deleted_at is null and voted_at >= ${START_OF_TODAY}`,
    [ws, tz],
  )).rows[0].n;
  return { total: r.total, today, supporters: r.supporters, supporters_voted: r.supporters_voted };
};

export const briefVoted = async (db, ctx, body) => {
  const settings = await settingsOf(db, ctx);
  const counts = await countsOf(db, ctx);
  body.voted = { ...settings, ...counts };
};
