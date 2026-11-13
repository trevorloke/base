// POST /api/addressbook/check — one slice of a contacts file (≤ 500 rows),
// matched by the desk's rules (relationships/match.js): email first, else
// name + phone. The answer carries matches only; a row with no match is
// simply absent. No row is stored or logged, and an error never echoes one.
//
// The desk only (manager, treasurer, staff) holding People: the handler's
// own check is the guard (a volunteer granted People still gets 403 — a
// file check would let them test guessed emails against the list).
import { Hono } from 'hono';
import { z } from 'zod';
import { areasFor } from '../../lib/perms.js';
import { makeLimiter } from '../../lib/guard.js';
import { DESK_ROLES } from '../../lib/twostep.js';
import { PHONE_DIGITS_SQL } from '../texting/rules.js';
import { nameKey, phoneKey, selfPerson } from '../relationships/match.js';

export const forDesk = (ctx) => DESK_ROLES.includes(ctx.role) && !ctx.candidate && areasFor(ctx).includes('people');
const FOR_DESK = 'For the desk';
const perUser = makeLimiter({ windowMs: 3_600_000, max: 40 });

const body = z.object({
  rows: z.array(z.object({
    ref: z.number().int().min(0),
    name: z.string().trim().min(1).max(300),
    email: z.string().trim().max(320).optional(),
    phone: z.string().trim().max(40).optional(),
  })).min(1).max(500),
});
const PHONE10 = PHONE_DIGITS_SQL('phone');

export const api = new Hono();

api.post('/addressbook/check', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  if (!forDesk(ctx)) return c.json({ error: FOR_DESK }, 403);
  const parsed = body.safeParse(await c.req.json().catch(() => null));
  // Only where it went wrong, never what the row held.
  if (!parsed.success) return c.json({ error: `${parsed.error.issues[0].path.filter((p) => typeof p === 'string').join('.') || 'rows'}: not a contacts slice (1–500 rows)` }, 400);
  if (perUser(ctx.user.id)) return c.json({ error: 'That’s a lot of checking — wait an hour, or use a smaller file' }, 429);
  const ws = ctx.workspaceId;
  const rows = parsed.data.rows;
  const cols = 'id, name, address, unit, rating';

  // 1. By email (persons_ws_email_idx), oldest first.
  const emails = [...new Set(rows.map((r) => String(r.email || '').toLowerCase()).filter(Boolean))];
  const byEmail = new Map();
  if (emails.length) {
    for (const p of (await db.query(
      `select ${cols}, lower(email) as e from persons where workspace_id = $1 and deleted_at is null and lower(email) = any($2::text[])
        order by created_at, id`, [ws, emails],
    )).rows) if (!byEmail.has(p.e)) byEmail.set(p.e, p);
  }
  // 2. Else name + phone (persons_ws_phone10_idx), the name compared here.
  const rest = rows.filter((r) => !byEmail.has(String(r.email || '').toLowerCase()));
  const phones = [...new Set(rest.map((r) => phoneKey(r.phone)).filter((p) => p.length >= 7))];
  const byPhone = new Map();
  if (phones.length) {
    for (const p of (await db.query(
      `select ${cols}, ${PHONE10} as ph from persons where workspace_id = $1 and deleted_at is null and ${PHONE10} = any($2::text[])
        order by created_at, id`, [ws, phones],
    )).rows) {
      const k = `${p.ph} ${nameKey(p.name)}`;
      if (!byPhone.has(k)) byPhone.set(k, p);
    }
  }
  const out = [];
  for (const r of rows) {
    const e = String(r.email || '').toLowerCase();
    let person = e ? byEmail.get(e) : null;
    let how = 'email';
    if (!person) { person = byPhone.get(`${phoneKey(r.phone)} ${nameKey(r.name)}`) || null; how = 'phone'; }
    if (person) out.push({ ref: r.ref, person, how });
  }
  // Already in My people: a live link from the caller's own record.
  const me = out.length ? await selfPerson(db, ctx, () => {}) : null;
  const linked = new Set();
  if (me) {
    for (const l of (await db.query(
      `select person_a, person_b from relationships where workspace_id = $1 and removed_at is null and (person_a = $2 or person_b = $2)
         and (person_a = any($3::uuid[]) or person_b = any($3::uuid[]))`,
      [ws, me.id, [...new Set(out.map((o) => o.person.id))]],
    )).rows) linked.add(l.person_a === me.id ? l.person_b : l.person_a);
  }
  return c.json({
    rows: out.map(({ ref, person: p, how }) => ({
      ref, how, mine: linked.has(p.id),
      person: { id: p.id, name: p.name, address: p.address ?? null, unit: p.unit ?? null, rating: p.rating ?? null },
    })),
    checked: rows.length,
  });
});
