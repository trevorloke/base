// The organizer's own follow-ups (mounted under /api, signed in; any role).
//
//   GET /followups/mine   the open follow-ups handed to the signed-in
//       teammate, the most urgent first: { followups: [{ id, kind, text,
//       did: [{ kind, from, words, roles, availability, note, topic,
//       message, shift, place, asked_by, at }], created_at, due_at, routed,
//       person: { id, name, phone, address, unit, rating, tags } }], now }.
//       now: the server's clock, so a phone with its clock off still counts
//       the 24 hours right. A volunteer's rows go through the volunteer rule
//       (lib/viewer.js: no one else's email, no money tag), and nothing in
//       them is about money (speed to lead is volunteers, messages and RSVPs;
//       a ladder's own follow-up — "thank them for their first donation" —
//       is never on a volunteer's list: it is never handed to one, one they
//       had when made a volunteer goes back to the office (hook.js), and
//       this read leaves out any that got there some other way).
import { Hono } from 'hono';
import { forViewer } from '../../lib/viewer.js';

export const api = new Hono();

const parse = (v, d) => {
  try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; }
};
// What the card shows of each thing they did — never the rows it came from.
const DID_KEYS = ['kind', 'from', 'words', 'roles', 'availability', 'note', 'topic', 'message', 'shift', 'place', 'asked_by', 'source', 'at'];
const didOut = (d) => Object.fromEntries(DID_KEYS.filter((k) => d?.[k] != null).map((k) => [k, d[k]]));

api.get('/followups/mine', async (c) => {
  const ctx = c.get('ctx');
  const rows = (await c.get('db').query(
    `select f.id, f.kind, f.text, f.detail, f.created_at, f.due_at, f.routed, f.ladder_id,
            p.id as pid, p.name, p.email, p.phone, p.address, p.unit, p.rating, p.tags
     from ladder_followups f join persons p on p.id = f.person_id and p.deleted_at is null
     where f.workspace_id = $1 and f.assigned_to = $2 and f.status = 'open'
       and (f.kind is not null or $3::boolean)
     order by f.due_at nulls last, f.created_at
     limit 100`,
    [ctx.workspaceId, ctx.user.id, ctx.role !== 'volunteer'],
  )).rows;
  const view = forViewer(ctx);
  return c.json({
    followups: rows.map((r) => ({
      id: r.id,
      kind: r.kind || 'ladder',
      text: r.text,
      did: (parse(r.detail, {})?.did || []).map(didOut),
      created_at: r.created_at,
      due_at: r.due_at,
      routed: r.routed || null,
      person: view({
        id: r.pid, name: r.name, email: r.email, phone: r.phone, address: r.address, unit: r.unit,
        rating: r.rating, tags: parse(r.tags, []),
      }),
    })),
    now: new Date().toISOString(),
  });
});
