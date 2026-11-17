// The guide as every reader gets it: the desk, the website's renderer, the
// field's GET /api/guide. Read once per campaign and kept (a memo keyed by
// vote_guide.rev): a reader asks for rev at most every 5 s, and the rows
// only when it moved — or when any Website action cleared the campaign's
// pages (cache.js cacheGen), which is how a page that gained or lost the
// module is seen at once. The days and places carry their moments (epoch
// ms) made here by B.C.'s current rule (lib/tzrule.js); the browser only
// compares them with the server's clock.
//
//   guideFor(q, ws)          → the whole guide, drafts included (memoised)
//   withNow(guide, now)      → the same with times.today and closed flags
//   publicGuide(guide, now, { draft, siteId }) → what the renderer and the
//                              field read may show (contests only when checked)
//   checklist(guide, org, now) → decision 8's list, each { key, done, words }
//   forgetGuide(ws)          → drop the memo (a write outside siteAction)
import { DEFAULT_TZ } from '../../lib/org.js';
import { atLocal, localDay, localHm, nextDay } from '../../lib/tzrule.js';
import { parseJ } from '../site/store.js';
import { cacheGen } from '../site/cache.js';
import { guideLangOf } from '../../../shared/voteguide.js';

const DAY_MS = 24 * 3600 * 1000;
export const RULE_KEYS = ['bring_listed', 'bring_unlisted', 'who', 'mail', 'access'];
export const SECTIONS = ['days', 'places', 'ballot', 'rules'];
const dateStr = (d) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const iso = (d) => (d ? new Date(d).toISOString() : null);
export const tzOf = (ws) => ws?.settings?.tz || DEFAULT_TZ;

const BLANK = {
  status: 'not_out', title: '', official_url: '', official_label: '', vote_anywhere: null, ballot_note: '',
  rules: {}, mail: {}, ride_phone: '', wait_url: '', banner: true, embed_origins: [], checked: {}, rev: 0,
  published_at: null, published_by: null, updated_at: null,
};

export const guideRow = async (q, wsId) => {
  const r = (await q.query('select * from vote_guide where workspace_id = $1', [wsId])).rows[0];
  if (!r) return { ...BLANK };
  return {
    ...r,
    rules: parseJ(r.rules, {}) || {},
    mail: parseJ(r.mail, {}) || {},
    embed_origins: parseJ(r.embed_origins, []) || [],
    checked: parseJ(r.checked, {}) || {},
  };
};

// Every row of the guide, as stored.
export const readRows = async (q, wsId) => {
  const guide = await guideRow(q, wsId);
  const days = (await q.query(
    "select id, to_char(day, 'YYYY-MM-DD') as day, kind, opens, closes, updated_at from vote_days where workspace_id = $1 and deleted_at is null order by day", [wsId],
  )).rows.map((d) => ({ id: d.id, day: dateStr(d.day), kind: d.kind, opens: d.opens, closes: d.closes, updated_at: iso(d.updated_at) }));
  const places = (await q.query(
    `select p.id, p.name, p.address, p.lat, p.lng, i.city, i.pin, i.area, i.days, i.accessible, i.curbside, i.note,
            to_char(i.closed_on, 'YYYY-MM-DD') as closed_on, i.closed_note, i.external_id, i.position, i.changed_at, i.updated_at
       from vote_place_info i join places p on p.id = i.place_id and p.workspace_id = i.workspace_id
      where i.workspace_id = $1 and p.deleted_at is null
      order by i.position, lower(p.name), p.id`, [wsId],
  )).rows;
  const contests = (await q.query(
    'select id, office, vote_for, names, position, updated_at from vote_contests where workspace_id = $1 and deleted_at is null order by position, id', [wsId],
  )).rows.map((c) => ({ id: c.id, office: c.office, vote_for: Number(c.vote_for), names: parseJ(c.names, []) || [], position: c.position, updated_at: iso(c.updated_at) }));
  // Voting places that are in GOTV but no longer in the guide.
  const gotvOnly = (await q.query(
    `select count(*)::int as n from places p where p.workspace_id = $1 and p.kind = 'voting' and p.deleted_at is null
        and not exists (select 1 from vote_place_info i where i.place_id = p.id)`, [wsId],
  )).rows[0].n;
  // The published pages holding the module, per website.
  const pages = (await q.query(
    `select id, slug, site_id, published from site_pages
      where workspace_id = $1 and deleted_at is null and status = 'published' and published::text like '%"voterguide"%'
      order by nav_order, created_at`, [wsId],
  )).rows.filter((p) => (parseJ(p.published, {})?.modules || []).some((m) => m?.kind === 'voterguide' && !m.hidden))
    .map((p) => ({ id: p.id, slug: p.slug, site_id: p.site_id || null, module: (parseJ(p.published, {}).modules || []).find((m) => m?.kind === 'voterguide' && !m.hidden) }));
  return { guide, days, places, contests, gotvOnly, pages };
};

