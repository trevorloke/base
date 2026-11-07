// The website's way in: a key per website (or form service), made by a
// manager, and a small JSON API the website's SERVER calls — never the
// visitor's browser, which would show the key to anyone.
//
//   Authorization: Bearer sbk_<40 characters>
//   GET  /in/v1/ping      → { ok, campaign, key }            is the key good?
//   POST /in/v1/people    → { ok: true, person_id }
//
// What a visitor typed is not proof of who they are, so: the same email
// fills a person's blanks and adds tags; with no email, a name and phone
// match only gets the tags; anything else is a new person. Nothing on file
// is overwritten. newsletter: true puts a new email on the list — never back
// on it for someone who left or is do-not-email. volunteer: true, or a
// note, files a request under Today's Needs you. The answer is only the
// person's id: it never says whether they were on file. Everything is on
// the event log, as the key's maker; an address is placed on the map. A key
// stops when its maker leaves the campaign.
//
// Idempotency-Key (any string ≤ 200): the same key with the same body answers
// what it answered the first time, once — a website retrying after a lost
// answer never makes a second person. 120 requests a minute per key.
//
// Keys: intake.key.create (manager; the key is answered once and stored as
// its sha256), intake.key.revoke; GET /api/intake/keys (manager) lists them
// with when each was last used. Settings → Services shows them.
import { Hono } from 'hono';
import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import { getDb } from '../../db/client.js';
import { newId, runAction } from '../../lib/events.js';
import { makeLimiter } from '../../lib/guard.js';
import { civic } from '../../lib/address.js';
import { httpError } from '../../actions/util.js';
import { splitFirst } from '@base-ground/shared/names';

export const sql = `
create table if not exists intake_keys (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  prefix text not null,
  key_hash text not null unique,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists intake_keys_ws_idx on intake_keys (workspace_id, created_at);
create table if not exists intake_requests (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  key_id uuid not null references intake_keys(id) on delete cascade,
  idempotency_key text not null,
  body_hash text not null,
  answer jsonb not null,
  created_at timestamptz not null default now(),
  primary key (key_id, idempotency_key)
);
`;

const sha = (s) => createHash('sha256').update(s).digest('hex');
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const makeKey = () => `sbk_${[...randomBytes(40)].map((b) => ALPHA[b % ALPHA.length]).join('')}`;
const keyOut = (r) => ({ id: r.id, name: r.name, prefix: r.prefix, created_at: r.created_at, last_used_at: r.last_used_at, revoked_at: r.revoked_at });

export const actions = {
  'intake.key.create': {
    roles: ['manager'],
    input: z.object({ name: z.string().trim().min(1).max(80) }),
    handler: async (tx, ctx, input, emit) => {
      const id = newId();
      const key = makeKey();
      const prefix = key.slice(0, 10);
      await tx.query(
        'insert into intake_keys (id, workspace_id, name, prefix, key_hash, created_by) values ($1, $2, $3, $4, $5, $6)',
        [id, ctx.workspaceId, input.name, prefix, sha(key), ctx.user.id],
      );
      emit('intake_key', id, 'create', { name: input.name, prefix });
      // The only time the key itself is ever answered.
      return { id, name: input.name, prefix, key };
    },
  },
  'intake.key.revoke': {
    roles: ['manager'],
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const r = (await tx.query(
        'update intake_keys set revoked_at = coalesce(revoked_at, now()) where id = $1 and workspace_id = $2 returning id',
        [input.id, ctx.workspaceId],
      )).rows[0];
      if (!r) throw httpError(404, 'key not found');
      emit('intake_key', input.id, 'void', {});
      return { id: input.id };
    },
  },
};

export const api = new Hono();
api.get('/intake/keys', async (c) => {
  if (c.get('ctx').role !== 'manager') return c.json({ error: 'managers only' }, 403);
  const rows = (await c.get('db').query(
    'select * from intake_keys where workspace_id = $1 order by created_at desc', [c.get('ctx').workspaceId],
  )).rows;
  return c.json({ keys: rows.map(keyOut) });
});
export const deskOnlyReads = ['/intake/keys'];

// ── The website's side ──
const limited = makeLimiter({ windowMs: 60_000, max: 120 });
const str = (max) => z.string().trim().max(max).optional().nullable();
const personIn = z.object({
  name: str(300),
  first_name: str(150),
  middle_name: str(150),
  last_name: str(150),
  email: z.string().trim().toLowerCase().email().max(320).optional().nullable(),
  phone: str(40),
  address: str(1000),
  unit: str(40),
  city: str(120),
  postal: str(20),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  newsletter: z.boolean().optional(),
  volunteer: z.boolean().optional(),
  note: str(2000),
  source: str(80),
}).strict().refine((v) => v.email || v.phone, { message: 'an email or a phone' })
  .refine((v) => v.name || v.first_name || v.last_name || v.email, { message: 'a name' });

