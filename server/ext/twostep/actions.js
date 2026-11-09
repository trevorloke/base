// Two-step sign-in, your own and the campaign's (lib/twostep.js).
//
//   twostep.start              set it up (or start over): a new key, not on
//                              yet → { setup: { key, grouped, uri, qr } }
//   twostep.confirm { code }   the app's first code turns it on → the ten
//                              recovery codes, shown this once; your other
//                              devices sign in again (with a code)
//   twostep.off { code }       turn it off: a code from the app, or a
//                              recovery code
//   twostep.codes { code }     new recovery codes (a code from the app); the
//                              old ones stop working
//   twostep.reset { user_id }  managers: someone lost their phone — theirs
//                              is cleared and they're signed out everywhere;
//                              they sign in with their password (and set it
//                              up again, when it's required for their role).
//                              Not for someone who belongs to another
//                              campaign on this server too: that's the
//                              server's shell (scripts/reset-two-step.mjs)
//   twostep.require { on }     managers: require it for desk roles (manager,
//                              treasurer, staff) and anyone given an area;
//                              a manager's own must be on first
//
// Tries at a code count (lib/twostep.js codeFails) as they come in: ten in
// 15 minutes, then a pause; a right code clears them once its write has
// committed (after()). The slow hashes (new recovery codes — made only for
// a code that's right — and a recovery code typed) are made in before(),
// never while the campaign's write lock is held. Nothing secret goes on the
// event log — only that it was turned on, off, reset, or its recovery codes
// made again.
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import {
  base32Decode, checkCode, codeFails, hashRecoveryCode, newRecoveryCodes, newRecoverySalt, newTotpSecret,
  openSecret, peekCode, recoveryHashFor, requiredFor, sealSecret, setupFor, twoStepRow, verifyTotp,
} from '../../lib/twostep.js';

const EVERYONE = ['manager', 'treasurer', 'staff', 'volunteer'];
const MANAGER = ['manager'];
const code = () => z.object({ code: z.string().trim().min(1).max(40) });
const parseJ = (v, d) => (typeof v === 'string' ? JSON.parse(v) : (v ?? d));

export const TOO_MANY_CODES = 'too many wrong codes — wait 15 minutes, then try again';
const NO_MATCH = 'that code doesn’t match — type the newest code your app shows';

// How the app names this account in the authenticator: the campaign, on base.win.
export const issuerFor = (ctx) => `${String(ctx.workspace?.name || 'Campaign').slice(0, 40)} (base.win)`;

// Each try at a code counts against the person, whatever they were doing,
// before the code is checked; a right one clears the count.
const guard = (ctx) => {
  if (codeFails(`user:${ctx.user.id}`)) throw httpError(429, TOO_MANY_CODES);
};
// Committed: the right code clears the person's count.
const passed = async (db, ctx, result) => { codeFails.clear(`user:${ctx.user.id}`); return { result }; };
const missed = (message = NO_MATCH) => httpError(400, message);
const SETUP_NO_MATCH = 'that code doesn’t match — check the app has the key on this screen, then type the newest code it shows';
const APP_NO_MATCH = 'that code doesn’t match — type the newest code from your app';

// Ten new recovery codes, and what's kept of them (hashes, one salt).
const freshCodes = async () => {
  const codes = newRecoveryCodes();
  const salt = newRecoverySalt();
  return { codes, salt, hashes: await Promise.all(codes.map((c) => hashRecoveryCode(c, salt))) };
};