// A page whose draft or published version holds a shown voterguide module.
export const holdsGuide = (p) => [p.draft, p.published].some((v) => (parseJ(v, {})?.modules || []).some((m) => m?.kind === 'voterguide' && !m.hidden));

// The rows with their moments.
export const buildGuide = (rows, tz) => {
  const { guide } = rows;
  const days = rows.days.map((d) => {
    const startsAt = atLocal(d.day, '00:00', tz);
    return {
      day: d.day, kind: d.kind, opens: d.opens, closes: d.closes,
      startsAt, opensAt: atLocal(d.day, d.opens, tz), closesAt: atLocal(d.day, d.closes, tz), endsAt: atLocal(nextDay(d.day), '00:00', tz),
    };
  });
  const byDay = new Map(days.map((d) => [d.day, d]));
  const places = rows.places.map((p) => {
    const own = (parseJ(p.days, []) || []).filter((e) => e && typeof e.day === 'string');
    const changed = p.changed_at ? new Date(p.changed_at).getTime() : null;
    return {
      id: p.id, name: p.name, address: p.address || '', city: p.city || '', area: p.area || '',
      lat: p.lat == null ? null : Number(p.lat), lng: p.lng == null ? null : Number(p.lng), pin: p.pin || null,
      accessible: p.accessible ?? null, curbside: p.curbside ?? null, note: p.note || '',
      closed_on: dateStr(p.closed_on), closed_note: p.closed_note || '', external_id: p.external_id || null,
      position: Number(p.position) || 0,
      changed_day: changed ? localDay(changed, tz) : null, changed_hm: changed ? localHm(changed, tz) : null,
      updated_at: iso(p.updated_at),
      // Its days as stored (the desk), and the ones that exist with their hours.
      own_days: own,
      days: own.filter((e) => byDay.has(e.day)).sort((a, b) => a.day.localeCompare(b.day)).map((e) => {
        const d = byDay.get(e.day);
        const opens = /^\d\d:\d\d$/.test(e.opens || '') ? e.opens : d.opens;
        const closes = /^\d\d:\d\d$/.test(e.closes || '') ? e.closes : d.closes;
        return { day: e.day, opens, closes, opensAt: atLocal(e.day, opens, tz), closesAt: atLocal(e.day, closes, tz), own: opens !== d.opens || closes !== d.closes };
      }),
    };
  });
  const areas = [];
  for (const p of places) if (p.area && !areas.includes(p.area)) areas.push(p.area);
  const checks = [guide.checked?.days?.on, guide.checked?.places?.on].filter(Boolean).sort();
  return {
    rev: Number(guide.rev) || 0,
    tz,
    status: guide.status,
    title: guide.title,
    official_url: guide.official_url,
    official_label: guide.official_label,
    vote_anywhere: guide.vote_anywhere ?? null,
    ballot_note: guide.ballot_note || '',
    rules: Object.fromEntries(RULE_KEYS.map((k) => [k, String(guide.rules?.[k] || '')])),
    mail: { request_by: guide.mail?.request_by || null, url: guide.mail?.url || '' },
    ride_phone: guide.ride_phone || '',
    wait_url: guide.wait_url || '',
    banner: guide.banner !== false,
    embed_origins: guide.embed_origins || [],
    checked: guide.checked || {},
    checkedOn: checks.at(-1) || null,
    published_at: iso(guide.published_at),
    updated_at: iso(guide.updated_at),
    days,
    bannerFrom: days.length ? atLocal(days[0].day, '00:00', tz) - 7 * DAY_MS : null,
    places,
    areas,
    contests: rows.contests,
    gotvOnly: rows.gotvOnly,
    pages: rows.pages,
    rawDays: rows.days,
  };
};

