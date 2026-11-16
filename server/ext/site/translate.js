// The website in other languages (TR): what is translated, when, and how
// the renderer finds it. SITE.md "Languages" says the same for people.
//
//   liveStrings(db, ws)          every English segment a visitor can see on
//                                the campaign's live websites, each with its
//                                place, class (legal | check-first | ui |
//                                content), kind (plain | markdown | composed)
//                                and whether it is essential
//   keptNames(db, ws, settings)  names never sent to be translated
//   sweep(db, workspaceId)       the job: one sweep at a time per campaign;
//                                new segments sent in batches outside any
//                                transaction, the answers written by an
//                                action after each call
//   translatorFor(db, ws, lang)  the renderer's words for one language,
//                                memoised by the language's rev
//   languagesFor(db, ws, settings) → { offered, legal, state }
//   offeredLanguages(settings, legal, state)
//
// Nothing is ever translated while a visitor waits: a GET never queues a
// sweep, and a segment a page needs but doesn't have shows in English.
import { createHash } from 'node:crypto';
import { Converter } from 'opencc-js/cn2t';
import { checkProps } from '@starbase/shared/site/catalogue';
import { OTHER_CODES, LANG_BY_CODE } from '../../../shared/site/languages.js';
import { normSeg, segmentsOf, moduleSegments } from '../../../shared/site/segments.js';
import { UI_WORDS } from '../../../shared/site/ui-words.js';
import { LEGAL_ENGLISH } from '../../../shared/site/wording.js';
import { VOLUNTEER_ROLES } from '@starbase/shared/canvass';
import { newId, runAction } from '../../lib/events.js';
import { enqueueJob } from '../../lib/jobs.js';
import { prepare, readBack, translateBatch, translateKey, MAX_SEGMENTS, MAX_CHARS } from '../../lib/translate.js';
import { parseJ, readSettings } from './store.js';
import { cacheClear } from './cache.js';
import { latestLegal, keyCurrent } from './legal.js';

export const segHash = (text) => createHash('sha256').update(normSeg(text)).digest('hex');
const toTraditional = Converter({ from: 'cn', to: 'tw' });
export const convertToTraditional = (text) => toTraditional(String(text ?? ''));

// The languages Google is asked for: Punjabi, and Simplified whenever
// either Chinese is on (Traditional is made from it).
const sentLanguages = (on) => {
  const out = [];
  if (on.includes('pa')) out.push('pa');
  if (on.includes('zh-Hans') || on.includes('zh-Hant')) out.push('zh-Hans');
  return out;
};

// ── Which languages a visitor sees ──
// All of: turned on; the agent's name set (the translated "Authorized by"
// needs it); "Authorized by" approved in that language and still the code's
// English; its first essential translation done. A missing key after that
// leaves it offered (new wording stays English).
export const offeredLanguages = (settings, legal = {}, state = {}) => {
  const on = settings?.languages?.on || [];
  if (!on.length) return [];
  if (!String(settings?.org?.agentName || '').trim()) return [];
  return OTHER_CODES.filter((c) => on.includes(c) && keyCurrent(legal[c], 'authorizedBy') && state[c]?.ready_at);
};

export const languageState = async (q, workspaceId) => Object.fromEntries((await q.query(
  'select lang, ready_at, last_run_at, last_error, rev from site_language_state where workspace_id = $1', [workspaceId],
)).rows.map((r) => [r.lang, r]));

export const languagesFor = async (q, ws, settings) => {
  if (!(settings?.languages?.on || []).length) return { offered: [], legal: {}, state: {} };
  const [legal, state] = [await latestLegal(q, ws.id), await languageState(q, ws.id)];
  return { offered: offeredLanguages(settings, legal, state), legal, state };
};

