// The website's languages, the actions of stage 1 (TR): a manager approves
// the words the law needs in a language, and anyone with the Website area
// can ask for the translation sweep now. (The Languages screen's sentence
// actions come with the screen.)
//
//   site.legal.approve  { lang, words }  manager only: every key, each with
//                       exactly its English's slots; names only for kept
//                       names. Stored insert-only (site_legal_words) with the
//                       English it answers; the language's pages clear.
//   site.translate.now  {}  a sweep queued now
//
// The Languages screen's (decisions 41 and 43; the 'site_words' area,
// Website translations — whoever has the Website has it too):
//   site.translation.save    { lang, src_hash, text }  live at once for
//                            someone with the Website (unchecked); a
//                            suggestion for someone with only translations
//   site.translation.approve { lang, version_id }  a suggestion goes live,
//                            checked by the one who approved it
//   site.translation.decline { lang, version_id }
//   site.translation.check   { lang, src_hashes }  "Looks right"
//   site.translation.undo    { lang, version_id }  (the Website's) the words
//                            before an edit, live again
//   site.names.keep          { name, keep }  a name kept as written, or not
// Nobody checks their own words; a petition's statement goes live
// translated only once two people, one a manager, have handled it.
import { z } from 'zod';
import { LEGAL_ENGLISH, LEGAL_KEYS, slotsOf } from '../../../shared/site/wording.js';
import { OTHER_CODES } from '../../../shared/site/languages.js';
import { newId } from '../../lib/events.js';
import { httpError } from '../../actions/util.js';
import { areasFor } from '../../lib/perms.js';
import { keptNames, queueSweep, bumpRev, liveStrings, convertRow, markRetranslate } from './translate.js';
import { parseJ } from './store.js';
import { sectionOf } from './shape.js';

export const legalProblem = (words, kept) => {
  for (const k of LEGAL_KEYS) {
    const v = String(words?.[k] ?? '').trim();
    if (!v) return `Fill in every line (${k} is empty)`;
    if (v.length > 1000) return `${k} is too long — 1,000 characters at most`;
    const want = slotsOf(LEGAL_ENGLISH[k]);
    const got = slotsOf(v);
    if (want.join() !== got.join()) return `Keep ${want.map((x) => `{${x}}`).join(' and ') || 'no slots'} in the line (${k})`;
  }
  const names = words?.names;
  if (names !== undefined && names !== null) {
    if (typeof names !== 'object' || Array.isArray(names)) return 'Names: a list of names and how readers see them';
    const list = Object.entries(names).filter(([, r]) => String(r ?? '').trim());
    if (list.length > 300) return 'At most 300 names';
    for (const [n, r] of list) {
      if (String(r).trim().length > 60) return `How readers see ${n}: 60 characters at most`;
      if (!kept.includes(n)) return `${n} isn’t one of the names kept as written`;
    }
  }
  return null;
};