const norm = (s) => String(s ?? '').trim();
const lower = (s) => norm(s).toLowerCase();
const digits = (s) => norm(s).replace(/\D+/g, '');
const nameKey = (s) => lower(s).replace(/\s+/g, ' ');
const parseTags = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? JSON.parse(v) : []);
// Tags as the website sends them (the app's own are case-sensitive: "VIP");
// the source as a lowercase word ("petition-transit").
const tagAsSent = (s) => norm(s).replace(/\s+/g, ' ').slice(0, 40);
const slug = (s) => norm(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

const keyFor = async (db, c) => {
  const m = /^Bearer\s+(sbk_[A-Za-z0-9]{20,})$/.exec(c.req.header('authorization') || '');
  if (!m) return null;
  const k = (await db.query(
    `select k.*, w.name as workspace_name from intake_keys k join workspaces w on w.id = k.workspace_id
       join memberships m on m.user_id = k.created_by and m.workspace_id = k.workspace_id
      where k.key_hash = $1 and k.revoked_at is null`, [sha(m[1])],
  )).rows[0];
  return k || null;
};
const refuse = (c, status, error) => c.json({ error }, status);

export const publicRoutes = new Hono();

publicRoutes.use('/in/v1/*', async (c, next) => {
  const db = await getDb();
  const key = await keyFor(db, c);
  if (!key) return refuse(c, 401, 'a valid key goes in the Authorization header: Bearer sbk_…');
  if (limited(key.id)) return refuse(c, 429, 'too many requests — 120 a minute per key');
  c.set('intakeKey', key);
  c.set('intakeDb', db);
  await db.query('update intake_keys set last_used_at = now() where id = $1', [key.id]);
  return next();
});

publicRoutes.get('/in/v1/ping', (c) => {
  const k = c.get('intakeKey');
  return c.json({ ok: true, campaign: k.workspace_name, key: k.name });
});

// One person in: match or create, then the newsletter and the request.
// The website forwards whatever a visitor typed, so nothing here trusts it
// with someone else's record: only the same email fills blanks on a match;
// without an email, a match by name and phone only gets the tags. An email
// that matches nobody is a new person, never added to someone found by name.
const takeIn = async (tx, ws, p, emit) => {
  const name = norm(p.name) || [norm(p.first_name), norm(p.middle_name), norm(p.last_name)].filter(Boolean).join(' ') || p.email.split('@')[0];
  const source = slug(p.source || 'website') || 'website';
  const tags = [...new Set([source, ...(p.tags || []).map(tagAsSent).filter(Boolean), ...(p.newsletter ? ['newsletter'] : [])])];
  const addr = p.address ? civic({ address: norm(p.address) }) : null;
  const cand = (await tx.query(
    `select id, name, email, phone, address, house_number, unit, city, postal, lat, tags from persons
      where workspace_id = $1 and deleted_at is null
        and ((lower(email) = $2 and $2 <> '') or (regexp_replace(coalesce(phone, ''), '\\D', '', 'g') = $3 and $3 <> ''))
      order by created_at limit 50`,
    [ws, lower(p.email), digits(p.phone)],
  )).rows;
  const nk = nameKey(name);
  const byEmail = p.email ? cand.find((r) => lower(r.email) === lower(p.email)) : null;
  const byPhone = !p.email && p.phone ? cand.find((r) => nameKey(r.name) === nk && digits(r.phone) === digits(p.phone)) : null;
  const match = byEmail || byPhone || null;
  let personId;
  if (match) {
    personId = match.id;
    const patch = {};
    if (byEmail) {
      if (!match.phone && p.phone) patch.phone = norm(p.phone);
      if (!match.address && addr) Object.assign(patch, { address: addr.address, house_number: addr.house_number || null, unit: norm(p.unit) || null });
      if (!match.city && p.city) patch.city = norm(p.city);
      if (!match.postal && p.postal) patch.postal = norm(p.postal).toUpperCase();
    }
    const had = parseTags(match.tags);
    const next = [...new Set([...had, ...tags])].slice(0, 50);
    if (next.length !== had.length) patch.tags = next;
    if (Object.keys(patch).length) {
      const keys = Object.keys(patch);
      const sets = keys.map((k, i) => (k === 'tags' ? `${k} = $${i + 3}::jsonb` : `${k} = $${i + 3}`));
      await tx.query(
        `update persons set ${sets.join(', ')}, updated_at = now() where id = $1 and workspace_id = $2`,
        [personId, ws, ...keys.map((k) => (k === 'tags' ? JSON.stringify(patch[k]) : patch[k]))],
      );
      emit('person', personId, 'update', { ...patch, source: 'website' });
    }
  } else {
    personId = newId();
    const row = {
      id: personId, kind: 'person', name, email: p.email || null, phone: norm(p.phone) || null,
      address: addr?.address || null, house_number: addr?.house_number || null, unit: norm(p.unit) || null,
      city: norm(p.city) || null, postal: norm(p.postal).toUpperCase() || null, tags,
    };
    // First and last as the form sent them; a whole name alone is split (ext/names).
    // A first name with a second word ("Mary Anne"): Mary, middle Anne (shared/names.js).
    const firstLast = !norm(p.name) && (norm(p.first_name) || norm(p.middle_name) || norm(p.last_name));
    const cut = firstLast && !norm(p.middle_name) ? splitFirst(p.first_name) : null;
    await tx.query(
      `insert into persons (id, workspace_id, kind, name, email, phone, address, house_number, unit, city, postal, tags, socials, first_name, last_name, middle_name)
       values ($1, $2, 'person', $3, $4, $5, $6, $7, $8, $9, $10, $11, '{}', $12, $13, $14)`,
      [personId, ws, row.name, row.email, row.phone, row.address, row.house_number, row.unit, row.city, row.postal, JSON.stringify(tags),
       firstLast ? (cut ? cut.first : norm(p.first_name) || null) : null, firstLast ? norm(p.last_name) || null : null,
       firstLast ? (cut ? cut.middle : norm(p.middle_name) || null) : null],
    );
    emit('person', personId, 'create', { ...row, source: 'website' });
  }

  // The newsletter: on the list — but never back on it for someone who left
  // it or said not to email them. Typing an address into a website form
  // doesn't prove it's yours.
  if (p.newsletter && p.email) {
    const prev = (await tx.query('select id from subscriptions where workspace_id = $1 and email = $2', [ws, p.email])).rows[0];
    const noEmail = (await tx.query(
      `select 1 from persons where workspace_id = $1 and lower(email) = $2 and deleted_at is null and tags @> '"do-not-email"'::jsonb limit 1`,
      [ws, p.email],
    )).rows.length > 0;
    if (!prev && !noEmail) {
      const id = newId();
      await tx.query(
        `insert into subscriptions (id, workspace_id, email, name, status, source) values ($1, $2, $3, $4, 'subscribed', $5)
         on conflict (workspace_id, email) do nothing`,
        [id, ws, p.email, name, source],
      );
      emit('subscription', id, 'create', { email: p.email, name, source });
    }
  }

  // Wants to volunteer, or wrote something: a request under Today's Needs
  // you — never written onto their record.
  if (p.volunteer || p.note) {
    const id = newId();
    const kind = p.volunteer ? 'volunteer' : 'other';
    const from = p.source ? `From the website (${norm(p.source)})` : 'From the website';
    const note = [from, norm(p.note)].filter(Boolean).join(': ').slice(0, 500);
    await tx.query(
      `insert into door_requests (id, workspace_id, person_id, kind, note, asked_by) values ($1, $2, $3, $4, $5, null)`,
      [id, ws, personId, kind, note],
    );
    emit('door_request', id, 'create', { id, person_id: personId, kind, note, from: 'website' });
  }
  // Only the id: never whether they were on file, what was blank, or
  // whether they had left the list.
  return { person_id: personId };
};

publicRoutes.post('/in/v1/people', async (c) => {
  const key = c.get('intakeKey');
  const db = c.get('intakeDb');
  if (!/^application\/json\b/i.test(c.req.header('content-type') || '')) return refuse(c, 415, 'send JSON (Content-Type: application/json)');
  const raw = await c.req.text();
  let body;
  try { body = JSON.parse(raw); } catch { return refuse(c, 400, 'the body isn’t JSON'); }
  const parsed = personIn.safeParse(body);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return refuse(c, 400, `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`);
  }
  const idem = norm(c.req.header('idempotency-key')).slice(0, 200);
  const bodyHash = sha(raw);
  if (idem) {
    const prev = (await db.query('select body_hash, answer from intake_requests where key_id = $1 and idempotency_key = $2', [key.id, idem])).rows[0];
    if (prev) {
      if (prev.body_hash !== bodyHash) return refuse(c, 409, 'that Idempotency-Key was used with a different body');
      const answer = typeof prev.answer === 'string' ? JSON.parse(prev.answer) : prev.answer;
      return c.json({ ok: true, ...answer, replayed: true });
    }
  }
  try {
    const { result: answer } = await runAction(db, { workspaceId: key.workspace_id, actorId: key.created_by, action: 'intake.person' }, async (tx, emit) => {
      const a = await takeIn(tx, key.workspace_id, parsed.data, emit);
      if (idem) {
        // A week of retries is plenty; older answers go.
        await tx.query("delete from intake_requests where key_id = $1 and created_at < now() - interval '7 days'", [key.id]);
        await tx.query(
          `insert into intake_requests (workspace_id, key_id, idempotency_key, body_hash, answer) values ($1, $2, $3, $4, $5)`,
          [key.workspace_id, key.id, idem, bodyHash, JSON.stringify(a)],
        );
      }
      return a;
    });
    return c.json({ ok: true, ...answer });
  } catch (e) {
    // Two retries at once: the second waits for the first's answer.
    if (idem && /intake_requests_pkey|duplicate key/i.test(String(e.message))) {
      const prev = (await db.query('select body_hash, answer from intake_requests where key_id = $1 and idempotency_key = $2', [key.id, idem])).rows[0];
      if (prev && prev.body_hash !== bodyHash) return refuse(c, 409, 'that Idempotency-Key was used with a different body');
      if (prev) return c.json({ ok: true, ...(typeof prev.answer === 'string' ? JSON.parse(prev.answer) : prev.answer), replayed: true });
    }
    throw e;
  }
});