// ── Names kept as written ──
export const MAX_NAMES = 300;
export const keptNames = async (q, ws, settings = null) => {
  const s = settings || await readSettings(q, ws.id);
  const out = [];
  const add = (n) => { const v = String(n ?? '').replace(/\s+/g, ' ').trim(); if (v && v.length <= 80 && !out.includes(v)) out.push(v); };
  add(s?.org?.name); add(s?.org?.shortName); add(s?.org?.agentName);
  for (const r of (await q.query('select name from microsites where workspace_id = $1 and deleted_at is null order by created_at', [ws.id])).rows) add(r.name);
  for (const r of (await q.query('select name from candidates where workspace_id = $1 and removed_at is null order by position, created_at', [ws.id])).rows) add(r.name);
  for (const r of (await q.query(
    "select published from site_pages where workspace_id = $1 and deleted_at is null and status = 'published' order by created_at", [ws.id],
  )).rows) {
    for (const m of parseJ(r.published, {})?.modules || []) {
      if (m?.kind === 'people') for (const seat of m.props?.seats || []) add(seat?.name);
      if (m?.kind === 'quote') add(m.props?.name);
    }
  }
  for (const n of s?.languages?.keep || []) add(n);
  return { names: out.slice(0, MAX_NAMES), tooMany: out.length > MAX_NAMES };
};

// ── What a visitor can see ──
// The order a cost limit or a slow day hits last: legal drafts, fixed
// words, settings and menu, home pages, other pages by menu order,
// petitions, posts newest first, shifts.
const RANK = { legal: 0, ui: 1, settings: 2, home: 3, page: 4, campaign: 5, post: 6, shift: 7 };
const YEAR_MS = 365 * 24 * 3600 * 1000;

