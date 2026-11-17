// The Languages screen's reads (TR decision 42), mounted on api.js's /site.
// Website translations' (site_words): anyone with the Website has it too.
// Counts, words, and the names of the desk's own people — never voters.
//
//   GET /site/languages                 each language: on, offered, ready,
//                                       its legal words' state, its counts,
//                                       its last trouble; the month's
//                                       characters; the kept and possible names
//   GET /site/languages/:code/estimate  the characters its first translation
//                                       (and everything) would send
//   GET /site/languages/:code/sentences ?filter=check|suggested|edited|failed|all&q=&after=
//                                       50 sentences at a time
//   GET /site/languages/:code/edits     ?after= the last 50 edits by people
//   GET /site/languages/:code/legal     the English, the draft, the approved
//                                       words, the stale keys, the names
//   GET /site/languages/:code/preview   a half-hour link to the home page's
//                                       draft in a language that is on
import { LEGAL_ENGLISH, LEGAL_KEYS, fillSlots } from '../../../shared/site/wording.js';
import { LANG_BY_CODE, OTHER_CODES } from '../../../shared/site/languages.js';
import { MODULE_BY_KIND } from '../../../shared/site/catalogue.js';
import { prepare, translateKey } from '../../lib/translate.js';
import { here } from '../../lib/mount.js';
import { areasFor } from '../../lib/perms.js';
import { sign, PREVIEW_TTL } from './tokens.js';
import { readSettings, parseJ } from './store.js';
import { latestLegal, staleKeys, legalSlots } from './legal.js';
import { liveStrings, languageState, offeredLanguages, keptNames, usageMonth, segHash, convertToTraditional, MAX_NAMES } from './translate.js';

const iso = (d) => (d instanceof Date ? d.toISOString() : d ? new Date(d).toISOString() : null);
const PAGE = 50;
// Where a sentence is, in the desk's words.
const SETTING_PLACES = { menu: 'Menu', footer: 'Footer', announcement: 'Announcement', seo: 'Search and sharing', social: 'Social links', logo: 'Logo' };
// The legal keys in the order the legal screen shows them, with their names.
export const LEGAL_LABELS = {
  authorizedBy: 'Authorized by', email: 'Email consent', sms: 'Text consent', newsletter: 'Newsletter',
  privacy: 'Privacy line', donate: 'Donation declaration', join: 'Membership declaration',
  donateSmall: 'Donation small print', donateSmallNoLimit: 'Donation small print (no limit)', payPageNote: 'Payment page note',
  translatedNote: 'Translated note', readInEnglish: 'Read it in English link', policyInEnglish: 'Privacy policy in English',
};

// How soon a sentence comes in the list (lower first).
const weightOf = (g) => {
  const kind = String(g.place || '').split(':')[0];
  if (kind === 'ui') return 3;
  if (kind === 'settings' || kind === 'shift') return 2;
  return g.cls === 'check-first' ? 0 : 1;
};

// The segments a person can see and correct (the legal drafts have their
// own screen), with the words to say where each is.
const sentencesOf = async (db, ws, settings) => {
  const segs = (await liveStrings(db, ws, { settings })).filter((g) => g.cls !== 'legal');
  const pages = new Map((await db.query(
    `select p.id, p.slug, coalesce(nullif(p.published->>'title', ''), p.title) as title, p.published, m.name as site
       from site_pages p left join microsites m on m.id = p.site_id where p.workspace_id = $1 and p.deleted_at is null`, [ws.id],
  )).rows.map((r) => [r.id, r]));
  const titled = async (table, ids) => (ids.length ? new Map((await db.query(`select id, title from ${table} where workspace_id = $1 and id = any($2::uuid[])`, [ws.id, ids])).rows.map((r) => [r.id, r.title])) : new Map());
  const idsOf = (pre) => [...new Set(segs.filter((g) => g.place?.startsWith(`${pre}:`)).map((g) => g.place.split(':')[1]))];
  const posts = await titled('site_posts', idsOf('post'));
  const camps = await titled('site_campaigns', idsOf('campaign'));
  const label = (place) => {
    const [kind, id, mod] = String(place || '').split(':');
    if (kind === 'ui') return 'Fixed words';
    if (kind === 'settings') return SETTING_PLACES[id] || 'Settings';
    if (kind === 'post') return `News · ${posts.get(id) || 'a post'}`;
    if (kind === 'campaign') return `${mod === 'statement' ? 'Statement' : 'Petition'} · ${camps.get(id) || 'a petition'}`;
    if (kind === 'shift') return 'Shifts';
    if (kind === 'page') {
      const p = pages.get(id);
      if (!p) return 'A page';
      const m = (parseJ(p.published, {})?.modules || []).find((x) => x?.id === mod);
      const where = m ? MODULE_BY_KIND[m.kind]?.label || 'Module' : { title: 'Title', description: 'Description', image: 'Picture' }[mod] || '';
      return [p.site, p.title, where].filter(Boolean).join(' · ');
    }
    return 'Website';
  };
  return segs.map((g) => ({ ...g, place_label: label(g.place) }));
};

