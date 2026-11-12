// ladder.* actions — desk roles only (manager, treasurer, staff). Same
// contract as every action: zod input, a transactional handler, events.
//
//   ladder.create       name + trigger (+ steps, goal); a new ladder starts Off
//   ladder.update       name, trigger, steps, goal (null: none), "let people
//                       go through again". Every text step must name the
//                       campaign (shape.js textProblem). With steps, the
//                       page says which step kinds it has words for
//                       (`knows`): one from before a kind existed shows that
//                       step as a Stop, and is told to reload before it
//                       writes one over the step or takes it away (misread).
//   ladder.setActive    On: people who start it from now on are put on it,
//                       and paused runs pick up at the same step. Off: every
//                       run holds its place and pending steps are cancelled.
//   ladder.delete       gone from the lists; runs end, follow-ups stay
//   ladder.stopRun      take one person off a ladder
//   ladder.followupDone a follow-up done (or, with done: false, not yet)
//   ladder.followupAssign  hand a follow-up to a named organizer (the desk
//                       re-routing speed to lead, ext/followups). A ladder's
//                       own follow-ups ("Thank Ana for her gift") go to the
//                       desk only: a volunteer never sees money.
//   ladder.signingSecret  the secret this campaign's "Send to a web address"
//                       messages are signed with, for whoever sets up the
//                       other end. Answered only here, never by a read; each
//                       look is on the event log.
//   ladder.newSigningSecret  "Make a new secret": the one before stops
//                       signing at once (someone who saw it left; it was
//                       pasted somewhere). Answers the new one; on the log.
//   ladder.testHook     "Send a test": one signed message about a made-up
//                       person to the address in a step as it is typed,
//                       saved or not; answers what the address said. About
//                       nobody, on nobody's log; that a test went, and to
//                       which site, is on the event log.
//
// A "Send to a web address" step (create, update): its address must be
// https and must not point inside a private network (webhook.js) — the
// words are checked in the write, a new address's name is looked up before
// it (`before`: no lookup ever holds the campaign's lock). Only the desk
// makes one, or changes or turns on a ladder that has one: it hands on
// emails a volunteer may never see. The address is kept with the ladder; the
// event log keeps only the site it goes to (forLog).
import { z } from 'zod';
import { newId } from '../../lib/events.js';
import { httpError } from '../../actions/util.js';
import {
  triggerSchema, stepsSchema, goalSchema, runnable, parseJson, textProblem, HOOK_URL_MAX, HOOK_LABEL_MAX,
} from './shape.js';
import { pauseLadder, resumeLadder, endRun, appendLog } from './engine.js';
import {
  addressProblem, answerEntry, cleanAddress, lookupProblem, postHook, secretNo, secretsFor, testBody,
} from './webhook.js';
import { campaignOf, hasTable } from '../webdid/words.js';

const DESK = ['manager', 'treasurer', 'staff'];
const uuid = () => z.uuid();
const name = () => z.string().trim().min(1).max(120);

const loadLadder = async (tx, ws, id) => {
  const l = (await tx.query(
    'select * from ladders where id = $1 and workspace_id = $2 and deleted_at is null for update',
    [id, ws],
  )).rows[0];
  if (!l) throw httpError(404, 'ladder not found');
  return l;
};

// The detail a trigger keeps: the tag, for "Got a tag"; what was done on
// the website (a kind, or one of this campaign's petitions and pledges);
// the survey, for "Answered a survey" (none: any survey). Nothing otherwise.
const checkRef = async (tx, ws, trigger) => {
  const ref = trigger.ref ? String(trigger.ref).trim() : '';
  if (trigger.kind === 'tag') return ref || null;
  if (trigger.kind === 'web') {
    const id = campaignOf(ref);
    if (!id) return ref;
    // The website's petitions are the site server's; checked when it's there.
    if (await hasTable(tx, 'site_campaigns')) {
      const c = (await tx.query('select id from site_campaigns where id = $1 and workspace_id = $2', [id, ws])).rows[0];
      if (!c) throw httpError(404, 'that petition or pledge isn’t here');
    }
    return `campaign:${id}`;
  }
  if (trigger.kind === 'survey' && ref) {
    const s = (await tx.query('select id from surveys where id = $1 and workspace_id = $2', [ref.toLowerCase(), ws])).rows[0];
    if (!s) throw httpError(404, 'survey not found');
    return s.id;
  }
  return null;
};