export const liveStrings = async (q, ws, { settings = null, now = Date.now() } = {}) => {
  const s = settings || await readSettings(q, ws.id);
  const out = [];
  const seen = new Set();
  const push = (text, { kind = 'plain', cls = 'content', place, rank, essential, order = 0 }) => {
    const t = normSeg(text);
    if (!t) return;
    const h = segHash(t);
    if (seen.has(h)) return;
    seen.add(h);
    out.push({ text: t, hash: h, kind, cls, place, rank: RANK[rank], essential, order });
  };
  const field = (type, value, o) => {
    for (const t of segmentsOf(type, value)) push(t, { ...o, kind: type === 'markdown' ? 'markdown' : 'plain' });
  };

  for (const [k, v] of Object.entries(LEGAL_ENGLISH)) push(v, { cls: 'legal', place: `legal:${k}`, rank: 'legal', essential: true });
  for (const [k, v] of Object.entries(UI_WORDS)) push(v, { cls: 'ui', place: `ui:${k}`, rank: 'ui', essential: true });
  for (const r of VOLUNTEER_ROLES) push(r.label, { cls: 'ui', place: 'ui:roles', rank: 'ui', essential: true });

  // Settings: the menu, the title bar and its button, the footer, the
  // announcement, the site's search title and description.
  const st = { rank: 'settings', essential: true };
  for (const l of [...(s.nav?.menu || []), ...(s.nav?.links || []), s.nav?.cta, ...(s.footer?.links || [])]) field('text', l?.label, { ...st, place: 'settings:menu' });
  field('markdown', s.footer?.acknowledgement, { ...st, place: 'settings:footer' });
  field('markdown', s.footer?.text, { ...st, place: 'settings:footer' });
  field('text', s.footer?.logo?.alt, { ...st, place: 'settings:footer' });
  field('text', s.announcement?.text, { ...st, place: 'settings:announcement' });
  field('text', s.announcement?.linkLabel, { ...st, place: 'settings:announcement' });
  field('text', s.seo?.title, { ...st, place: 'settings:seo' });
  field('text', s.seo?.description, { ...st, place: 'settings:seo' });
  field('text', s.seo?.shareImage?.alt, { ...st, place: 'settings:seo' });
  field('text', s.org?.platformLabel, { ...st, place: 'settings:footer' });
  const theme = parseJ(s.theme, {}) || {};
  field('text', theme?.logo?.alt, { ...st, place: 'settings:logo' });

  // Every published page of the main site and of each live website.
  const pages = (await q.query(
    `select p.id, p.slug, p.published, p.nav_order from site_pages p left join microsites m on m.id = p.site_id
      where p.workspace_id = $1 and p.deleted_at is null and p.status = 'published'
        and (p.site_id is null or (m.status = 'live' and m.deleted_at is null))
      order by p.nav_order, p.created_at`, [ws.id],
  )).rows;
  pages.forEach((r, i) => {
    const p = parseJ(r.published, {}) || {};
    const o = { rank: r.slug === 'home' ? 'home' : 'page', essential: true, order: i };
    const at = (what) => `page:${r.id}:${what}`;
    field('text', p.title, { ...o, place: at('title') });
    field('text', p.description, { ...o, place: at('description') });
    field('text', p.image?.alt, { ...o, place: at('image') });
    for (const m of p.modules || []) {
      if (!m || m.hidden) continue;
      let props;
      try { props = checkProps(m.kind, m.props); } catch { props = m.props || {}; }
      for (const seg of moduleSegments(m.kind, props)) {
        push(seg.text, { ...o, kind: seg.kind, cls: seg.cls, place: at(`${m.id}:${seg.field}`) });
      }
    }
  });

  // Posts: newest first; the newest 20 are essential; older than a year
  // only with "Translate older posts" — or, title and excerpt, while the
  // news page lists them.
  const posts = (await q.query(
    `select id, title, excerpt, body, image, published_at from site_posts
      where workspace_id = $1 and deleted_at is null and status = 'published' and published_at <= now()
      order by published_at desc, created_at desc limit 2000`, [ws.id],
  )).rows;
  posts.forEach((r, i) => {
    const old = now - new Date(r.published_at).getTime() > YEAR_MS;
    const listed = i < 24;
    if (old && !s.languages?.oldPosts && !listed) return;
    const o = { rank: 'post', essential: i < 20, order: i };
    field('text', r.title, { ...o, place: `post:${r.id}:title` });
    field('text', r.excerpt, { ...o, place: `post:${r.id}:excerpt` });
    if (old && !s.languages?.oldPosts) return;
    field('markdown', r.body, { ...o, place: `post:${r.id}:body` });
    field('text', parseJ(r.image, {})?.alt, { ...o, place: `post:${r.id}:image` });
  });

  // Petitions and pledges, open and closed; the statement is checked whole.
  const camps = (await q.query(
    "select id, title, excerpt, body, statement from site_campaigns where workspace_id = $1 and deleted_at is null order by created_at desc", [ws.id],
  )).rows;
  camps.forEach((r, i) => {
    const o = { rank: 'campaign', essential: i < 20, order: i };
    field('text', r.title, { ...o, place: `campaign:${r.id}:title` });
    field('text', r.excerpt, { ...o, place: `campaign:${r.id}:excerpt` });
    field('markdown', r.body, { ...o, place: `campaign:${r.id}:body` });
    push(r.statement, { ...o, cls: 'check-first', place: `campaign:${r.id}:statement` });
  });

  // Upcoming public shifts' titles (the place words are an address).
  for (const r of (await q.query(
    'select id, title from shifts where workspace_id = $1 and deleted_at is null and public and coalesce(ends_at, starts_at) >= now() order by starts_at limit 200', [ws.id],
  )).rows) field('text', r.title, { rank: 'shift', essential: false, place: `shift:${r.id}` });

  return out.sort((a, b) => (Number(b.essential) - Number(a.essential)) || (a.rank - b.rank) || (a.order - b.order));
};

// ── The month's characters ──
const monthOf = (tz) => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Vancouver', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
  } catch { return new Date().toISOString().slice(0, 7); }
};
export const usageMonth = (settings) => monthOf(settings?.org?.timeZone || 'America/Vancouver');
// One atomic statement: the batch's characters fit under the limit, or
// nothing more is sent.
export const reserveChars = async (db, workspaceId, month, n, limit) => {
  await db.query('insert into site_translate_usage (workspace_id, month, chars) values ($1, $2, 0) on conflict do nothing', [workspaceId, month]);
  return (await db.query(
    'update site_translate_usage set chars = chars + $3 where workspace_id = $1 and month = $2 and chars + $3 <= $4 returning chars',
    [workspaceId, month, n, limit],
  )).rows.length > 0;
};

