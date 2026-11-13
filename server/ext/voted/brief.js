// The numbers Today and the Election day screen share (lib/hooks.js brief):
//   body.voted = { on, election_day, total, today, supporters, supporters_voted }
// total: people marked as voted; today: marks made today, in the campaign's
// day (settings.tz, Vancouver by default — the dashboard's day boundary);
// supporters: people rated in the support band — the scale's 1 and 2 (the
// campaign renames the words, never the steps). Volunteers get the same
// numbers: there is no money or email in them.
import { DEFAULT_TZ } from '../../lib/org.js';
import { startOfDay } from '../../lib/tzsql.js';

export const SUPPORT_CODES = ['1', '2'];
const START_OF_TODAY = startOfDay('$2::text');
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

// The GOTV card's numbers as volunteers see them: on a voting day every
// volunteer opens Today, and each visit counted the whole list twice (over
// 200 ms at 300,000). One count per campaign is kept for half a minute and
// shared; a mark (vote.mark's after step) drops it, so the walker who just
// marked someone sees it at once. A count that began before a mark is not
// kept: it may have read the list before the mark committed.
// Any other write that changes voted_at (an undo, an import's Voted column,
// the voted feed) must call forgetCounts(ws) once it commits, or volunteers
// see the old numbers for up to half a minute.
const KEEP_MS = 30_000;
const kept = new Map(); // workspaceId -> { key, at, counts }
const marks = new Map(); // workspaceId -> how many marks have dropped the count
export const forgetCounts = (ws) => { kept.delete(ws); marks.set(ws, (marks.get(ws) || 0) + 1); };
const sharedCounts = async (db, ctx) => {
  const ws = ctx.workspaceId;
  let day;
  try { day = campaignDay(ctx.workspace?.settings?.tz || DEFAULT_TZ); } catch { day = campaignDay(DEFAULT_TZ); }
  const key = `${ctx.workspace?.settings?.tz || ''}|${day}`;
  const hit = kept.get(ws);
  if (hit && hit.key === key && Date.now() - hit.at < KEEP_MS) return hit.counts;
  const gen = marks.get(ws) || 0;
  const at = Date.now();
  const counts = await countsOf(db, ctx);
  if ((marks.get(ws) || 0) === gen) kept.set(ws, { key, at, counts });
  return counts;
};

// A volunteer sees the numbers only on the GOTV card, which shows only while
// GOTV is on; on other days their Today counts nothing over the whole list.
// The desk counts afresh every time.
export const briefVoted = async (db, ctx, body) => {
  const settings = await settingsOf(db, ctx);
  const counts = ctx.role !== 'volunteer' ? await countsOf(db, ctx) : settings.on ? await sharedCounts(db, ctx) : {};
  body.voted = { ...settings, ...counts };
};
