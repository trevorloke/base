// GET /api/persons/:id/timeline[?group=…][&before=<cursor>][&limit=50]
// (signed in; the People area, like the profile). What it answers and who
// gets what: index.js.
import { Hono } from 'hono';
import { decide } from '../../lib/perms.js';
import { DEFAULT_TZ } from '../../lib/org.js';
import { SOURCES, GROUPS } from './sources.js';

export const api = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONEY_ROLES = ['manager', 'treasurer', 'staff'];
const PAGE = 50;
const PAGE_MAX = 100;

// What this sign-in may be shown. A volunteer stays a volunteer whatever
// areas they were given (lib/viewer.js); an area a manager denied is denied.
const viewerOf = (ctx) => {
  const open = (area) => decide(ctx.perms, area) !== false;
  return {
    userId: ctx.user.id,
    desk: ctx.role !== 'volunteer',
    money: MONEY_ROLES.includes(ctx.role) && open('money'),
    outreach: open('outreach'),
  };
};

// Newest first; two of one moment by their keys, as the database orders
// them (sources.js page: byte order).
const newestFirst = (a, b) => (b.at - a.at) || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0);

// A cursor is the last entry shown: "<its time>~<its key>", the time as a
// page writes it. One made by hand that the database couldn't read back
// (a year outside 0001–9999, which a JS date allows) is a bad cursor.
const cursorOf = (e) => `${e.at.toISOString()}~${e.key}`;
const readCursor = (raw) => {
  const cut = String(raw).indexOf('~');
  const when = String(raw).slice(0, cut);
  const at = new Date(when);
  const year = at.getUTCFullYear();
  const key = String(raw).slice(cut + 1);
  if (cut < 1 || !/^\d{4}-\d{2}-\d{2}T/.test(when) || !(year >= 1 && year <= 9999) || !/^[\x21-\x7e]{1,200}$/.test(key)) return null;
  return { at: at.toISOString(), key };
};

api.get('/persons/:id/timeline', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id || '')) return c.json({ error: 'not found' }, 404);
  const ctx = c.get('ctx');
  const db = c.get('db');
  const person = (await db.query(
    'select id, name, first_name, email from persons where id = $1 and workspace_id = $2 and deleted_at is null', [id, ctx.workspaceId],
  )).rows[0];
  if (!person) return c.json({ error: 'not found' }, 404);

  const viewer = viewerOf(ctx);
  const mine = SOURCES.filter((s) => s.can(viewer));
  const groups = GROUPS.filter((g) => mine.some((s) => s.group === g));
  const group = c.req.query('group') || 'all';
  if (group !== 'all' && !GROUPS.includes(group)) return c.json({ error: `group: all, ${GROUPS.join(', ')}` }, 400);
  // A chip that isn't theirs is refused, never answered as an empty history.
  if (group !== 'all' && !groups.includes(group)) {
    return c.json({ error: viewer.desk ? 'not for you — ask a manager under Admin → Permissions' : 'volunteers cannot view this' }, 403);
  }
  const raw = c.req.query('before');
  const before = raw ? readCursor(raw) : null;
  if (raw && !before) return c.json({ error: 'before: the cursor the last page gave' }, 400);
  const limit = Math.min(Math.max(Math.floor(Number(c.req.query('limit'))) || PAGE, 1), PAGE_MAX);

  // Each source gives its newest page (one more than asked, to know whether
  // there is more); the newest of them all is the page.
  const q = {
    ws: ctx.workspaceId, person, viewer, before, limit: limit + 1,
    tz: ctx.workspace?.settings?.tz || DEFAULT_TZ, campaign: ctx.workspace?.name || '',
  };
  const found = [];
  for (const s of mine) {
    if (group === 'all' || s.group === group) found.push(...await s.read(db, q));
  }
  found.sort(newestFirst);
  const entries = found.slice(0, limit);
  return c.json({
    entries: entries.map(({ key, at, ...e }) => ({ id: key, at: at.toISOString(), ...e })),
    next: found.length > limit ? cursorOf(entries[entries.length - 1]) : null,
    groups,
  });
});
