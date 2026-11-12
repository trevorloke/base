// callhub.push     { list_id | bank_id }   desk: send a list, or a phone bank's numbers still to call, to a CallHub phonebook
// callhub.resume   { id }                   desk: "Carry on" — a push that stopped starts again where it was
// callhub.map      { id, outcomes?, rating? }  desk: how a push's results are read —
//                    outcomes: { "<CallHub's result>": 'contacted' | 'no_answer' | 'left_message' |
//                                'inaccessible' | 'refused' | 'moved' | 'do_not_call' | null (back to the pattern) }
//                    rating:   { question, answers: { "<answer>": '<a code on the campaign's scale>' | null } }
//                              (the same question again: these answers join the ones already said,
//                              null takes one away; another question starts afresh)
//                              or null (no question rates anyone)
//                  What is already in follows (results.js refile): only what the change is about,
//                  and putting a row back undoes it. → { push, changed, tagged, untagged, rated,
//                  unrated, more, later, stay_hand, stay_call } — people newly tagged do-not-call or
//                  no longer, people an answer now rates or no longer; more: a big push's rest
//                  follows in the background; later: how many lists sent since carried what was
//                  taken back here, and follow; stay_hand / stay_call: whoever a row put back is
//                  about and is still do-not-call — tagged by hand, or another call says so —
//                  { n, people: [{ id, name }], more } or null, so the desk can look.
// callhub.connect  {}                       managers: give CallHub the address results come back to
import { z } from 'zod';
import { RATING_CODE_RE } from '@starbase/shared/scale';
import { httpError } from '../../actions/util.js';
import { runJobsSoon } from '../../lib/jobs.js';
import { loadScale, ratingRefusal } from '../scale/rules.js';
import { preparePush, pushOut, resumePush, startPush } from './push.js';
import { MAP_OUTCOMES, norm, outcomeFor, refile, refileRest, whoStays } from './results.js';
import { connect } from './service.js';

const DESK = ['manager', 'treasurer', 'staff'];
const parseJ = (v, d) => { try { return (typeof v === 'string' ? JSON.parse(v) : v) ?? d; } catch { return d; } };
// People named for the desk (the line shows a few, the rest on a tap): up to this many.
const NAMED = 100;
const named = async (tx, ws, ids) => {
  if (!ids.length) return null;
  const people = (await tx.query(
    `select id, name from persons where workspace_id = $1 and id = any($2::uuid[]) order by lower(name), id limit ${NAMED}`, [ws, ids],
  )).rows.map((r) => ({ id: r.id, name: r.name }));
  return { n: ids.length, people, more: Math.max(0, ids.length - people.length) };
};
// The job starts now rather than on the runner's next look.
const startNow = async (db, ctx, result) => { runJobsSoon(); return { result }; };

// A push starts as a copy of the newest push's table (push.js), so a pick
// made by mistake lives on in every list sent afterwards — tagging and
// rating people there with nobody asked. What is taken back on a push is
// therefore taken back on each later one that still carries it:
//   · a row that no longer counts as "do not call" here: the later push
//     whose entry for that row is the one this push had gets this push's
//   · an answer that rated here and now rates otherwise, or not at all:
//     the later push with the same question and the same rating for it
//   · the question dropped or replaced while its answers rated: the later
//     push whose question and answers are the ones this push had
// Never the other way: a pick that tags, or an answer newly mapped, was
// asked about this list's people only. A later push the desk has changed
// since is its own. → (a later push's outcomes, rating) → the two as they
// should be now, or null when it carries nothing of it; null when nothing
// was taken back here at all.
const takenBack = (was, now, rows) => {
  const back = [...new Set(rows)].filter((k) => outcomeFor(k, was.outcomes) === 'do_not_call' && outcomeFor(k, now.outcomes) !== 'do_not_call');
  const had = was.rating?.answers || {};
  const whole = Object.keys(had).length > 0 && now.rating?.question !== was.rating.question;
  const answers = whole ? [] : Object.keys(had).filter((a) => now.rating.answers[a] !== had[a]);
  if (!back.length && !whole && !answers.length) return null;
  return (outcomes, rating) => {
    const next = { outcomes: { ...outcomes }, rating };
    let carried = false;
    for (const k of back) {
      if ((outcomes[k] ?? null) !== (was.outcomes[k] ?? null)) continue;
      carried = true;
      if (k in now.outcomes) next.outcomes[k] = now.outcomes[k]; else delete next.outcomes[k];
    }
    if (rating?.question === was.rating?.question && rating) {
      const theirs = rating.answers || {};
      if (whole) {
        const same = Object.keys(theirs).length === Object.keys(had).length && Object.keys(had).every((a) => theirs[a] === had[a]);
        if (same) { carried = true; next.rating = now.rating; }
      } else {
        const moved = answers.filter((a) => theirs[a] === had[a]);
        if (moved.length) {
          carried = true;
          next.rating = { ...rating, answers: { ...theirs } };
          for (const a of moved) { if (now.rating.answers[a] == null) delete next.rating.answers[a]; else next.rating.answers[a] = now.rating.answers[a]; }
        }
      }
    }
    return carried ? next : null;
  };
};

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
      const was = { outcomes: parseJ(push.outcomes, {}), rating: parseJ(push.rating_map, null) };
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
      const moved = await refile(tx, emit, ws, row);
      if (moved.more) await refileRest(tx, ws, push.id, ctx.user.id);
      emit('callhub_push', push.id, 'update', { corrections: Object.keys(outcomes).length, rating_question: rating?.label || null, refiled: moved.changed });
      // The lists sent since that still carry what was taken back here: their
      // tables now, their results in the background (one write stays short).
      let later = 0;
      const follow = takenBack(was, { outcomes, rating }, Object.keys(input.outcomes || {}).map(norm));
      const since = follow ? (await tx.query(
        `select id, outcomes, rating_map from callhub_pushes
          where workspace_id = $1 and id <> $2 and created_at > (select created_at from callhub_pushes where id = $2)
          order by created_at, id for update`,
        [ws, push.id],
      )).rows : [];
      for (const p of since) {
        const next = follow(parseJ(p.outcomes, {}), parseJ(p.rating_map, null));
        if (!next) continue;
        await tx.query(
          'update callhub_pushes set outcomes = $3::jsonb, rating_map = $4::jsonb where id = $1 and workspace_id = $2',
          [p.id, ws, JSON.stringify(next.outcomes), next.rating ? JSON.stringify(next.rating) : null],
        );
        await refileRest(tx, ws, p.id, ctx.user.id);
        emit('callhub_push', p.id, 'update', { corrections: Object.keys(next.outcomes).length, rating_question: next.rating?.label || null, follows: push.id });
        later += 1;
      }
      // Whoever the rows put back here are about and is do-not-call all the
      // same: asked now that the lists that follow have their tables, so a
      // call they let go of in the background is not "another call says so".
      const back = [...new Set(Object.keys(input.outcomes || {}).map(norm))]
        .filter((k) => outcomeFor(k, was.outcomes) === 'do_not_call' && outcomeFor(k, outcomes) !== 'do_not_call');
      const stays = await whoStays(tx, ws, push.id, back);
      return { push: pushOut(row), ...moved, later, stay_hand: await named(tx, ws, stays.stay_hand), stay_call: await named(tx, ws, stays.stay_call) };
    },
    after: startNow,
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
