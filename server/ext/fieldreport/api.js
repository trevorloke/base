// The field report, for the desk (the data area, beside Reports).
//   GET /field-report?from&to       knocks by turf, by canvasser and by day,
//                                   and the totals — { range, turfs,
//                                   canvassers, days, totals }
//   GET /field-report.csv?from&to   the turfs, a blank row, the canvassers
// from/to are the campaign's days (YYYY-MM-DD; from=all for no start); with
// neither, the last 30 days. Volunteers are refused, unless a manager gave
// them the Data area (as the desk's guard lets them in).
import { Hono } from 'hono';
import { csvResponse } from '../../lib/csv.js';
import { decide } from '../../lib/perms.js';
import { fieldReport, zoneOf } from './numbers.js';

export const api = new Hono();

const TURF_HEAD = ['Turf', 'Doors', 'Knocked', 'Coverage %', 'Talked', 'Yes', 'No answer', 'Refused', 'Moved', 'No access', 'Other', 'Canvassers', 'Last knock'];
const CANVASSER_HEAD = ['Canvasser', 'Team', 'Doors', 'Talked', 'Yes', 'Days out', 'Last out'];

const deskOnly = (ctx) => ctx.role === 'volunteer' && decide(ctx.perms, 'data') !== true;
const refuse = (c) => c.json({ error: 'desk only' }, 403);

const load = async (c) => {
  const ctx = c.get('ctx');
  const tz = zoneOf(ctx.workspace.settings?.tz);
  return fieldReport(c.get('db'), ctx.workspaceId, { from: c.req.query('from'), to: c.req.query('to') }, tz);
};
const answer = async (c, fn) => {
  if (deskOnly(c.get('ctx'))) return refuse(c);
  try {
    return await fn(await load(c));
  } catch (e) {
    if (e.status) return c.json({ error: e.message }, e.status);
    throw e;
  }
};

// "2026-11-01 16:12" in the campaign's zone, as a spreadsheet reads it.
const stamp = (v, tz) => {
  if (!v) return '';
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(v));
  const g = (t) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
};

api.get('/field-report', (c) => answer(c, (r) => c.json(r)));

api.get('/field-report.csv', (c) => answer(c, (r) => {
  const tz = r.range.tz;
  const rows = [
    ...r.turfs.map((t) => [t.name, t.doors, t.knocked, t.coverage_pct, t.talked, t.support_found, t.no_answer, t.refused,
      t.moved, t.inaccessible, t.other, t.canvassers, stamp(t.last_knock_at, tz)]),
    [],
    CANVASSER_HEAD,
    ...r.canvassers.map((p) => [p.name, p.team || '', p.doors, p.talked, p.support_found, p.days_out, stamp(p.last_out, tz)]),
  ];
  return csvResponse(c, `field-report-${r.range.from}-${r.range.to}`, TURF_HEAD, rows);
}));