// ── The memo ──
const memo = new Map(); // workspaceId → { rev, gen, tz, checkedAt, guide }
const FRESH_MS = 5000;
// Readers who come while the rev is being asked (or the rows read) wait for
// that one read: a crowd of phones or pages costs one query, not one each.
const asking = new Map(); // `${wsId}|${gen}|${tz}` → promise of the guide
export const forgetGuide = (wsId) => { if (wsId) memo.delete(wsId); else memo.clear(); asking.clear(); };
export const guideFor = async (q, ws) => {
  const wsId = ws.id;
  const tz = tzOf(ws);
  const hit = memo.get(wsId);
  const gen = cacheGen();
  if (hit && hit.gen === gen && hit.tz === tz && Date.now() - hit.checkedAt < FRESH_MS) return hit.guide;
  const key = `${wsId}|${gen}|${tz}`;
  if (asking.has(key)) return asking.get(key);
  const read = (async () => {
    if (hit && hit.gen === gen && hit.tz === tz) {
      const rev = (await q.query('select rev from vote_guide where workspace_id = $1', [wsId])).rows[0]?.rev ?? 0;
      if (Number(rev) === hit.rev) { hit.checkedAt = Date.now(); return hit.guide; }
    }
    const guide = buildGuide(await readRows(q, wsId), tz);
    if (memo.size > 200) memo.clear();
    memo.set(wsId, { rev: guide.rev, gen, tz, checkedAt: Date.now(), guide });
    return guide;
  })();
  asking.set(key, read);
  try { return await read; } finally { if (asking.get(key) === read) asking.delete(key); }
};

// The guide at a moment: today's campaign day, and whether each place is
// closed today (closed_on is that day; on any other day it is open again).
export const withNow = (guide, now) => {
  const today = localDay(now, guide.tz);
  const todayEndsAt = atLocal(nextDay(today), '00:00', guide.tz);
  return {
    ...guide,
    now,
    today,
    todayEndsAt,
    places: guide.places.map((p) => ({ ...p, closed: p.closed_on === today })),
  };
};

// The times shared/voteguide.js reads.
export const timesOf = (g, status = g.status) => ({ status, days: g.days, bannerFrom: g.bannerFrom, today: g.today, todayEndsAt: g.todayEndsAt });

// What a reader outside the desk may see: a published guide (or a draft in
// a preview), the ballot only once someone checked it. `page` is the
// first published page of this website (siteId; null the main) holding
// the module.
export const publicGuide = (guide, now, { draft = false, siteId = null } = {}) => {
  const g = withNow(guide, now);
  const shown = draft || g.status === 'published';
  const page = g.pages.find((p) => (p.site_id || null) === (siteId || null)) || null;
  const base = {
    rev: g.rev, now, status: shown ? 'published' : 'not_out', official_url: g.official_url, official_label: g.official_label,
    page: page ? (page.slug === 'home' ? '/' : `/${page.slug}`) : null, pageModule: page?.module || null,
    banner: g.banner,
  };
  if (!shown) return { ...base, times: { status: 'not_out', days: [] }, days: [], places: [], areas: [], contests: [], rules: {}, mail: {} };
  const ballotOk = Boolean(g.checked?.ballot?.on);
  return {
    ...base,
    times: timesOf(g, 'published'),
    days: g.days,
    places: g.places.map(({ own_days: _o, updated_at: _u, external_id: _e, ...p }) => p),
    areas: g.areas,
    contests: ballotOk ? g.contests.map((c) => ({ office: c.office, vote_for: c.vote_for, names: c.names.map((n) => ({ name: n.name, ours: n.ours === true })) })) : [],
    rules: g.rules,
    ballot_note: g.ballot_note,
    mail: g.mail,
    ride_phone: g.ride_phone,
    wait_url: g.wait_url,
    vote_anywhere: g.vote_anywhere,
    checkedOn: g.checkedOn,
  };
};