// Every text step names the campaign and fills in only what fills in.
const checkTexts = (ctx, steps) => {
  for (const s of steps || []) {
    if (s.kind !== 'text') continue;
    const why = textProblem(s.body, ctx.workspace?.name);
    if (why) throw httpError(400, why.charAt(0).toUpperCase() + why.slice(1));
  }
};

// "Send to a web address" steps, each address checked on its words and
// kept tidy. Never a volunteer's, even one given Outreach — to make, or (a
// ladder that has one) to change or turn on: the answer carries the steps,
// and the address in them can be a key.
const isHook = (s) => s.kind === 'webhook';
const deskOnlyHooks = (ctx, steps) => {
  if (ctx.role === 'volunteer' && (steps || []).some(isHook)) throw httpError(403, 'Only the desk can send to a web address');
};
const checkHooks = (ctx, steps) => {
  deskOnlyHooks(ctx, steps);
  return (steps || []).map((s) => {
    if (!isHook(s)) return s;
    const why = addressProblem(s.url);
    if (why) throw httpError(400, why);
    return { ...s, url: cleanAddress(s.url) };
  });
};
// What the event log keeps of the steps: an address there is only where it
// goes (the site's name). The rest of it can be a key, and the log is kept —
// and exported — for good, long after a step is changed or removed.
const siteOf = (url) => `${new URL(url).origin}/…`;
const forLog = (steps) => steps.map((s) => (isHook(s) ? { ...s, url: siteOf(s.url) } : s));
// Before the write: the name behind each address this ladder doesn't
// already send to is looked up (an address saved before isn't asked about
// again — a lookup that fails must not stop another step being edited).
const lookUpHooks = async (db, ctx, input) => {
  const hooks = (input.steps || []).filter(isHook);
  if (!hooks.length) return;
  deskOnlyHooks(ctx, hooks);
  const cur = input.id ? (await db.query(
    'select steps from ladders where id = $1 and workspace_id = $2 and deleted_at is null', [input.id, ctx.workspaceId],
  )).rows[0] : null;
  const known = new Set(parseJson(cur?.steps, []).filter(isHook).map((s) => s.url));
  for (const s of hooks) {
    const why = addressProblem(s.url) || (known.has(cleanAddress(s.url)) ? null : await lookupProblem(s.url));
    if (why) throw httpError(400, why);
  }
};

// A tab left open from before a step kind existed has no words for it: it
// shows the step as a Stop, "Save step" on that card sends a Stop in its
// place and "Remove step" sends the steps without it — an address lost, and
// a ladder that ends there for everyone after. A release can't change a
// page already open, so the server checks what such a page cannot have
// meant: of each kind the saving page has no words for, as many steps must
// come back as are stored (that page hands a step it can't read back as it
// came — moved, or beside another step it changed — and can't make one).
// Fewer — made a Stop, taken away, also under a stale tab's older copy of
// the other steps — is refused, and the page is told to reload. A page
// says which kinds it has words for with each save (`knows`); every page
// has had these seven.
const FIRST_KINDS = ['wait', 'email', 'text', 'tag', 'untag', 'followup', 'stop'];
const RELOAD = 'Reload this page — it’s out of date and shows this step wrongly';
const misread = (cur, next, knows) => {
  const known = new Set([...FIRST_KINDS, ...(knows || [])]);
  const count = (steps, kind) => steps.filter((s) => s?.kind === kind).length;
  return [...new Set(cur.map((s) => s.kind))].some((kind) => !known.has(kind) && count(next, kind) < count(cur, kind));
};

const out = (l) => ({
  id: l.id, name: l.name, trigger: { kind: l.trigger_kind, ref: l.trigger_ref || null },
  steps: parseJson(l.steps, []), active: l.active, reentry: l.reentry, goal: l.goal || null,
});

