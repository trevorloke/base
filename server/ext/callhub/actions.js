// callhub.push     { list_id | bank_id }   desk: send a list, or a phone bank's numbers still to call, to a CallHub phonebook
// callhub.resume   { id }                   desk: "Carry on" — a push that stopped starts again where it was
// callhub.map      { id, outcomes?, rating? }  desk: how a push's results are read —
//                    outcomes: { "<CallHub's result>": 'contacted' | 'no_answer' | 'left_message' |
//                                'inaccessible' | 'refused' | 'moved' | 'do_not_call' | null (back to the pattern) }
//                    rating:   { question, answers: { "<answer>": '<a code on the campaign's scale>' | null } }
//                              (the same question again: these answers join the ones already said,
//                              null takes one away; another question starts afresh)
//                              or null (no question rates anyone)
//                  What is already in follows (results.js refile).
// callhub.connect  {}                       managers: give CallHub the address results come back to
import { z } from 'zod';
import { RATING_CODE_RE } from '@starbase/shared/scale';
import { httpError } from '../../actions/util.js';
import { runJobsSoon } from '../../lib/jobs.js';
import { loadScale, ratingRefusal } from '../scale/rules.js';
import { preparePush, pushOut, resumePush, startPush } from './push.js';
import { MAP_OUTCOMES, norm, refile } from './results.js';
import { connect } from './service.js';

const DESK = ['manager', 'treasurer', 'staff'];
const parseJ = (v, d) => { try { return (typeof v === 'string' ? JSON.parse(v) : v) ?? d; } catch { return d; } };
// The job starts now rather than on the runner's next look.
const startNow = async (db, ctx, result) => { runJobsSoon(); return { result }; };

export const actions = {
  'callhub.push': {
    roles: DESK,
    area: 'people',
    input: z.object({ list_id: z.uuid().optional(), bank_id: z.uuid().optional() })
      .refine((v) => Boolean(v.list_id) !== Boolean(v.bank_id), 'a list or a phone bank'),
    // Who goes is worked out before the write, so a big list never holds the campaign's lock.
    before: preparePush,
    handler: (tx, ctx, input, emit, ready) => startPush(tx, ctx, emit, ready),
    after: startNow,
  },

  'callhub.resume': {
    roles: DESK,
    area: 'people',
    input: z.object({ id: z.uuid() }),
    handler: (tx, ctx, input, emit) => resumePush(tx, ctx, emit, input.id),
    after: startNow,
  },

  'callhub.map': {
    roles: DESK,
    area: 'people',
    input: z.object({
      id: z.uuid(),
      outcomes: z.record(z.string().max(200), z.enum(MAP_OUTCOMES).nullable()).optional(),
      rating: z.object({
        question: z.string().trim().min(1).max(300),
        answers: z.record(z.string().max(300), z.string().regex(RATING_CODE_RE, 'not a rating on the scale').nullable()),
      }).nullable().optional(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const push = (await tx.query('select * from callhub_pushes where id = $1 and workspace_id = $2 for update', [input.id, ws])).rows[0];
      if (!push) throw httpError(404, 'not found');
      const outcomes = { ...parseJ(push.outcomes, {}) };
      for (const [said, as] of Object.entries(input.outcomes || {})) {
        if (as === null) delete outcomes[norm(said)]; else outcomes[norm(said)] = as;
      }
      if (Object.keys(outcomes).length > 200) throw httpError(400, 'too many results to correct');
      let rating = parseJ(push.rating_map, null);
      if (input.rating === null) rating = null;
      else if (input.rating) {
        const scale = await loadScale(tx, ws);
        const question = norm(input.rating.question);
        const answers = rating?.question === question ? { ...rating.answers } : {};
        for (const [answer, code] of Object.entries(input.rating.answers)) {
          if (!norm(answer)) continue;
          if (code === null) { delete answers[norm(answer)]; continue; }
          const why = ratingRefusal(scale, code);
          if (why) throw httpError(400, why);
          answers[norm(answer)] = code;
        }
        if (Object.keys(answers).length > 200) throw httpError(400, 'too many answers');
        rating = { question, label: input.rating.question, answers };
      }
      const row = (await tx.query(
        'update callhub_pushes set outcomes = $3::jsonb, rating_map = $4::jsonb where id = $1 and workspace_id = $2 returning *',
        [push.id, ws, JSON.stringify(outcomes), rating ? JSON.stringify(rating) : null],
      )).rows[0];
      const changed = await refile(tx, emit, ws, row);
      emit('callhub_push', push.id, 'update', { corrections: Object.keys(outcomes).length, rating_question: rating?.label || null, refiled: changed });
      return { push: pushOut(row), changed };
    },
  },

  'callhub.connect': {
    roles: ['manager'],
    input: z.object({}),
    // CallHub is asked before the write, never inside it.
    before: (db, ctx) => connect(ctx.publicUrl),
    handler: async (tx, ctx, input, emit, ready) => {
      // Never the address on the log: it ends in the key's own.
      if (ready.made) emit('callhub', ctx.workspaceId, 'update', { webhook: 'connected' });
      return { ok: ready.ok, said: ready.said };
    },
  },
};
