// Finding a person, fast and complete: the command bar (web/src/components/
// CommandBar.jsx) and every box that picks a person (the relationship
// editor first). Each way in reads an index here, so a city's voter file
// answers in milliseconds, where People's own search (/persons?q=, any part
// of a name, address or handle) reads every row.
//
//   GET /search/people?q=…&limit=&after=&role=&not=&list=
//     → { persons, more, total, many[, cap][, hint] }
//   q      at least 2 characters, at most 100. Read one of five ways:
//          digits only — the start of a phone (4+ digits; with or without
//            its area code), or of an address (3+ digits: a house number);
//            two digits alone find no one (hint: 'digits');
//          a digit then letters — the start of an address ("14520 72 ave");
//          an @ — the start of an email, the desk's only;
//          one word like "ksmith" or "k.smith" on the desk — a name, or the
//            start of an email;
//          anything else — a name: each word starts a word of it, in any
//            order ("smith kevin", "Smith, Kevin", "kev smi"), accents and
//            apostrophes ignored (shared/names.js foldTerm).
//   limit  default 6 (the command bar's), at most 50
//   after  a person's id: the people after them, A–Z (lib/az.js)
//   role   a volunteer role's code: only people holding it
//   not    one person's id, left out (the profile being edited)
//   list   a list's id (the desk's): each row says on_list
//   total  how many match, on the first page, when that's cheap to know;
//          when one way in matches more than SEARCH_CAP: total null, many
//          true and the cap, so the screen says "More than 5,000".
//          Later pages: total null (the screen keeps the first page's).
// The same rules as /persons: someone denied People is refused, and a
// volunteer's rows are what they may see (lib/viewer.js), never matched on
// an email.
//
// Its indexes are named for it; it runs after ext/names (the name columns).
// The phone's is on its last ten digits, extension dropped — the same
// expression texting matches replies with (ext/texting/rules.js
// PHONE_DIGITS_SQL), so those lookups use it too.
import { Hono } from 'hono';
import { VOLUNTEER_ROLE_CODES } from '@starbase/shared/canvass';
import { foldTerm } from '@starbase/shared/names';
import { decide } from '../../lib/perms.js';
import { forViewer } from '../../lib/viewer.js';
import { azKey, azAfter } from '../../lib/az.js';
// The very expression texting uses (no database, no network in that file),
// so the two can't drift apart and both read this index.
import { PHONE_DIGITS_SQL } from '../texting/rules.js';

const PHONE10 = PHONE_DIGITS_SQL('phone');
const LIVE = 'where deleted_at is null';

// persons_ws_name_prefix_idx and persons_ws_last_prefix_idx are no longer
// read here; they stay one release so a server still running the old
// search during a deploy isn't left without them. Next release: drop both.
export const sql = `
create index if not exists persons_ws_name_prefix_idx on persons (workspace_id, lower(name) text_pattern_ops) ${LIVE};
create index if not exists persons_ws_last_prefix_idx on persons (workspace_id, lower(last_name) text_pattern_ops) ${LIVE};
create index if not exists persons_ws_phone10_idx on persons (workspace_id, (${PHONE10}) text_pattern_ops) ${LIVE};
-- An earlier draft of this index (all digits); never kept.
drop index if exists persons_ws_phone_digits_idx;
create index if not exists persons_ws_name_fold_idx on persons (workspace_id, person_fold(name) text_pattern_ops) ${LIVE};
create index if not exists persons_ws_last_fold_idx on persons (workspace_id, person_fold(last_name) text_pattern_ops) ${LIVE};
create index if not exists persons_ws_last_tail_idx on persons (workspace_id, person_fold_tail(last_name) text_pattern_ops) ${LIVE} and last_name ~ '[ -]';
create index if not exists persons_ws_middle_fold_idx on persons (workspace_id, person_fold(middle_name) text_pattern_ops) ${LIVE} and middle_name is not null;
create index if not exists persons_ws_az_idx on persons (workspace_id, (person_fold(coalesce(last_name, name)) collate "C"), (person_fold(name) collate "C"), id) ${LIVE};
create index if not exists persons_ws_phone7_idx on persons (workspace_id, right(${PHONE10}, 7) text_pattern_ops) ${LIVE};
create index if not exists persons_ws_email_prefix_idx on persons (workspace_id, lower(email) text_pattern_ops) ${LIVE} and email is not null;
create index if not exists persons_ws_addr_prefix_idx on persons (workspace_id, lower(address) text_pattern_ops) ${LIVE} and address is not null;
`;

// Every way in reads at most SEARCH_CAP + 1 ids, which is what keeps the
// count cheap; past it the answer says "more than" instead. Tests lower it.
export let SEARCH_CAP = 5000;
export const setSearchCap = (n) => { SEARCH_CAP = n; };
// Tests see each query run here (to explain its plan).
let trace = null;
export const setSearchTrace = (fn) => { trace = fn; };

