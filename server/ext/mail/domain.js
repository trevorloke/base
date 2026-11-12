// The sender's domain, guided — the "Sending domain" panel in the Email row
// of Settings → Services (managers).
//
//   GET /api/mail/domain          the DNS records the sender asks for, each
//                                 in or not found yet, and the domain's DMARC
//                                 record — looked up by base.win itself: no
//                                 sender sets it up, and Gmail, Yahoo and
//                                 Outlook all ask bulk senders for one
//   mail.domain.add { domain }    the sender starts holding MAIL_FROM's domain
//   mail.domain.check             the sender looks at the DNS records again
//
// Nothing is stored here: the domain is MAIL_FROM's, found at the sender by
// name each time. A sending-only key can do none of it, and the panel says
// so (canManage: false). The sender is called before the action's write,
// never inside it; adding a domain twice is one domain (it is looked for
// first).
//
// → { provider, name, from, domain, canManage, found, status, records, dmarc }
//   found: true | false | null (a sending-only key: can't be read)
//   status: 'verified' | 'pending' | 'failed' | null
//   records: [{ purpose, type, name, value, priority?, ok }]
//   dmarc: { found: true, at, value } | { found: false, add: { type, name,
//          value } } | { found: null } (the lookup failed: unknown) | null
import { Hono } from 'hono';
import { z } from 'zod';
import { newId } from '../../lib/events.js';
import { httpError } from '../../actions/util.js';
import { activeProvider, mailFrom } from '../../lib/mail/index.js';
import { MailError } from '../../lib/mail/common.js';
import { DMARC_TO_ADD, dmarcOf } from '../../lib/mail/dns.js';

const MANAGER_ONLY = ['manager'];
const UNREADABLE = { canManage: false, found: null, status: null, records: [] };

const dmarcFor = async (domain) => {
  const d = await dmarcOf(domain);
  return d.found === false ? { found: false, add: DMARC_TO_ADD } : d;
};

// The panel. `read(provider, domain)` asks the sender (get, add or check).
const panel = async (read) => {
  const p = activeProvider();
  if (!p) return { provider: null };
  const from = mailFrom();
  const head = { provider: p.key, name: p.name, from: from.raw || null, domain: from.domain || null };
  if (!from.domain) return { ...head, canManage: true, found: false, status: null, records: [], dmarc: null };
  const [at, dmarc] = await Promise.all([
    read(p, from.domain).then((d) => ({ canManage: true, ...d }), (e) => {
      if (e instanceof MailError && e.restricted) return UNREADABLE;
      throw e;
    }),
    dmarcFor(from.domain),
  ]);
  return { ...head, ...at, dmarc };
};

export const api = new Hono();
api.get('/mail/domain', async (c) => {
  if (c.get('ctx').role !== 'manager') return c.json({ error: 'managers only' }, 403);
  try {
    return c.json(await panel((p, domain) => p.domain.get(domain)));
  } catch (e) {
    if (e instanceof MailError) return c.json({ error: e.message }, 502);
    throw e;
  }
});

// What an action's call to the sender answers, or the refusal in plain words.
const ask = async (read) => {
  const p = activeProvider();
  if (!p) throw httpError(409, 'Email isn’t connected yet');
  if (!mailFrom().domain) throw httpError(409, 'Set MAIL_FROM first: its domain is the one to add');
  let out;
  try {
    out = await panel(read);
  } catch (e) {
    if (e instanceof MailError) throw httpError(502, e.message);
    throw e;
  }
  if (!out.canManage) {
    throw httpError(409, `This is a sending-only key: it can’t add or check a domain. Make a full-access key in ${p.name}, or add the domain in ${p.name}’s own screen.`);
  }
  return out;
};

export const actions = {
  'mail.domain.add': {
    roles: MANAGER_ONLY,
    input: z.object({ domain: z.string().trim().toLowerCase().min(3).max(253) }),
    before: async (db, ctx, input) => {
      const { domain } = mailFrom();
      if (domain && input.domain !== domain) throw httpError(400, `Only MAIL_FROM’s own domain (${domain}) can be added here`);
      let added = false;
      const out = await ask(async (p, name) => {
        const have = await p.domain.get(name);
        if (have.found) return have;
        added = true;
        return p.domain.add(name);
      });
      return { out, added };
    },
    // On the log: who added it. Nothing else is kept here.
    handler: async (tx, ctx, input, emit, ready) => {
      if (ready.added) emit('mail_domain', newId(), 'create', { provider: ready.out.provider, domain: ready.out.domain });
      return ready.out;
    },
  },
  'mail.domain.check': {
    roles: MANAGER_ONLY,
    input: z.object({}),
    before: () => ask((p, name) => p.domain.check(name)),
    handler: async (tx, ctx, input, emit, ready) => ready,
  },
};