const namesOf = async (db, ids) => {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  return new Map((await db.query('select id, name from users where id = any($1::uuid[])', [list])).rows.map((r) => [r.id, r.name]));
};

// Per language, over today's sentences: how many are live in it, waiting,
// made by the machine, converted, edited, checked, suggested, failed.
const countsFor = async (db, wsId, lang, hashes) => {
  const rows = (await db.query(
    `select origin, (checked_at is not null) as checked, count(*)::int as n from site_translations
      where workspace_id = $1 and lang = $2 and src_hash = any($3::text[]) group by 1, 2`, [wsId, lang, hashes],
  )).rows;
  const sum = (f) => rows.filter(f).reduce((a, r) => a + r.n, 0);
  const have = sum(() => true);
  const failed = (await db.query(
    `select count(*)::int as n from site_translation_failures f where f.workspace_id = $1 and f.lang = $2 and f.src_hash = any($3::text[])
       and not exists (select 1 from site_translations t where t.workspace_id = f.workspace_id and t.lang = $4 and t.src_hash = f.src_hash)`,
    [wsId, lang === 'zh-Hant' ? 'zh-Hans' : lang, hashes, lang],
  )).rows[0].n;
  const suggested = (await db.query(
    "select count(distinct src_hash)::int as n from site_translation_versions where workspace_id = $1 and lang = $2 and state = 'suggested' and src_hash = any($3::text[])",
    [wsId, lang, hashes],
  )).rows[0].n;
  return {
    live: hashes.length, waiting: Math.max(0, hashes.length - have - failed),
    machine: sum((r) => r.origin === 'machine'), converted: sum((r) => r.origin === 'converted'), edited: sum((r) => r.origin === 'edited'),
    checked: sum((r) => r.checked), suggested, failed,
  };
};

// Runs of two or three capitalised words inside a sentence (not at its
// start) that aren't kept: a hint for opponents and places (decision 12).
const possibleNames = (segs, kept) => {
  const keptSet = new Set(kept.map((n) => n.toLowerCase()));
  const seen = new Map();
  for (const g of segs) {
    if (g.cls === 'ui') continue;
    const text = g.text.replace(/<[^>]+>/g, ' ');
    for (const m of text.matchAll(/(?<=[\p{L}\p{N},;:] )(\p{Lu}[\p{L}’'-]*\p{Ll}(?: \p{Lu}[\p{L}’'-]*\p{Ll}){1,2})(?![\p{L}\p{N}-])/gu)) {
      const n = m[1];
      if (keptSet.has(n.toLowerCase()) || [...keptSet].some((k) => k.includes(n.toLowerCase()))) continue;
      seen.set(n, (seen.get(n) || 0) + 1);
    }
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([n]) => n);
};

const codeOf = (c) => {
  const code = c.req.param('code');
  return OTHER_CODES.includes(code) ? code : null;
};