// ── The sweep ──
export const SWEEP_CLAIM_MS = 8 * 60_000;
export const SWEEP_WALL_MS = 7 * 60_000;
const claim = async (db, workspaceId, sweepId) => (await db.query(
  `insert into site_translate_runtime (workspace_id, sweep_id, sweep_until) values ($1, $2, now() + interval '8 minutes')
   on conflict (workspace_id) do update set sweep_id = $2, sweep_until = now() + interval '8 minutes'
     where site_translate_runtime.sweep_until is null or site_translate_runtime.sweep_until < now()
   returning 1`, [workspaceId, sweepId],
)).rows.length > 0;
const stillMine = async (db, workspaceId, sweepId) => (await db.query(
  'select 1 from site_translate_runtime where workspace_id = $1 and sweep_id = $2 and sweep_until > now()', [workspaceId, sweepId],
)).rows.length > 0;
const release = (db, workspaceId, sweepId) => db.query(
  'update site_translate_runtime set sweep_until = null where workspace_id = $1 and sweep_id = $2', [workspaceId, sweepId],
);
const runtime = async (db, workspaceId) => parseJ((await db.query('select probe from site_translate_runtime where workspace_id = $1', [workspaceId])).rows[0]?.probe, null) || {};

// What a segment needs: no row yet (or a machine row a newly kept name
// made stale), and not waiting on an earlier failure.
const needed = async (db, workspaceId, lang, segs, nowMs) => {
  const rows = new Map((await db.query(
    'select src_hash, origin, retranslate from site_translations where workspace_id = $1 and lang = $2', [workspaceId, lang],
  )).rows.map((r) => [r.src_hash, r]));
  const fails = new Map((await db.query(
    'select src_hash, tries, next_try_at from site_translation_failures where workspace_id = $1 and lang = $2', [workspaceId, lang],
  )).rows.map((r) => [r.src_hash, r]));
  return segs.filter((g) => {
    const r = rows.get(g.hash);
    if (r && !(r.retranslate && r.origin === 'machine')) return false;
    const f = fails.get(g.hash);
    if (f && (f.next_try_at === null || new Date(f.next_try_at).getTime() > nowMs)) return false;
    return true;
  });
};

// Batches of at most 128 segments and 25,000 characters.
const batchesOf = (items) => {
  const out = [];
  let cur = [];
  let chars = 0;
  for (const it of items) {
    const n = it.q.length;
    if (cur.length && (cur.length >= MAX_SEGMENTS || chars + n > MAX_CHARS)) { out.push(cur); cur = []; chars = 0; }
    cur.push(it);
    chars += n;
  }
  if (cur.length) out.push(cur);
  return out;
};

const RETRY_AFTER = [3600_000, 6 * 3600_000]; // after the first try, after the second; then never