// What a correction may not do (decision 43): be empty or far longer than
// the English, lose a slot, a link's address, a kept name or a headline's
// highlighted part.
const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const linksOf = (t) => [...String(t).matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
const hasName = (t, n) => new RegExp(`(?<![\\p{L}\\p{N}])${reEsc(n)}(?![\\p{L}\\p{N}])`, 'u').test(t);
export const editProblem = (src, text, kept = []) => {
  const t = String(text ?? '').trim();
  if (!t) return 'Type the words first';
  if (t.length > src.length * 3 + 200) return 'That’s much longer than the English — shorten it';
  const want = slotsOf(src);
  for (const x of want) if (!t.includes(`{${x}}`)) return `Keep {${x}} in the words`;
  if (slotsOf(t).join() !== want.join()) return `Keep only ${want.map((x) => `{${x}}`).join(' and ') || 'no {…}'} in the words`;
  const links = new Set(linksOf(src));
  if (linksOf(t).some((u) => !links.has(u))) return 'Keep the links as they are';
  for (const n of kept) if (hasName(src, n) && !hasName(t, n)) return `Keep ‘${n}’ as written`;
  for (const tag of ['u', 'b']) {
    if (src.includes(`<${tag}>`) && (t.match(new RegExp(`<${tag}>[^<]+</${tag}>`, 'g')) || []).length !== 1) {
      return `Keep the highlighted words between <${tag}> and </${tag}>`;
    }
  }
  return null;
};

const STATEMENT = /^campaign:[^:]+:statement$/;
const OWN = 'Someone else needs to check your own wording';
const sentenceOf = async (tx, ws, hash) => (await liveStrings(tx, ws)).find((g) => g.hash === hash && g.cls !== 'legal') || null;
const roleOf = async (tx, wsId, userId) => (userId
  ? (await tx.query('select role from memberships where workspace_id = $1 and user_id = $2', [wsId, userId])).rows[0]?.role || null
  : null);

// A version made the live words: the one before it replaced (its decider
// kept), the row written, Traditional converted after Simplified, the
// failure forgotten, the language's rev bumped.
const putLive = async (tx, wsId, { lang, hash, src, place, versionId, text, checkedBy = null }) => {
  const cur = (await tx.query('select version_id from site_translations where workspace_id = $1 and lang = $2 and src_hash = $3', [wsId, lang, hash])).rows[0];
  if (cur && cur.version_id !== versionId) await tx.query("update site_translation_versions set state = 'replaced', decided_at = coalesce(decided_at, now()) where id = $1", [cur.version_id]);
  await tx.query(
    `insert into site_translations (id, workspace_id, lang, src_hash, src, text, origin, version_id, checked_by, checked_at, place)
     values ($1, $2, $3, $4, $5, $6, 'edited', $7, $8, case when $8::uuid is null then null else now() end, $9)
     on conflict (workspace_id, lang, src_hash) do update set text = $6, origin = 'edited', version_id = $7, retranslate = false,
       checked_by = $8, checked_at = case when $8::uuid is null then null else now() end, updated_at = now()`,
    [newId(), wsId, lang, hash, src, text, versionId, checkedBy, place],
  );
  await tx.query('delete from site_translation_failures where workspace_id = $1 and lang = $2 and src_hash = $3', [wsId, lang, hash]);
  if (lang === 'zh-Hans') { await convertRow(tx, wsId, hash, src, text, place); await bumpRev(tx, wsId, 'zh-Hant'); }
  await bumpRev(tx, wsId, lang);
};

export const languageActions = (siteAction) => {
  const wordsAction = (input, handler) => ({ ...siteAction(input, handler), area: 'site_words' });
  const hasSite = (ctx) => ctx.role === 'manager' || areasFor(ctx).includes('site');
  const version = async (tx, ctx, lang, id) => {
    const v = (await tx.query('select * from site_translation_versions where workspace_id = $1 and lang = $2 and id = $3 for update', [ctx.workspaceId, lang, id])).rows[0];
    if (!v) throw httpError(404, 'Those words are gone — reload the list');
    return v;
  };
  return {
  'site.translation.save': wordsAction(z.object({
    lang: z.enum(OTHER_CODES), src_hash: z.string().regex(/^[0-9a-f]{64}$/), text: z.string().max(20000),
  }), async (tx, ctx, input, emit) => {
    const ws = { ...(ctx.workspace || {}), id: ctx.workspaceId };
    const g = await sentenceOf(tx, ws, input.src_hash);
    if (!g) throw httpError(404, 'That sentence isn’t on the website any more — reload the list');
    const { names } = await keptNames(tx, ws);
    const text = String(input.text).trim();
    const problem = editProblem(g.text, text, names);
    if (problem) throw httpError(400, problem);
    const cur = (await tx.query('select text, version_id from site_translations where workspace_id = $1 and lang = $2 and src_hash = $3', [ctx.workspaceId, input.lang, g.hash])).rows[0];
    const live = hasSite(ctx);
    const id = newId();
    await tx.query(
      `insert into site_translation_versions (id, workspace_id, lang, src_hash, text, origin, made_by, state) values ($1, $2, $3, $4, $5, 'edited', $6, $7)`,
      [id, ctx.workspaceId, input.lang, g.hash, text, ctx.user.id, live ? 'live' : 'suggested'],
    );
    if (live) await putLive(tx, ctx.workspaceId, { lang: input.lang, hash: g.hash, src: g.text, place: g.place, versionId: id, text });
    emit('site_translation', id, live ? 'update' : 'create', { lang: input.lang, src_hash: g.hash, src: g.text, before: cur?.text ?? null, text, state: live ? 'live' : 'suggested' });
    return { version_id: id, state: live ? 'live' : 'suggested' };
  }),
  'site.translation.approve': wordsAction(z.object({ lang: z.enum(OTHER_CODES), version_id: z.uuid() }), async (tx, ctx, input, emit) => {
    const v = await version(tx, ctx, input.lang, input.version_id);
    if (v.state !== 'suggested') throw httpError(409, 'Someone already decided on these words — reload the list');
    if (v.made_by === ctx.user.id) throw httpError(403, OWN);
    const ws = { ...(ctx.workspace || {}), id: ctx.workspaceId };
    const g = await sentenceOf(tx, ws, v.src_hash);
    if (!g) throw httpError(404, 'That sentence isn’t on the website any more — reload the list');
    if (STATEMENT.test(g.place) && ctx.role !== 'manager' && await roleOf(tx, ctx.workspaceId, v.made_by) !== 'manager') {
      throw httpError(403, 'A manager needs to check a statement people sign');
    }
    const { names } = await keptNames(tx, ws);
    const problem = editProblem(g.text, v.text, names);
    if (problem) throw httpError(400, problem);
    await tx.query("update site_translation_versions set state = 'live', decided_by = $2, decided_at = now() where id = $1", [v.id, ctx.user.id]);
    await putLive(tx, ctx.workspaceId, { lang: input.lang, hash: g.hash, src: g.text, place: g.place, versionId: v.id, text: v.text, checkedBy: ctx.user.id });
    emit('site_translation', v.id, 'update', { lang: input.lang, src_hash: g.hash, state: 'live', approved_by: ctx.user.id });
    return { version_id: v.id, state: 'live' };
  }),
  'site.translation.decline': wordsAction(z.object({ lang: z.enum(OTHER_CODES), version_id: z.uuid() }), async (tx, ctx, input, emit) => {
    const v = await version(tx, ctx, input.lang, input.version_id);
    if (v.state !== 'suggested') throw httpError(409, 'Someone already decided on these words — reload the list');
    await tx.query("update site_translation_versions set state = 'declined', decided_by = $2, decided_at = now() where id = $1", [v.id, ctx.user.id]);
    emit('site_translation', v.id, 'update', { lang: input.lang, src_hash: v.src_hash, state: 'declined' });
    return { version_id: v.id, state: 'declined' };
  }),
  'site.translation.check': wordsAction(z.object({
    lang: z.enum(OTHER_CODES), src_hashes: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1).max(100),
  }), async (tx, ctx, input, emit) => {
    const rows = (await tx.query(
      `select t.id, t.src_hash, t.place, v.made_by from site_translations t left join site_translation_versions v on v.id = t.version_id
        where t.workspace_id = $1 and t.lang = $2 and t.src_hash = any($3::text[]) for update of t`, [ctx.workspaceId, input.lang, input.src_hashes],
    )).rows;
    if (rows.length !== new Set(input.src_hashes).size) throw httpError(404, 'Some of those sentences have no words yet — reload the list');
    for (const r of rows) {
      if (r.made_by === ctx.user.id) throw httpError(403, OWN);
      if (STATEMENT.test(r.place || '') && ctx.role !== 'manager' && await roleOf(tx, ctx.workspaceId, r.made_by) !== 'manager') {
        throw httpError(403, 'A manager needs to check a statement people sign');
      }
    }
    await tx.query('update site_translations set checked_by = $3, checked_at = now(), updated_at = now() where workspace_id = $1 and lang = $2 and id = any($4::uuid[])',
      [ctx.workspaceId, input.lang, ctx.user.id, rows.map((r) => r.id)]);
    await bumpRev(tx, ctx.workspaceId, input.lang);
    emit('site_translation_check', newId(), 'create', { lang: input.lang, src_hashes: rows.map((r) => r.src_hash) });
    return { checked: rows.length };
  }),
  'site.translation.undo': siteAction(z.object({ lang: z.enum(OTHER_CODES), version_id: z.uuid() }), async (tx, ctx, input, emit) => {
    const v = await version(tx, ctx, input.lang, input.version_id);
    const row = (await tx.query('select src, place, version_id from site_translations where workspace_id = $1 and lang = $2 and src_hash = $3 for update', [ctx.workspaceId, input.lang, v.src_hash])).rows[0];
    if (!row || row.version_id !== v.id || !v.made_by) throw httpError(409, 'These aren’t the live words any more — reload the list');
    const prior = (await tx.query(
      `select * from site_translation_versions where workspace_id = $1 and lang = $2 and src_hash = $3 and made_at <= $4 and id <> $5 and state = 'replaced'
        order by made_at desc limit 1`, [ctx.workspaceId, input.lang, v.src_hash, v.made_at, v.id],
    )).rows[0];
    if (!prior) throw httpError(400, 'There are no earlier words to go back to');
    await tx.query("update site_translation_versions set state = 'replaced', decided_by = $2, decided_at = now() where id = $1", [v.id, ctx.user.id]);
    await tx.query("update site_translation_versions set state = 'live' where id = $1", [prior.id]);
    // Checked again only when someone other than the one undoing had approved them.
    const checkedBy = prior.origin === 'edited' && prior.decided_by && prior.decided_by !== ctx.user.id ? prior.decided_by : null;
    await tx.query(
      `update site_translations set text = $4, origin = $5, version_id = $6, checked_by = $7, checked_at = case when $7::uuid is null then null else now() end, updated_at = now()
        where workspace_id = $1 and lang = $2 and src_hash = $3`, [ctx.workspaceId, input.lang, v.src_hash, prior.text, prior.origin, prior.id, checkedBy],
    );
    if (input.lang === 'zh-Hans') { await convertRow(tx, ctx.workspaceId, v.src_hash, row.src, prior.text, row.place); await bumpRev(tx, ctx.workspaceId, 'zh-Hant'); }
    await bumpRev(tx, ctx.workspaceId, input.lang);
    emit('site_translation', v.id, 'update', { lang: input.lang, src_hash: v.src_hash, state: 'replaced', undone: true, before: v.text, text: prior.text });
    return { version_id: prior.id };
  }),
  'site.names.keep': wordsAction(z.object({ name: z.string().trim().min(1).max(60), keep: z.boolean() }), async (tx, ctx, input, emit) => {
    const was = sectionOf('languages', parseJ((await tx.query('select languages from site_settings where workspace_id = $1 for update', [ctx.workspaceId])).rows[0]?.languages, {}));
    const name = input.name.replace(/\s+/g, ' ');
    const keep = input.keep ? [...new Set([...was.keep, name])] : was.keep.filter((n) => n !== name);
    if (keep.length > 100) throw httpError(400, 'At most 100 names typed here');
    if (keep.length === was.keep.length && keep.every((n, i) => n === was.keep[i])) return { keep };
    await tx.query('update site_settings set languages = $2, updated_at = now() where workspace_id = $1', [ctx.workspaceId, JSON.stringify({ ...was, keep })]);
    if (input.keep) await markRetranslate(tx, ctx.workspaceId, [name]);
    emit('site_settings', ctx.workspaceId, 'update', { languages: { keep } });
    return { keep };
  }),
  'site.legal.approve': siteAction(z.object({
    lang: z.enum(OTHER_CODES),
    words: z.record(z.string(), z.any()),
  }), async (tx, ctx, input, emit) => {
    if (ctx.role !== 'manager') throw httpError(403, 'Only a manager can do this');
    const ws = ctx.workspace || { id: ctx.workspaceId };
    const { names: kept } = await keptNames(tx, { id: ctx.workspaceId, ...ws });
    const problem = legalProblem(input.words, kept);
    if (problem) throw httpError(400, problem);
    const words = Object.fromEntries(LEGAL_KEYS.map((k) => [k, String(input.words[k]).trim()]));
    const names = Object.fromEntries(Object.entries(input.words.names || {}).map(([n, r]) => [n, String(r ?? '').trim()]).filter(([, r]) => r));
    if (Object.keys(names).length) words.names = names;
    const id = newId();
    await tx.query(
      'insert into site_legal_words (id, workspace_id, lang, english, words, approved_by) values ($1, $2, $3, $4, $5, $6)',
      [id, ctx.workspaceId, input.lang, JSON.stringify(LEGAL_ENGLISH), JSON.stringify(words), ctx.user.id],
    );
    await bumpRev(tx, ctx.workspaceId, input.lang);
    emit('site_legal_words', id, 'create', { lang: input.lang, words, english: LEGAL_ENGLISH, approved_by: ctx.user.id });
    return { id, lang: input.lang };
  }),
  'site.translate.now': wordsAction(z.object({}), async (tx, ctx) => {
    await queueSweep(tx, ctx.workspaceId);
    return { queued: true };
  }),
  };
};
