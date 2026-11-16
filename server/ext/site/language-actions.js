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
import { z } from 'zod';
import { LEGAL_ENGLISH, LEGAL_KEYS, slotsOf } from '../../../shared/site/wording.js';
import { OTHER_CODES } from '../../../shared/site/languages.js';
import { newId } from '../../lib/events.js';
import { httpError } from '../../actions/util.js';
import { keptNames, queueSweep, bumpRev } from './translate.js';

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

export const languageActions = (siteAction) => ({
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
  'site.translate.now': siteAction(z.object({}), async (tx, ctx) => {
    await queueSweep(tx, ctx.workspaceId);
    return { queued: true };
  }),
});