// The answers of one call, written as the system: the rows that are new,
// the failures, Traditional from Simplified, the usage given back when
// Google refused, the language's rev, readiness, one event.
export const writeBatch = async (db, workspaceId, { lang = null, good = [], failed = [], chars = 0, giveBack = 0, month = null, essential = [], on = [] }) => {
  if (!good.length && !failed.length && !giveBack && !await mayBecomeReady(db, workspaceId, on)) return { written: 0, ready: [] };
  const out = await runAction(db, { workspaceId, actorId: null, action: 'site.translations.machine' }, async (tx, emit) => {
    const items = [];
    const changedHant = [];
    for (const g of good) {
      const cur = (await tx.query('select id, origin, retranslate, version_id from site_translations where workspace_id = $1 and lang = $2 and src_hash = $3', [workspaceId, lang, g.hash])).rows[0];
      const vid = newId();
      if (cur) {
        // Only a machine row a newly kept name made stale is replaced; a
        // reviewer's correction that landed meanwhile never is.
        if (!(cur.origin === 'machine' && cur.retranslate)) continue;
        await tx.query("update site_translation_versions set state = 'replaced', decided_at = now() where id = $1", [cur.version_id]);
        await tx.query(
          `insert into site_translation_versions (id, workspace_id, lang, src_hash, text, origin, state) values ($1, $2, $3, $4, $5, 'machine', 'live')`,
          [vid, workspaceId, lang, g.hash, g.text],
        );
        await tx.query(
          `update site_translations set text = $4, version_id = $5, retranslate = false, checked_by = null, checked_at = null, place = $6, updated_at = now()
            where workspace_id = $1 and lang = $2 and src_hash = $3`, [workspaceId, lang, g.hash, g.text, vid, g.place],
        );
      } else {
        const ins = await tx.query(
          `insert into site_translations (id, workspace_id, lang, src_hash, src, text, origin, version_id, place)
           values ($1, $2, $3, $4, $5, $6, 'machine', $7, $8) on conflict (workspace_id, lang, src_hash) do nothing returning id`,
          [newId(), workspaceId, lang, g.hash, g.src, g.text, vid, g.place],
        );
        if (!ins.rows.length) continue;
        await tx.query(
          `insert into site_translation_versions (id, workspace_id, lang, src_hash, text, origin, state) values ($1, $2, $3, $4, $5, 'machine', 'live')`,
          [vid, workspaceId, lang, g.hash, g.text],
        );
      }
      await tx.query('delete from site_translation_failures where workspace_id = $1 and lang = $2 and src_hash = $3', [workspaceId, lang, g.hash]);
      items.push({ src_hash: g.hash, text: g.text });
      if (lang === 'zh-Hans') changedHant.push(g);
    }
    for (const g of changedHant) await convertRow(tx, workspaceId, g.hash, g.src, g.text, g.place);
    for (const f of failed) {
      const was = (await tx.query('select tries from site_translation_failures where workspace_id = $1 and lang = $2 and src_hash = $3', [workspaceId, lang, f.hash])).rows[0];
      const tries = (was?.tries || 0) + 1;
      const wait = RETRY_AFTER[tries - 1];
      await tx.query(
        `insert into site_translation_failures (workspace_id, lang, src_hash, tries, last_reason, next_try_at)
         values ($1, $2, $3, $4, $5, $6) on conflict (workspace_id, lang, src_hash) do update set tries = $4, last_reason = $5, next_try_at = $6`,
        [workspaceId, lang, f.hash, tries, f.reason, wait ? new Date(Date.now() + wait) : null],
      );
    }
    if (giveBack && month) await tx.query('update site_translate_usage set chars = greatest(0, chars - $3) where workspace_id = $1 and month = $2', [workspaceId, month, giveBack]);
    const langs = !lang || (!items.length && !failed.length) ? [] : changedHant.length ? [lang, 'zh-Hant'] : [lang];
    for (const l of langs) await bumpRev(tx, workspaceId, l, { lastError: null });
    const ready = await markReady(tx, workspaceId, on, essential);
    if (items.length || failed.length) {
      emit('site_translation_batch', newId(), 'create', {
        lang, count: items.length, chars, failed: failed.map((f) => ({ src_hash: f.hash, reason: f.reason })), items,
      });
    }
    return { written: items.length, ready };
  });
  cacheClear(workspaceId);
  return out;
};

const mayBecomeReady = async (q, workspaceId, on) => {
  if (!on.length) return false;
  const ready = (await q.query('select lang from site_language_state where workspace_id = $1 and ready_at is not null', [workspaceId])).rows.map((r) => r.lang);
  return on.some((l) => !ready.includes(l));
};

export const bumpRev = (tx, workspaceId, lang, { lastError } = {}) => tx.query(
  `insert into site_language_state (workspace_id, lang, rev, last_run_at, last_error) values ($1, $2, 1, now(), $3)
   on conflict (workspace_id, lang) do update set rev = site_language_state.rev + 1, last_run_at = now()${lastError === undefined ? '' : ', last_error = $3'}`,
  [workspaceId, lang, lastError ?? null],
);