const LIMIT = 6;
const MAX_LIMIT = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DESK = ['manager', 'treasurer', 'staff'];
const escLike = (s) => s.replace(/[%_\\]/g, (m) => `\\${m}`);
const parseJ = (v, d) => (typeof v === 'string' ? JSON.parse(v) : (v ?? d));
const COLS = 'p.id, p.kind, p.name, p.first_name, p.middle_name, p.last_name, p.email, p.phone, p.address, p.house_number, p.unit, p.city, p.postal, p.tags, p.rating';
// The first column of the A–Z order (lib/az.js), as persons_ws_az_idx has it.
const AZ1 = 'person_fold(coalesce(p.last_name, p.name)) collate "C"';

// A way in: its test on persons (n: where its value sits among the query's
// parameters) and that value. Each query numbers its own, so none carries a
// parameter it never reads (the database can't type those).
const way = (key, value, cond, more = {}) => ({ key, value, cond, ...more });
const nameWays = (w) => {
  const v = `${escLike(w)}%`;
  return [
    way('name', v, (n) => `person_fold(name) like $${n}`, { named: true }),
    way('last', v, (n) => `person_fold(last_name) like $${n}`, { named: true, start: w }),
    way('tail', v, (n) => `person_fold_tail(last_name) like $${n} and last_name ~ '[ -]'`, { named: true }),
    way('middle', v, (n) => `person_fold(middle_name) like $${n} and middle_name is not null`, { named: true }),
  ];
};
const startOf = (col, low) => way(col, `${escLike(low)}%`, (n) => `lower(${col}) like $${n} and ${col} is not null`);

// What was typed → the words of a name (and, for one word on the desk, an
// email's start too), or the ways a number, an address or an email comes in.
const readTerm = (raw, vol) => {
  const low = raw.toLowerCase();
  if (/^[\d\s().+-]+$/.test(raw)) {
    const ways = [];
    // A leading 1 is the country code (no North American area code starts with 1).
    let phone = raw.replace(/\D/g, '');
    if (phone.startsWith('1')) phone = phone.slice(1);
    if (phone.length > 10) phone = phone.slice(-10);
    if (phone.length >= 4) {
      ways.push(way('phone10', `${phone}%`, (n) => `${PHONE10} like $${n}`));
      // The number without its area code.
      if (phone.length <= 7) ways.push(way('phone7', `${phone}%`, (n) => `right(${PHONE10}, 7) like $${n}`));
    }
    // A house number: three digits typed together at the start.
    if (/^\d{3}/.test(raw)) ways.push(startOf('address', low));
    return ways.length ? { ways } : { hint: 'digits' };
  }
  if (/^\d/.test(raw)) return { ways: [startOf('address', low)] };
  if (raw.includes('@')) return { ways: vol ? [] : [startOf('email', low)] };
  // A name: words on spaces, commas and hyphens; a one-letter word filters
  // but never leads.
  const words = [...new Set(foldTerm(raw).split(/[\s,-]+/).filter(Boolean))].slice(0, 8);
  return { words, extra: !vol && /^[a-z0-9._-]+$/i.test(raw) ? startOf('email', low) : null };
};

// Parameters for one query: $1 the workspace, then whatever it adds.
const bind = (ws) => {
  const params = [ws];
  return { params, add: (v) => { params.push(v); return params.length; } };
};
const among = (cap, cond) => `select p.id from persons p where p.workspace_id = $1 and p.deleted_at is null and ${cond} limit ${cap + 1}`;
// How many each way finds, up to the cap and one: one query, one index range each.
const countWays = async (run, ws, cap, ways) => {
  if (!ways.length) return;
  const b = bind(ws);
  const row = (await run(`select ${ways.map((w, i) => `(select count(*)::int from (${among(cap, w.cond(b.add(w.value)))}) x) as c${i}`).join(', ')}`, b.params)).rows[0];
  ways.forEach((w, i) => { w.n = row[`c${i}`]; });
};

export const api = new Hono();