export const mountLanguageReads = (api, opened) => {
  api.get('/site/languages', async (c) => {
    const wsId = await opened(c);
    const db = c.get('db');
    const ws = c.get('ctx').workspace;
    const settings = await readSettings(db, wsId);
    const lg = settings.languages;
    const [legal, state] = [await latestLegal(db, wsId), await languageState(db, wsId)];
    const offered = offeredLanguages(settings, legal, state);
    const segs = await sentencesOf(db, { ...ws, id: wsId }, settings);
    const hashes = segs.map((g) => g.hash);
    const approvers = await namesOf(db, Object.values(legal).map((r) => r.approved_by));
    const languages = [];
    for (const code of OTHER_CODES) {
      const row = legal[code];
      const stale = staleKeys(row);
      languages.push({
        code, label: LANG_BY_CODE[code].label, name: LANG_BY_CODE[code].name,
        on: lg.on.includes(code), offered: offered.includes(code), index: Boolean(lg.index?.[code]),
        ready_at: iso(state[code]?.ready_at),
        legal: {
          state: !row ? 'missing' : stale.length ? 'stale' : 'approved',
          approved_at: iso(row?.approved_at), approved_by_name: approvers.get(row?.approved_by) || null,
          stale_keys: row ? stale : [],
          stale_labels: row ? stale.map((k) => LEGAL_LABELS[k] || k) : [],
        },
        counts: lg.on.includes(code) || state[code] ? await countsFor(db, wsId, code, hashes) : null,
        last_error: state[code]?.last_error || null,
      });
    }
    const month = usageMonth(settings);
    const used = (await db.query('select chars from site_translate_usage where workspace_id = $1 and month = $2', [wsId, month])).rows[0];
    const kept = await keptNames(db, { ...ws, id: wsId }, settings);
    return c.json({
      key: Boolean(translateKey()),
      // The site's own address, for Preview (/site/pa/).
      site: here(c, '/site'),
      agent: Boolean(String(settings.org?.agentName || '').trim()),
      settings: lg,
      languages,
      usage: { month, chars: Number(used?.chars || 0), limit: lg.monthlyChars },
      names: { kept: kept.names, typed: lg.keep, too_many: kept.tooMany, max: MAX_NAMES, possible: possibleNames(segs, kept.names) },
    });
  });

  // What turning a language on would send (decision 19): every segment with
  // no row yet, prepared as the sweep prepares it.
  api.get('/site/languages/:code/estimate', async (c) => {
    const code = codeOf(c);
    if (!code) return c.json({ error: 'No such language' }, 404);
    const wsId = await opened(c);
    const db = c.get('db');
    const ws = { ...c.get('ctx').workspace, id: wsId };
    const settings = await readSettings(db, wsId);
    const month = usageMonth(settings);
    const used = Number((await db.query('select chars from site_translate_usage where workspace_id = $1 and month = $2', [wsId, month])).rows[0]?.chars || 0);
    const usage = { month, chars: used, limit: settings.languages.monthlyChars };
    if (!LANG_BY_CODE[code].google) return c.json({ code, converted: true, essential: 0, all: 0, usage });
    const segs = await liveStrings(db, ws, { settings });
    const have = new Set((await db.query('select src_hash from site_translations where workspace_id = $1 and lang = $2', [wsId, code])).rows.map((r) => r.src_hash));
    const failed = new Set((await db.query('select src_hash from site_translation_failures where workspace_id = $1 and lang = $2', [wsId, code])).rows.map((r) => r.src_hash));
    const { names } = await keptNames(db, ws, settings);
    const probe = parseJ((await db.query('select probe from site_translate_runtime where workspace_id = $1', [wsId])).rows[0]?.probe, null) || {};
    const nameMethod = probe.namesKept === true ? 'span' : 'placeholder';
    let essential = 0; let all = 0;
    for (const g of segs) {
      if (have.has(g.hash) || failed.has(g.hash)) continue;
      const n = prepare(g.text, { kind: g.kind, names, nameMethod, slots: g.cls === 'ui' || g.cls === 'legal' }).q.length;
      all += n;
      if (g.essential) essential += n;
    }
    return c.json({ code, converted: false, essential, all, usage });
  });

  // Preview (decision 35): the home page in that language, so a reviewer
  // sees the words in place before visitors are offered it.
  api.get('/site/languages/:code/preview', async (c) => {
    const code = codeOf(c);
    if (!code) return c.json({ error: 'No such language' }, 404);
    const wsId = await opened(c);
    const db = c.get('db');
    if (!(await readSettings(db, wsId)).languages.on.includes(code)) return c.json({ error: 'Turn it on first' }, 409);
    const home = (await db.query("select id, published from site_pages where workspace_id = $1 and site_id is null and slug = 'home' and deleted_at is null", [wsId])).rows[0];
    if (!home) return c.json({ error: 'The website has no home page yet' }, 404);
    // A draft is the Website's: someone with only translations sees the
    // published page (claim 'live'), never words not yet made public.
    const live = !areasFor(c.get('ctx')).includes('site');
    if (live && !home.published) return c.json({ error: 'The home page isn’t published yet' }, 409);
    const t = await sign('preview', { w: wsId, p: home.id, ...(live ? { live: true } : {}) }, PREVIEW_TTL);
    return c.json({ url: here(c, `/site/__preview/${home.id}?t=${encodeURIComponent(t)}&lang=${encodeURIComponent(code)}`) });
  });

  api.get('/site/languages/:code/sentences', async (c) => {
    const code = codeOf(c);
    if (!code) return c.json({ error: 'No such language' }, 404);
    const wsId = await opened(c);
    const db = c.get('db');
    const settings = await readSettings(db, wsId);
    const filter = ['check', 'suggested', 'edited', 'failed', 'all'].includes(c.req.query('filter')) ? c.req.query('filter') : 'check';
    const q = String(c.req.query('q') || '').trim().toLowerCase().slice(0, 100);
    const after = Math.max(0, Number.parseInt(c.req.query('after') || '0', 10) || 0);
    const segs = await sentencesOf(db, { ...c.get('ctx').workspace, id: wsId }, settings);
    const hashes = segs.map((g) => g.hash);
    const rows = new Map((await db.query(
      `select t.src_hash, t.text, t.origin, t.checked_at, t.checked_by, t.needs_check, v.made_by from site_translations t
         left join site_translation_versions v on v.id = t.version_id
        where t.workspace_id = $1 and t.lang = $2 and t.src_hash = any($3::text[])`, [wsId, code, hashes],
    )).rows.map((r) => [r.src_hash, r]));
    const suggestions = new Map();
    for (const r of (await db.query(
      `select id, src_hash, text, made_by, made_at from site_translation_versions
        where workspace_id = $1 and lang = $2 and state = 'suggested' and src_hash = any($3::text[]) order by made_at`, [wsId, code, hashes],
    )).rows) suggestions.set(r.src_hash, r);
    const fails = new Map((await db.query(
      'select src_hash, tries, last_reason from site_translation_failures where workspace_id = $1 and lang = $2 and src_hash = any($3::text[])',
      [wsId, code === 'zh-Hant' ? 'zh-Hans' : code, hashes],
    )).rows.map((r) => [r.src_hash, r]));
    const keep = (g) => {
      const r = rows.get(g.hash);
      if (q && !g.text.toLowerCase().includes(q) && !String(r?.text || '').toLowerCase().includes(q)) return false;
      // A person's words come back here only when what they stood on moved.
      if (filter === 'check') return r && !r.checked_at && (r.origin !== 'edited' || r.needs_check);
      if (filter === 'suggested') return suggestions.has(g.hash);
      if (filter === 'edited') return r?.origin === 'edited';
      if (filter === 'failed') return !r && fails.has(g.hash);
      return true;
    };
    // The site's own words first (pages, news, petitions), then menus,
    // footer and shifts, then the fixed words every site shares: a checker
    // starts with what readers read most. Stable, so each group keeps its order.
    const list = segs.filter(keep).sort((a, b) => weightOf(a) - weightOf(b));
    const pageOf = list.slice(after, after + PAGE);
    const who = await namesOf(db, pageOf.flatMap((g) => [rows.get(g.hash)?.checked_by, suggestions.get(g.hash)?.made_by]));
    // "Earlier wording": a person's words for the English that was at the
    // same place before it changed.
    const places = [...new Set(pageOf.map((g) => g.place).filter(Boolean))];
    const earlier = new Map();
    if (places.length) {
      for (const r of (await db.query(
        `select distinct on (place) place, src_hash, text from site_translations
          where workspace_id = $1 and lang = $2 and origin = 'edited' and place = any($3::text[]) order by place, updated_at desc`, [wsId, code, places],
      )).rows) earlier.set(r.place, r);
    }
    const me = c.get('ctx').user.id;
    return c.json({
      filter,
      total: list.length,
      next: after + PAGE < list.length ? after + PAGE : null,
      counts: { failed: segs.filter((g) => !rows.get(g.hash) && fails.has(g.hash)).length },
      sentences: pageOf.map((g) => {
        const r = rows.get(g.hash);
        const s = suggestions.get(g.hash);
        const f = !r && fails.get(g.hash);
        const e = earlier.get(g.place);
        return {
          src_hash: g.hash, src: g.text, kind: g.kind, check_first: g.cls === 'check-first',
          text: r?.text ?? null, origin: r?.origin ?? null,
          checked_at: iso(r?.checked_at), checked_by_name: who.get(r?.checked_by) || null,
          mine: Boolean(r && r.made_by === me),
          place_label: g.place_label,
          earlier: e && e.src_hash !== g.hash && (!r || r.origin !== 'edited') ? e.text : null,
          suggestion: s ? { id: s.id, text: s.text, by_name: who.get(s.made_by) || null, at: iso(s.made_at), mine: s.made_by === me } : null,
          failure: f ? { tries: f.tries, reason: f.last_reason } : null,
        };
      }),
    });
  });

  api.get('/site/languages/:code/edits', async (c) => {
    const code = codeOf(c);
    if (!code) return c.json({ error: 'No such language' }, 404);
    const wsId = await opened(c);
    const db = c.get('db');
    const after = Math.max(0, Number.parseInt(c.req.query('after') || '0', 10) || 0);
    const rows = (await db.query(
      `select v.id, v.src_hash, v.text, v.made_by, v.made_at, v.state, t.src, t.version_id as live_id,
              (select b.text from site_translation_versions b where b.workspace_id = v.workspace_id and b.lang = v.lang and b.src_hash = v.src_hash
                  and b.made_at < v.made_at and b.state in ('live', 'replaced') order by b.made_at desc limit 1) as before
         from site_translation_versions v left join site_translations t on t.workspace_id = v.workspace_id and t.lang = v.lang and t.src_hash = v.src_hash
        where v.workspace_id = $1 and v.lang = $2 and v.made_by is not null
        order by v.made_at desc, v.id limit $3 offset $4`, [wsId, code, PAGE + 1, after],
    )).rows;
    const who = await namesOf(db, rows.map((r) => r.made_by));
    return c.json({
      next: rows.length > PAGE ? after + PAGE : null,
      edits: rows.slice(0, PAGE).map((r) => ({
        id: r.id, src: r.src || null, text: r.text, before: r.before ?? null, by_name: who.get(r.made_by) || null,
        at: iso(r.made_at), state: r.state, live: r.live_id === r.id,
      })),
    });
  });

  api.get('/site/languages/:code/legal', async (c) => {
    const code = codeOf(c);
    if (!code) return c.json({ error: 'No such language' }, 404);
    const wsId = await opened(c);
    const db = c.get('db');
    const ws = { ...c.get('ctx').workspace, id: wsId };
    const settings = await readSettings(db, wsId);
    const legal = await latestLegal(db, wsId);
    const row = legal[code] || null;
    const slots = legalSlots(settings);
    // The draft (decision 14): the machine's for Punjabi and Simplified;
    // the approved Simplified converted for Traditional.
    let draft = {}; let from = null;
    if (code === 'zh-Hant' && legal['zh-Hans']) {
      draft = Object.fromEntries(LEGAL_KEYS.map((k) => [k, convertToTraditional(legal['zh-Hans'].words[k] || '')]));
      from = 'converted';
    } else {
      const byHash = new Map((await db.query(
        'select src_hash, text from site_translations where workspace_id = $1 and lang = $2 and src_hash = any($3::text[])',
        [wsId, code, LEGAL_KEYS.map((k) => segHash(LEGAL_ENGLISH[k]))],
      )).rows.map((r) => [r.src_hash, r.text]));
      draft = Object.fromEntries(LEGAL_KEYS.map((k) => [k, byHash.get(segHash(LEGAL_ENGLISH[k])) || '']));
      if (Object.values(draft).some(Boolean)) from = code === 'zh-Hant' ? 'converted' : 'machine';
    }
    const kept = await keptNames(db, ws, settings);
    const by = row ? (await namesOf(db, [row.approved_by])).get(row.approved_by) : null;
    return c.json({
      code, label: LANG_BY_CODE[code].label,
      keys: LEGAL_KEYS.map((k) => ({ key: k, label: LEGAL_LABELS[k] || k, template: LEGAL_ENGLISH[k], english: fillSlots(LEGAL_ENGLISH[k], slots) })),
      draft, draft_from: from,
      approved: row ? { words: row.words, at: iso(row.approved_at), by_name: by || null } : null,
      stale_keys: row ? staleKeys(row) : [],
      names: { kept: kept.names, approved: row?.words?.names || {} },
    });
  });
};