// Traditional from Simplified (decision 18): a pure conversion, inside the
// write. A row a person edited in Traditional is never replaced; it goes
// back under "To check".
export const convertRow = async (tx, workspaceId, hash, src, simplified, place) => {
  const text = convertToTraditional(simplified);
  const cur = (await tx.query("select id, origin, version_id, text from site_translations where workspace_id = $1 and lang = 'zh-Hant' and src_hash = $2", [workspaceId, hash])).rows[0];
  if (cur?.origin === 'edited') {
    await tx.query("update site_translations set checked_by = null, checked_at = null, updated_at = now() where id = $1", [cur.id]);
    return;
  }
  if (cur && cur.text === text) return;
  const vid = newId();
  if (cur) await tx.query("update site_translation_versions set state = 'replaced', decided_at = now() where id = $1", [cur.version_id]);
  await tx.query(
    `insert into site_translation_versions (id, workspace_id, lang, src_hash, text, origin, state) values ($1, $2, 'zh-Hant', $3, $4, 'converted', 'live')`,
    [vid, workspaceId, hash, text],
  );
  await tx.query(
    `insert into site_translations (id, workspace_id, lang, src_hash, src, text, origin, version_id, place)
     values ($1, $2, 'zh-Hant', $3, $4, $5, 'converted', $6, $7)
     on conflict (workspace_id, lang, src_hash) do update set text = $5, origin = 'converted', version_id = $6, checked_by = null, checked_at = null, updated_at = now()`,
    [newId(), workspaceId, hash, src, text, vid, place],
  );
};

// A language that is on becomes ready once every essential segment has a
// row or has used up its tries (Traditional: once Simplified's have).
const markReady = async (tx, workspaceId, on, essential) => {
  const now = [];
  if (!essential.length) return now;
  for (const lang of on) {
    const st = (await tx.query('select ready_at from site_language_state where workspace_id = $1 and lang = $2', [workspaceId, lang])).rows[0];
    if (st?.ready_at) continue;
    const missing = (await tx.query(
      `select count(*)::int as n from unnest($3::text[]) h
        where not exists (select 1 from site_translations t where t.workspace_id = $1 and t.lang = $2 and t.src_hash = h)
          and not exists (select 1 from site_translation_failures f where f.workspace_id = $1 and f.lang = $4 and f.src_hash = h and f.next_try_at is null)`,
      [workspaceId, lang, essential, lang === 'zh-Hant' ? 'zh-Hans' : lang],
    )).rows[0].n;
    if (missing) continue;
    await tx.query(
      `insert into site_language_state (workspace_id, lang, ready_at, rev) values ($1, $2, now(), 1)
       on conflict (workspace_id, lang) do update set ready_at = now(), rev = site_language_state.rev + 1`, [workspaceId, lang],
    );
    now.push(lang);
  }
  return now;
};

const setError = async (db, workspaceId, langs, words) => {
  for (const l of langs) {
    await db.query(
      `insert into site_language_state (workspace_id, lang, last_error, last_run_at) values ($1, $2, $3, now())
       on conflict (workspace_id, lang) do update set last_error = $3, last_run_at = now()`, [workspaceId, l, words],
    );
  }
};