// The signing secret, a new one and a test are the desk's alone — never a
// volunteer's, even one given Outreach. The server's own secret (which the
// campaign's are made from) may be read from the database: before the
// write, never inside it.
const deskSecrets = (words) => async (db, ctx) => {
  if (ctx.role === 'volunteer') throw httpError(403, words);
  return { secrets: await secretsFor(ctx.workspaceId) };
};
// The campaign's settings as they are inside this write (its row is locked).
const settingsNow = async (tx, ws) => parseJson((await tx.query('select settings from workspaces where id = $1', [ws])).rows[0]?.settings, {});
// What "Send a test" hands from its write to the call made after it.
const SEND = Symbol('send');

export const actions = {
  'ladder.create': {
    roles: DESK,
    input: z.object({
      name: name(),
      trigger: triggerSchema,
      steps: stepsSchema.default([]),
      reentry: z.boolean().default(false),
      goal: goalSchema.nullish(),
    }),
    before: lookUpHooks,
    handler: async (tx, ctx, input, emit) => {
      const ref = await checkRef(tx, ctx.workspaceId, input.trigger);
      checkTexts(ctx, input.steps);
      input.steps = checkHooks(ctx, input.steps);
      const id = newId();
      const goal = input.goal || null;
      await tx.query(
        `insert into ladders (id, workspace_id, name, trigger_kind, trigger_ref, steps, reentry, public_url, created_by, goal)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, ctx.workspaceId, input.name, input.trigger.kind, ref, JSON.stringify(input.steps),
         input.reentry, ctx.publicUrl || null, ctx.user.id, goal],
      );
      const ladder = { id, name: input.name, trigger: { kind: input.trigger.kind, ref }, steps: input.steps, active: false, reentry: input.reentry, goal };
      emit('ladder', id, 'create', { ...ladder, steps: forLog(input.steps) });
      return { ladder };
    },
  },

  'ladder.update': {
    roles: DESK,
    input: z.object({
      id: uuid(),
      name: name().nullish(),
      trigger: triggerSchema.nullish(),
      steps: stepsSchema.nullish(),
      reentry: z.boolean().nullish(),
      // A goal, or null to have none; left out, it stays as it is.
      goal: goalSchema.nullable().optional(),
      // With steps: the step kinds the page that sends them has words for.
      knows: z.array(z.string().max(40)).max(40).nullish(),
    }),
    before: lookUpHooks,
    handler: async (tx, ctx, input, emit) => {
      const cur = await loadLadder(tx, ctx.workspaceId, input.id);
      deskOnlyHooks(ctx, parseJson(cur.steps, []));
      const next = { ...cur };
      const patch = {};
      if (input.name) { next.name = input.name; patch.name = input.name; }
      if (input.trigger) {
        next.trigger_kind = input.trigger.kind;
        next.trigger_ref = await checkRef(tx, ctx.workspaceId, input.trigger);
        patch.trigger = { kind: next.trigger_kind, ref: next.trigger_ref };
      }
      if (input.steps) {
        if (misread(parseJson(cur.steps, []), input.steps, input.knows)) throw httpError(409, RELOAD);
        if (cur.active && !runnable(input.steps)) throw httpError(400, 'a ladder that is on needs a step that does something');
        checkTexts(ctx, input.steps);
        input.steps = checkHooks(ctx, input.steps);
        next.steps = input.steps;
        patch.steps = input.steps;
      }
      if (input.reentry != null) { next.reentry = input.reentry; patch.reentry = input.reentry; }
      if (input.goal !== undefined) { next.goal = input.goal || null; patch.goal = next.goal; }
      await tx.query(
        `update ladders set name = $3, trigger_kind = $4, trigger_ref = $5, steps = $6, reentry = $7,
           public_url = coalesce($8, public_url), goal = $9, updated_at = now()
         where id = $1 and workspace_id = $2`,
        [cur.id, ctx.workspaceId, next.name, next.trigger_kind, next.trigger_ref || null,
         JSON.stringify(parseJson(next.steps, [])), next.reentry, ctx.publicUrl || null, next.goal || null],
      );
      emit('ladder', cur.id, 'update', patch.steps ? { ...patch, steps: forLog(patch.steps) } : patch);
      return { ladder: out(next) };
    },
  },

  'ladder.setActive': {
    roles: DESK,
    input: z.object({ id: uuid(), active: z.boolean() }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await loadLadder(tx, ctx.workspaceId, input.id);
      deskOnlyHooks(ctx, parseJson(cur.steps, []));
      if (cur.active === input.active) return { ladder: out(cur), paused: 0, resumed: 0 };
      if (input.active && !runnable(parseJson(cur.steps, []))) {
        throw httpError(400, 'add a step first — an email, a tag or a follow-up');
      }
      await tx.query(
        'update ladders set active = $3, public_url = coalesce($4, public_url), updated_at = now() where id = $1 and workspace_id = $2',
        [cur.id, ctx.workspaceId, input.active, ctx.publicUrl || null],
      );
      // The order matters: resuming schedules jobs, pausing cancels them.
      const resumed = input.active ? await resumeLadder(tx, ctx.workspaceId, cur.id) : 0;
      const paused = input.active ? 0 : await pauseLadder(tx, ctx.workspaceId, cur.id);
      emit('ladder', cur.id, 'update', { active: input.active, paused, resumed });
      return { ladder: out({ ...cur, active: input.active }), paused, resumed };
    },
  },

  'ladder.delete': {
    roles: DESK,
    input: z.object({ id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await loadLadder(tx, ctx.workspaceId, input.id);
      await pauseLadder(tx, ctx.workspaceId, cur.id);
      const ended = (await tx.query(
        `update ladder_runs set status = 'done', wait = null, next_at = null, token = null,
           finished_at = coalesce(finished_at, now()), updated_at = now()
         where workspace_id = $1 and ladder_id = $2 and status <> 'done' returning id`,
        [ctx.workspaceId, cur.id],
      )).rows.length;
      await tx.query(
        'update ladders set active = false, deleted_at = now(), updated_at = now() where id = $1 and workspace_id = $2',
        [cur.id, ctx.workspaceId],
      );
      emit('ladder', cur.id, 'void', { name: cur.name, ended });
      return { id: cur.id, ended };
    },
  },

  'ladder.stopRun': {
    roles: DESK,
    input: z.object({ id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const run = (await tx.query(
        `select id, workspace_id, ladder_id, person_id, status, step, log from ladder_runs
         where id = $1 and workspace_id = $2 for update`,
        [input.id, ctx.workspaceId],
      )).rows[0];
      if (!run) throw httpError(404, 'not on that ladder');
      if (run.status === 'done') return { id: run.id, status: 'done' };
      await endRun(tx, run);
      await appendLog(tx, run, { step: Number(run.step), kind: 'end', result: 'taken_off' });
      emit('ladder_run', run.id, 'update', { ladder_id: run.ladder_id, person_id: run.person_id, status: 'done', reason: 'taken_off' });
      return { id: run.id, status: 'done' };
    },
  },

  'ladder.signingSecret': {
    roles: DESK,
    input: z.object({}),
    before: deskSecrets('Only the desk can see the signing secret'),
    handler: async (tx, ctx, input, emit, ready) => {
      emit('workspace', ctx.workspaceId, 'update', { ladder_signing_secret: 'shown' });
      return { secret: ready.secrets(secretNo(await settingsNow(tx, ctx.workspaceId))) };
    },
  },

  'ladder.newSigningSecret': {
    roles: DESK,
    input: z.object({}),
    before: deskSecrets('Only the desk can change the signing secret'),
    handler: async (tx, ctx, input, emit, ready) => {
      const settings = await settingsNow(tx, ctx.workspaceId);
      const n = secretNo(settings) + 1;
      await tx.query('update workspaces set settings = $2 where id = $1', [ctx.workspaceId, JSON.stringify({ ...settings, ladderSecretNo: n })]);
      emit('workspace', ctx.workspaceId, 'update', { ladder_signing_secret: 'changed' });
      return { secret: ready.secrets(n) };
    },
  },

  'ladder.testHook': {
    roles: DESK,
    input: z.object({
      id: uuid(),
      url: z.string().trim().min(1).max(HOOK_URL_MAX),
      label: z.string().trim().min(1).max(HOOK_LABEL_MAX),
    }),
    // The address is checked as when a step is saved: its words, then the
    // name behind it — looked up before the write, like the secret.
    before: async (db, ctx, input) => {
      const ready = await deskSecrets('Only the desk can send to a web address')(db, ctx);
      const why = addressProblem(input.url) || await lookupProblem(input.url);
      if (why) throw httpError(400, why);
      return ready;
    },
    handler: async (tx, ctx, input, emit, ready) => {
      const l = await loadLadder(tx, ctx.workspaceId, input.id);
      const url = cleanAddress(input.url);
      const key = `test-${newId()}`;
      emit('workspace', ctx.workspaceId, 'update', { ladder_hook_test: siteOf(url) });
      return {
        [SEND]: {
          url,
          key,
          secret: ready.secrets(secretNo(await settingsNow(tx, ctx.workspaceId))),
          body: testBody({
            id: key, event: l.trigger_kind, ref: l.trigger_ref || null, ladder: l.name, step: input.label, campaign: ctx.workspace?.name || '',
          }),
        },
      };
    },
    // Committed (only that a test went): now the one call, outside the lock.
    after: async (db, ctx, result) => ({ result: answerEntry(await postHook(result[SEND])) }),
  },

  'ladder.followupDone': {
    roles: DESK,
    input: z.object({ id: uuid(), done: z.boolean().default(true) }),
    handler: async (tx, ctx, input, emit) => {
      const row = (await tx.query(
        `update ladder_followups
         set status = $3, done_at = case when $3 = 'done' then now() end, done_by = case when $3 = 'done' then $4::uuid end
         where id = $1 and workspace_id = $2 and status <> $3
         returning id, status`,
        [input.id, ctx.workspaceId, input.done ? 'done' : 'open', ctx.user.id],
      )).rows[0];
      if (!row) {
        const exists = (await tx.query('select status from ladder_followups where id = $1 and workspace_id = $2', [input.id, ctx.workspaceId])).rows[0];
        if (!exists) throw httpError(404, 'follow-up not found');
        return { id: input.id, status: exists.status };
      }
      emit('ladder_followup', row.id, 'update', { status: row.status });
      return { id: row.id, status: row.status };
    },
  },

  'ladder.followupAssign': {
    roles: DESK,
    input: z.object({ id: uuid(), user_id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const f = (await tx.query(
        'select id, status, kind, assigned_to, due_at from ladder_followups where id = $1 and workspace_id = $2 for update',
        [input.id, ctx.workspaceId],
      )).rows[0];
      if (!f) throw httpError(404, 'follow-up not found');
      if (f.status !== 'open') throw httpError(409, 'that follow-up is done');
      const who = (await tx.query(
        `select u.id, u.name, m.role from memberships m join users u on u.id = m.user_id
         where m.workspace_id = $1 and m.user_id = $2`,
        [ctx.workspaceId, input.user_id],
      )).rows[0];
      if (!who) throw httpError(404, 'not on the team');
      if (!f.kind && who.role === 'volunteer') throw httpError(400, 'A ladder’s follow-ups stay with the desk');
      if (f.assigned_to === who.id) return { id: f.id, assigned_to: { id: who.id, name: who.name } };
      // The clock is the person's wait, so a hand-over keeps it; a ladder's
      // follow-up gets one when it first has a name on it.
      await tx.query(
        `update ladder_followups set assigned_to = $3, routed = 'desk', due_at = coalesce(due_at, now() + interval '24 hours')
         where id = $1 and workspace_id = $2`,
        [f.id, ctx.workspaceId, who.id],
      );
      emit('ladder_followup', f.id, 'update', { assigned_to: who.id, routed: 'desk', from: f.assigned_to || null });
      return { id: f.id, assigned_to: { id: who.id, name: who.name } };
    },
  },
};