api.get('/search/people', async (c) => {
  const ctx = c.get('ctx');
  if (decide(ctx.perms, 'people') === false) return c.json({ error: 'not for you — ask a manager under Admin → Permissions' }, 403);
  const db = c.get('db');
  const run = (text, params) => { trace?.(text, params); return db.query(text, params); };
  const ws = ctx.workspaceId;
  const vol = ctx.role === 'volunteer';
  const raw = String(c.req.query('q') || '').trim().replace(/\s+/g, ' ').slice(0, 100);
  const after = c.req.query('after') || '';
  const none = (extra = {}) => c.json({ persons: [], more: false, total: after ? null : 0, many: false, ...extra });
  if (raw.length < 2) return none();
  const limit = Math.min(Math.max(Number.parseInt(c.req.query('limit'), 10) || LIMIT, 1), MAX_LIMIT);
  if (after && !UUID_RE.test(after)) return none();
  const cap = SEARCH_CAP;

  const term = readTerm(raw, vol);
  if (term.hint) return none({ hint: term.hint });
  let ways = term.ways;
  if (term.words) {
    const long = term.words.filter((w) => w.length >= 2);
    if (!long.length) return none();
    // The word that leads is the one whose ways find the fewest. Ties: the
    // longer, then the one typed later.
    const tried = long.map((w, i) => ({ w, i, ways: nameWays(w) }))
      .sort((a, b) => b.w.length - a.w.length || b.i - a.i).slice(0, 3);
    await countWays(run, ws, cap, tried.flatMap((t) => t.ways));
    for (const t of tried) t.sum = t.ways.reduce((s, w) => s + w.n, 0);
    // A word none of whose ways finds anyone can't lead ("der" in Van Der
    // Berg starts no part of a name); it still has to fit (below).
    const found = tried.filter((t) => t.sum > 0);
    ways = found.length ? found.reduce((best, t) => (t.sum < best.sum ? t : best)).ways : [];
    if (term.extra) {
      await countWays(run, ws, cap, [term.extra]);
      ways = [...ways, term.extra];
    }
  } else await countWays(run, ws, cap, ways);
  ways = ways.filter((w) => w.n > 0);
  if (!ways.length) return none();

  const b = bind(ws);
  // A name: every word must start a word of the whole name. (An email's
  // start, for one word on the desk, needn't: "k.smith".)
  let fits = '';
  if (ways.some((w) => w.named)) for (const w of term.words) fits += ` and (' ' || translate(person_fold(p.name), '-', ' ')) like $${b.add(`% ${escLike(w)}%`)}`;
  const test = (w, cond) => (w.named ? `${cond}${fits}` : cond);
  let filter = '';
  // Who else is asked for: a role's holders; not this one.
  const role = c.req.query('role');
  if (role) filter += VOLUNTEER_ROLE_CODES.includes(role) ? ` and exists (select 1 from volunteer_roles v where v.person_id = p.id and v.role = $${b.add(role)})` : ' and false';
  const not = c.req.query('not');
  if (not && UUID_RE.test(not)) filter += ` and p.id <> $${b.add(not)}`;
  // On that list already (the desk's Add people): one primary-key probe a row.
  let onList = '';
  const list = c.req.query('list');
  if (list && UUID_RE.test(list) && DESK.includes(ctx.role)) {
    const found = (await db.query('select 1 from lists where id = $1 and workspace_id = $2 and deleted_at is null', [list, ws])).rows[0];
    if (found) onList = `, exists (select 1 from list_members lm where lm.list_id = $${b.add(list)} and lm.person_id = p.id) as on_list`;
  }
  const afterSql = after ? ` and ${azAfter('p', b.add(after), '>')}` : '';
  const live = 'p.workspace_id = $1 and p.deleted_at is null';
  const pick = `${COLS}${onList}, ${AZ1} as k1, person_fold(p.name) collate "C" as k2`;
  const capped = ways.some((w) => w.n > cap);
  let rows;
  if (!capped) {
    // Few enough: gather every match, count them, and page in A–Z order.
    rows = (await run(
      `with m as materialized (${ways.map((w) => `(${among(cap, test(w, w.cond(b.add(w.value))))})`).join(' union ')}),
       f as materialized (select ${pick} from persons p join m on m.id = p.id where ${live}${filter})
       select p.*${after ? '' : ', (select count(*)::int from f) as total'} from f p where true${afterSql}
       order by p.k1, p.k2, p.id limit ${limit + 1}`,
      b.params,
    )).rows;
  } else {
    // Some way finds more than the cap: each way reads in A–Z order on its
    // own and stops at a page, and the pages are put together. A surname's
    // way is a range of the A–Z index itself; a crowded first name, middle
    // name, address or email walks that index with its own test; a way
    // with few matches sorts its few.
    const streams = ways.map((w) => {
      let cond;
      if (w.n <= cap) cond = `p.id in (${among(cap, test(w, w.cond(b.add(w.value))))})`;
      else if (w.start) {
        const z = w.start.slice(0, -1) + String.fromCharCode(w.start.charCodeAt(w.start.length - 1) + 1);
        cond = test(w, `${AZ1} >= $${b.add(w.start)} and ${AZ1} < $${b.add(z)}`);
      } else cond = test(w, w.cond(b.add(w.value)));
      return `(select ${pick} from persons p where ${live} and ${cond}${filter}${afterSql} order by ${azKey('p')} limit ${limit + 1})`;
    });
    rows = (await run(`select * from (${streams.join(' union ')}) s order by s.k1, s.k2, s.id limit ${limit + 1}`, b.params)).rows;
  }
  const first = !after;
  const capOut = first && capped ? { cap } : {};
  const persons = rows.slice(0, limit).map((r) => {
    const { k1: _a, k2: _b, total: _t, ...row } = r;
    return { ...row, tags: parseJ(row.tags, []) };
  }).map(forViewer(ctx));
  return c.json({
    persons,
    more: rows.length > limit,
    total: first && !capped ? (rows[0]?.total ?? 0) : null,
    many: first && capped,
    ...capOut,
  });
});
