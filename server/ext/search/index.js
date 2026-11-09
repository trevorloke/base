// Finding someone at once, for the command bar (web/src/components/
// CommandBar.jsx): by the start of their name (whole or last), their whole
// email, or their phone — its digits, typed any way. Each of those has an
// index here, so a city's voter file answers in milliseconds, where People's
// own search (/persons?q=, any part of a name, address or handle) reads
// every row; the command bar falls back to that one when this finds nobody.
//
//   GET /search/people?q=…   { persons: [...] } — at most 6, by name. The
//                            same rules as /persons: someone denied People
//                            is refused, and a volunteer's rows are what
//                            they may see (lib/viewer.js), never matched on
//                            an email.
//
// Its indexes are named for it; it runs after ext/names (the name columns).
// The phone's is on its last ten digits, extension dropped — the same
// expression texting matches replies with (ext/texting/rules.js
// PHONE_DIGITS_SQL), so those lookups use it too.
import { Hono } from 'hono';
import { decide } from '../../lib/perms.js';
import { forViewer } from '../../lib/viewer.js';

const PHONE10 = `right(regexp_replace(regexp_replace(coalesce(phone, ''), '\\s*(ext\\.?|x|#).*$', '', 'i'), '\\D', '', 'g'), 10)`;

export const sql = `
create index if not exists persons_ws_name_prefix_idx on persons (workspace_id, lower(name) text_pattern_ops) where deleted_at is null;
create index if not exists persons_ws_last_prefix_idx on persons (workspace_id, lower(last_name) text_pattern_ops) where deleted_at is null;
create index if not exists persons_ws_phone10_idx on persons (workspace_id, (${PHONE10}) text_pattern_ops) where deleted_at is null;
`;

const LIMIT = 6;
const CANDIDATES = 40;
const likeStart = (s) => `${s.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
const parseJ = (v, d) => (typeof v === 'string' ? JSON.parse(v) : (v ?? d));

export const api = new Hono();

api.get('/search/people', async (c) => {
  const ctx = c.get('ctx');
  if (decide(ctx.perms, 'people') === false) return c.json({ error: 'not for you — ask a manager under Admin → Permissions' }, 403);
  const q = String(c.req.query('q') || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 100);
  if (q.length < 2) return c.json({ persons: [] });
  const params = [ctx.workspaceId, likeStart(q)];
  // Each way in reads its own index, a few rows at most; the few found are
  // put in name order after (one query reading in name order would walk the
  // whole file when nobody matches).
  const among = (cond) => `(select id from persons where workspace_id = $1 and deleted_at is null and ${cond} limit ${CANDIDATES})`;
  const ways = [among('lower(name) like $2'), among('lower(last_name) like $2')];
  // A phone: 604 555 0142, (604) 555-0142, +1 604… — its last ten digits
  // against the start of what's typed (a country code typed is dropped).
  let digits = /^[\d\s().+-]+$/.test(q) ? q.replace(/\D/g, '') : '';
  if (/^\+?1[\s().-]/.test(q) || (digits.length === 11 && digits.startsWith('1'))) digits = digits.slice(1);
  if (digits.length > 10) digits = digits.slice(-10);
  if (digits.length >= 4) {
    params.push(likeStart(digits));
    ways.push(among(`${PHONE10} like $${params.length}`));
  }
  // A whole email — the desk's only (a volunteer is never matched on one).
  if (ctx.role !== 'volunteer' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q)) {
    params.push(q);
    ways.push(among(`lower(email) = $${params.length}`));
  }
  const { rows } = await c.get('db').query(
    `select p.id, p.kind, p.name, p.first_name, p.last_name, p.email, p.phone, p.address, p.house_number, p.unit, p.city, p.postal, p.tags, p.rating
     from persons p where p.id in (${ways.join(' union all ')})
     order by lower(p.name) limit ${LIMIT}`,
    params,
  );
  return c.json({ persons: rows.map((r) => ({ ...r, tags: parseJ(r.tags, []) })).map(forViewer(ctx)) });
});