// ── Publishing's checklist (decision 8), in order ──
export const CHECKS = [
  ['days', 'Add at least one voting day'],
  ['general', 'Add election day (a General day)'],
  ['future', 'Every voting day has passed — add the next election’s days'],
  ['places', 'Add at least one voting place'],
  ['anywhere', 'Say whether voters can vote at any voting place'],
  ['official', 'Add the elections office’s link'],
  ['checkDays', 'Tick ‘I checked this against the official notice’ under Voting days'],
  ['checkPlaces', 'Tick ‘I checked this against the official notice’ under Voting places'],
  ['authorized', 'Add who authorized it (your financial agent) in Website → Settings'],
  ['checkBallot', 'Tick ‘I checked this against the official notice’ under On the ballot'],
  ['checkRules', 'Tick ‘I checked this’ under What to bring and who can vote'],
];
export const checklist = (g, authorization, now) => {
  const hasRules = Object.values(g.rules).some((t) => String(t).trim()) || Boolean(String(g.ballot_note).trim());
  const done = {
    days: g.days.length > 0,
    general: g.days.some((d) => d.kind === 'general'),
    future: g.days.some((d) => d.closesAt > now),
    places: g.places.length > 0,
    anywhere: g.vote_anywhere === true || g.vote_anywhere === false,
    official: /^https:\/\//.test(g.official_url || ''),
    checkDays: Boolean(g.checked?.days?.on),
    checkPlaces: Boolean(g.checked?.places?.on),
    authorized: Boolean(String(authorization || '').trim()),
    checkBallot: !g.contests.length || Boolean(g.checked?.ballot?.on),
    checkRules: !hasRules || Boolean(g.checked?.rules?.on),
  };
  // "Every voting day has passed" only once there are days to have passed.
  const shown = { checkBallot: g.contests.length > 0, checkRules: hasRules, future: g.days.length > 0 };
  return CHECKS.filter(([k]) => shown[k] ?? true)
    .map(([key, words]) => ({ key, words, done: done[key] }));
};

// The guide's state, as the desk names it: not_out, draft, live, over.
export const deskState = (g, now) => {
  if (g.status !== 'published') return g.status === 'draft' ? 'draft' : 'not_out';
  const last = g.days.at(-1);
  return last && now >= last.closesAt ? 'over' : 'live';
};

// "Changed since checked", per section: its newest change after its check.
export const changedSinceChecked = (g) => {
  const newest = {
    days: g.rawDays.map((d) => d.updated_at).sort().at(-1),
    places: g.places.map((p) => p.updated_at).sort().at(-1),
    ballot: g.contests.map((c) => c.updated_at).sort().at(-1),
    rules: g.updated_at,
  };
  return Object.fromEntries(SECTIONS.map((s) => {
    const at = g.checked?.[s]?.at;
    return [s, Boolean(at && newest[s] && newest[s] > at)];
  }));
};

// The guide language of each of these people from their Language field
// (the walk list's rows, so "Where to vote" picks it with no read of the
// person): person id → 'pa' | 'zh-Hans' | 'zh-Hant', English left out. A
// volunteer sees it only when the field is shown to volunteers.
export const guideLangs = async (q, ctx, ids) => {
  const out = new Map();
  if (!ids.length) return out;
  const rows = (await q.query(
    `select v.person_id, v.value from person_field_values v join person_fields f on f.id = v.field_id and f.workspace_id = v.workspace_id
      where v.workspace_id = $1 and lower(f.name) = 'language' and f.retired_at is null ${ctx.role === 'volunteer' ? 'and f.volunteers' : ''}
        and v.person_id = any($2::uuid[])`, [ctx.workspaceId, ids],
  )).rows;
  for (const r of rows) {
    const code = guideLangOf(parseJ(r.value, r.value));
    if (code !== 'en') out.set(r.person_id, code);
  }
  return out;
};