// One sweep: claimed first (one per campaign), then run. clock: for tests
// (the wall-time rule).
export const claimSweep = async (db, workspaceId) => {
  const sweepId = newId();
  return await claim(db, workspaceId, sweepId) ? sweepId : null;
};
export const sweep = async (db, workspaceId, opts = {}) => {
  const sweepId = await claimSweep(db, workspaceId);
  if (!sweepId) return { again: 30_000 };
  return runSweep(db, workspaceId, sweepId, opts);
};
export const runSweep = async (db, workspaceId, sweepId, { clock = Date.now } = {}) => {
  const started = clock();
  try {
    const ws = (await db.query('select id, name, settings from workspaces where id = $1', [workspaceId])).rows[0];
    const settings = ws ? await readSettings(db, workspaceId) : null;
    const on = settings?.languages?.on || [];
    if (!ws || !on.length) return { done: true, calls: 0 };
    const segs = await liveStrings(db, ws, { settings });
    const essential = segs.filter((g) => g.essential).map((g) => g.hash);
    const key = translateKey();
    // Without the key nothing is sent; what is already there may still make
    // a language ready (Traditional turned on after Simplified, say).
    if (!key) { await writeBatch(db, workspaceId, { essential, on }); return { done: true, calls: 0 }; }
    const probe = await runtime(db, workspaceId);
    let keyIn = probe.keyIn === 'body' ? 'body' : 'header';
    const nameMethod = probe.namesKept === true ? 'span' : 'placeholder';
    const { names } = await keptNames(db, ws, settings);
    const month = usageMonth(settings);
    const limit = settings.languages.monthlyChars;
    const langs = sentLanguages(on);
    // Punjabi's essential set, then Simplified's, then the rest of each.
    const order = [];
    for (const lang of langs) order.push([lang, segs.filter((g) => g.essential)]);
    for (const lang of langs) order.push([lang, segs.filter((g) => !g.essential)]);
    let calls = 0;
    for (const [lang, list] of order) {
      const todo = await needed(db, workspaceId, lang, list, Date.now());
      const prepared = todo.map((g) => ({ ...g, ...prepare(g.text, { kind: g.kind, names, nameMethod, slots: g.cls === 'ui' || g.cls === 'legal' }) }));
      for (const batch of batchesOf(prepared)) {
        if (clock() - started >= SWEEP_WALL_MS) return { done: true, calls, stopped: 'time' };
        if (!await stillMine(db, workspaceId, sweepId)) return { done: true, calls, stopped: 'claim' };
        const n = batch.reduce((a, b) => a + b.q.length, 0);
        if (!await reserveChars(db, workspaceId, month, n, limit)) {
          await setError(db, workspaceId, [lang], 'monthly-limit');
          await writeBatch(db, workspaceId, { essential, on });
          return { done: true, calls, stopped: 'limit' };
        }
        let r;
        try {
          calls += 1;
          r = await translateBatch({ target: LANG_BY_CODE[lang].google, q: batch.map((b) => b.q), keyIn, key });
        } catch (e) {
          // Refused or busy: Google answered and billed nothing, so the
          // reservation goes back. A timeout's stands (it may have billed).
          if (!e.timeout) await db.query('update site_translate_usage set chars = greatest(0, chars - $3) where workspace_id = $1 and month = $2', [workspaceId, month, n]);
          await setError(db, workspaceId, [lang], e.message);
          if (e.busy) return { again: 60_000, calls };
          throw e;
        }
        if (r.keyIn !== keyIn) {
          keyIn = r.keyIn;
          await db.query(
            `insert into site_translate_runtime (workspace_id, probe) values ($1, $2)
             on conflict (workspace_id) do update set probe = coalesce(site_translate_runtime.probe, '{}'::jsonb) || $2::jsonb`,
            [workspaceId, JSON.stringify({ keyIn })],
          );
        }
        const good = [];
        const failed = [];
        batch.forEach((b, i) => {
          const back = readBack(r.texts[i], b.held);
          if (back.error) failed.push({ hash: b.hash, reason: back.error });
          else good.push({ hash: b.hash, src: b.text, text: back.text, place: b.place });
        });
        await writeBatch(db, workspaceId, { lang, good, failed, chars: r.chars, essential, on });
      }
    }
    await writeBatch(db, workspaceId, { essential, on });
    return { done: true, calls };
  } finally {
    await release(db, workspaceId, sweepId);
  }
};

// The job: claimed now (another sweep holding the claim hands the job back,
// no try counted), the slow work handed back so other jobs aren't held up.
// Google busy (429, 5xx): a fresh sweep a minute later.
export const translateJob = async (db, job) => {
  const sweepId = await claimSweep(db, job.workspace_id);
  if (!sweepId) return { again: 30_000 };
  return {
    later: runSweep(db, job.workspace_id, sweepId).then(async (out) => {
      if (out?.again) await queueSweep(db, job.workspace_id, { inMs: out.again });
    }),
  };
};