export const actions = {
  'twostep.start': {
    roles: EVERYONE,
    input: z.object({}).passthrough(),
    handler: async (tx, ctx) => {
      const row = await twoStepRow(tx, ctx.user.id, { lock: true });
      if (row?.on_since) throw httpError(409, 'two-step sign-in is already on');
      const secret = newTotpSecret();
      await tx.query(
        `insert into two_step (user_id, secret) values ($1, $2)
         on conflict (user_id) do update set secret = excluded.secret, on_since = null, recovery = '[]',
           recovery_salt = null, last_step = null, updated_at = now()`,
        [ctx.user.id, await sealSecret(tx, secret)],
      );
      return { setup: setupFor(secret, { account: ctx.user.email, issuer: issuerFor(ctx) }) };
    },
  },

  'twostep.confirm': {
    roles: EVERYONE,
    input: code(),
    // A code that's right gets its ten recovery codes' slow hashes made
    // here, before the write; a wrong one costs nothing.
    before: async (db, ctx, input) => {
      guard(ctx);
      return (await peekCode(db, ctx.user.id, input.code, { pending: true })) ? freshCodes() : null;
    },
    handler: async (tx, ctx, input, emit, fresh) => {
      const row = await twoStepRow(tx, ctx.user.id, { lock: true });
      if (row?.on_since) throw httpError(409, 'two-step sign-in is already on');
      const open = row?.secret ? await openSecret(tx, row.secret) : null;
      if (!open) throw httpError(409, 'start setting it up again — the key on your screen has expired');
      const step = verifyTotp(base32Decode(open.plain), input.code, { afterStep: row.last_step == null ? null : Number(row.last_step) });
      if (step === null || !fresh) throw missed(SETUP_NO_MATCH);
      const { codes, salt, hashes } = fresh;
      await tx.query(
        `update two_step set on_since = now(), last_step = $2, recovery = $3, recovery_salt = $4, updated_at = now()
         where user_id = $1`,
        [ctx.user.id, step, JSON.stringify(hashes), salt],
      );
      // Signed in elsewhere with a password alone: those devices sign in
      // again, with a code. This one stays signed in.
      const ended = await tx.query('delete from sessions where user_id = $1 and token_hash <> $2', [ctx.user.id, ctx.session || '']);
      emit('two_step', ctx.user.id, 'create', { on: true });
      return { on: true, recovery_codes: codes, signed_out_elsewhere: ended.affectedRows };
    },
    after: passed,
  },

  'twostep.off': {
    roles: EVERYONE,
    input: code(),
    // A recovery code's slow hash, before the write.
    before: async (db, ctx, input) => { guard(ctx); return { hash: await recoveryHashFor(db, ctx.user.id, input.code) }; },
    handler: async (tx, ctx, input, emit, ready) => {
      const row = await twoStepRow(tx, ctx.user.id);
      if (!row?.on_since) throw httpError(409, 'two-step sign-in isn’t on');
      const r = await checkCode(tx, ctx.user.id, input.code, { hash: ready?.hash });
      if (!r.used) {
        throw missed(r.unreadable
          ? 'your app’s codes can’t be checked on this server any more — use one of your recovery codes'
          : 'that code doesn’t match — use the newest code from your app, or one of your recovery codes');
      }
      await tx.query('delete from two_step where user_id = $1', [ctx.user.id]);
      // A sign-in elsewhere waiting for a code: there's no code to wait for now.
      await tx.query('delete from two_step_pending where user_id = $1', [ctx.user.id]);
      emit('two_step', ctx.user.id, 'void', { turned_off: true, with: r.used === 'recovery' ? 'recovery code' : 'app' });
      return { on: false, must_set_up: requiredFor(ctx.role, ctx.workspace?.settings, ctx.perms) };
    },
    after: passed,
  },

  'twostep.codes': {
    roles: EVERYONE,
    input: code(),
    // New codes' slow hashes only for an app code that's right.
    before: async (db, ctx, input) => {
      guard(ctx);
      return (await peekCode(db, ctx.user.id, input.code)) ? freshCodes() : null;
    },
    handler: async (tx, ctx, input, emit, fresh) => {
      if (!fresh) {
        const row = await twoStepRow(tx, ctx.user.id);
        throw missed(row?.on_since && !(await openSecret(tx, row.secret)) ? 'your app’s codes can’t be checked on this server any more' : APP_NO_MATCH);
      }
      const r = await checkCode(tx, ctx.user.id, input.code, { allowRecovery: false });
      if (!r.used) throw missed(r.unreadable ? 'your app’s codes can’t be checked on this server any more' : APP_NO_MATCH);
      const { codes, salt, hashes } = fresh;
      await tx.query('update two_step set recovery = $2, recovery_salt = $3, updated_at = now() where user_id = $1',
        [ctx.user.id, JSON.stringify(hashes), salt]);
      emit('two_step', ctx.user.id, 'update', { recovery_codes: 'made again' });
      return { recovery_codes: codes };
    },
    after: passed,
  },

  'twostep.reset': {
    roles: MANAGER,
    input: z.object({ user_id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      if (input.user_id === ctx.user.id) throw httpError(400, 'to turn off your own, use Your profile');
      const member = (await tx.query('select 1 from memberships where user_id = $1 and workspace_id = $2', [input.user_id, ctx.workspaceId])).rows[0];
      if (!member) throw httpError(404, 'member not found');
      // Their two-step sign-in guards every campaign they're in: one
      // campaign's manager doesn't clear it for another's.
      const elsewhere = (await tx.query('select 1 from memberships where user_id = $1 and workspace_id <> $2 limit 1', [input.user_id, ctx.workspaceId])).rows[0];
      if (elsewhere) throw httpError(409, 'they belong to another campaign on this server too — it’s reset from the server’s shell (scripts/reset-two-step.mjs)');
      const n = await tx.query('delete from two_step where user_id = $1', [input.user_id]);
      if (n.affectedRows === 0) throw httpError(404, 'they don’t use two-step sign-in');
      // A lost phone: signed out everywhere, and a sign-in waiting for a code ends.
      await tx.query('delete from sessions where user_id = $1', [input.user_id]);
      await tx.query('delete from two_step_pending where user_id = $1', [input.user_id]);
      emit('two_step', input.user_id, 'void', { reset: true });
      return { user_id: input.user_id };
    },
  },

  'twostep.require': {
    roles: MANAGER,
    input: z.object({ on: z.boolean() }),
    handler: async (tx, ctx, input, emit) => {
      if (input.on && !(await twoStepRow(tx, ctx.user.id))?.on_since) {
        throw httpError(409, 'turn on two-step sign-in for yourself first (Your profile)');
      }
      const cur = (await tx.query('select settings from workspaces where id = $1', [ctx.workspaceId])).rows[0];
      const settings = parseJ(cur.settings, {});
      if (input.on) settings.twoStepRequired = true; else delete settings.twoStepRequired;
      await tx.query('update workspaces set settings = $2 where id = $1', [ctx.workspaceId, JSON.stringify(settings)]);
      emit('workspace', ctx.workspaceId, 'update', { two_step_required: input.on });
      return { required: input.on };
    },
  },
};
