// From addresses: managers add, rename and remove them and pick the
// defaults (Settings → Services → Email). Only addresses at MAIL_FROM's own
// domain: Resend and SendGrid verify the domain, not each address, so one
// on it sends with no more setup; any other is refused before it is saved.
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { newId } from '../../lib/events.js';
import { emailConfigured } from '../../lib/notify.js';
import { SENDERS_MAX, allowedDomain, defaultsOf, sendersOf, settingsOf } from './rules.js';

const MANAGER = ['manager'];
// A name a mail app shows: no line breaks or control characters, and none
// of < > " (they would end the name early). Commas and apostrophes are fine.
const NAME = z.string().trim().min(1).max(80).refine((s) => !/[\u0000-\u001f\u007f<>"]/.test(s), 'a name without < > " or line breaks');

const locked = async (tx, ws) => settingsOf((await tx.query('select settings from workspaces where id = $1 for update', [ws])).rows[0]);
const store = (tx, ws, settings) => tx.query('update workspaces set settings = $2 where id = $1', [ws, JSON.stringify(settings)]);

export const actions = {
  'sender.save': {
    roles: MANAGER,
    input: z.object({
      id: z.uuid().optional(),
      name: NAME,
      email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
    }),
    handler: async (tx, ctx, input, emit) => {
      const domain = allowedDomain();
      if (!emailConfigured() || !domain) throw httpError(409, 'Connect email first');
      if (input.email.split('@').pop() !== domain) throw httpError(409, `Use an address at ${domain}`);
      const settings = await locked(tx, ctx.workspaceId);
      const list = sendersOf(settings);
      const same = list.find((s) => s.email === input.email && s.id !== input.id);
      if (same) throw httpError(409, `${input.email} is already on the list`);
      let row;
      if (input.id) {
        row = list.find((s) => s.id === input.id);
        if (!row) throw httpError(404, 'That From address was removed');
        Object.assign(row, { name: input.name, email: input.email });
      } else {
        if (list.length >= SENDERS_MAX) throw httpError(409, `${SENDERS_MAX} From addresses at most`);
        row = { id: newId(), name: input.name, email: input.email };
        list.push(row);
      }
      await store(tx, ctx.workspaceId, { ...settings, senders: list });
      emit('sender', row.id, input.id ? 'update' : 'create', row);
      return { sender: row };
    },
  },

  // Removing a default sends that kind from MAIL_FROM again.
  'sender.remove': {
    roles: MANAGER,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const settings = await locked(tx, ctx.workspaceId);
      const list = sendersOf(settings);
      if (!list.some((s) => s.id === input.id)) throw httpError(404, 'That From address was removed');
      const next = { ...settings, senders: list.filter((s) => s.id !== input.id) };
      if (next.sender_email === input.id) next.sender_email = null;
      if (next.sender_press === input.id) next.sender_press = null;
      await store(tx, ctx.workspaceId, next);
      emit('sender', input.id, 'void', {});
      return { id: input.id, defaults: defaultsOf(next) };
    },
  },

  'sender.default': {
    roles: MANAGER,
    input: z.object({ use: z.enum(['email', 'press']), id: z.uuid().nullable() }),
    handler: async (tx, ctx, input, emit) => {
      const settings = await locked(tx, ctx.workspaceId);
      if (input.id && !sendersOf(settings).some((s) => s.id === input.id)) throw httpError(404, 'That From address was removed');
      const next = { ...settings, [`sender_${input.use}`]: input.id };
      await store(tx, ctx.workspaceId, next);
      emit('sender', input.id || ctx.workspaceId, 'update', { default: input.use, id: input.id });
      return { defaults: defaultsOf(next) };
    },
  },
};