// A sweep at the next 30-second boundary (one per window).
export const queueSweep = async (q, workspaceId, { inMs = 0 } = {}) => {
  const at = new Date(Math.ceil((Date.now() + inMs) / 30_000) * 30_000);
  return enqueueJob(q, { workspaceId, kind: 'site.translate', runAt: at.toISOString(), key: `translate:${at.toISOString()}` });
};

// The write hook: a publish (or a settings, post, petition, website, shift
// or candidate write) queues a sweep when a language is on and the key is set.
const TRANSLATED_TYPES = new Set(['site_post', 'site_campaign', 'site_settings', 'microsite', 'shift', 'candidate']);
const PAGE_ACTIONS = new Set(['site.page.publish', 'site.page.restore', 'site.microsite.live']);
export const translationEvents = (meta, events) => events.filter((e) => TRANSLATED_TYPES.has(e.entityType)
  || (e.entityType === 'site_page' && PAGE_ACTIONS.has(meta.action)));
export const queueFromHook = async (tx, meta, events) => {
  if (!translateKey()) return;
  const evs = translationEvents(meta, events);
  if (!evs.length) return;
  const on = parseJ((await tx.query('select languages from site_settings where workspace_id = $1', [meta.workspaceId])).rows[0]?.languages, {})?.on;
  if (!Array.isArray(on) || !on.length) return;
  // A candidate added or renamed: machine rows holding the name are made again.
  const names = evs.filter((e) => e.entityType === 'candidate' && e.payload?.name).map((e) => e.payload.name);
  if (names.length) await markRetranslate(tx, meta.workspaceId, names);
  await queueSweep(tx, meta.workspaceId);
};

// A name kept from now on: machine rows that hold it are translated again
// (the next sweep replaces them); a person's rows go back under To check.
export const markRetranslate = async (tx, workspaceId, names) => {
  for (const n of names) {
    const name = String(n ?? '').trim();
    if (!name) continue;
    const like = `%${name.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    await tx.query("update site_translations set retranslate = true where workspace_id = $1 and origin = 'machine' and src like $2", [workspaceId, like]);
    await tx.query("update site_translations set checked_by = null, checked_at = null where workspace_id = $1 and origin = 'edited' and src like $2", [workspaceId, like]);
  }
};

// ── The renderer's words ──
// Per campaign and language: the map src_hash → { text, checked, v }, kept
// until the language's rev moves (every write to its words bumps it). A page
// miss reads only that rev.
const MEMO = new Map();
export const memoSize = () => MEMO.size;
export const translatorFor = async (q, workspaceId, lang) => {
  const st = (await q.query('select rev from site_language_state where workspace_id = $1 and lang = $2', [workspaceId, lang])).rows[0];
  const rev = String(st?.rev ?? '0');
  const k = `${workspaceId}|${lang}`;
  let hit = MEMO.get(k);
  if (!hit || hit.rev !== rev) {
    const map = new Map((await q.query(
      'select src_hash, text, checked_at, version_id from site_translations where workspace_id = $1 and lang = $2', [workspaceId, lang],
    )).rows.map((r) => [r.src_hash, { text: r.text, checked: Boolean(r.checked_at), v: r.version_id }]));
    if (MEMO.size > 200) MEMO.clear();
    hit = { rev, map };
    MEMO.set(k, hit);
  }
  const { map } = hit;
  return {
    lang,
    // english → { text, lang, v }: the translation, or the English (lang 'en').
    look: (english, { check = false } = {}) => {
      const src = normSeg(english);
      const h = segHash(src);
      const r = src ? map.get(h) : null;
      if (r && (!check || r.checked)) return { text: r.text, lang, v: r.v, hash: h };
      return { text: String(english ?? ''), lang: 'en', v: `en:${h}`, hash: h };
    },
  };
};
