// "Authorized by …" for the desk: one answer every screen reads instead of
// its own check (shared/site/authorized.js is the rule).
//
//   GET /api/site/authorized   any signed-in role (a volunteer's first text
//       carries the line, so their composer counts it). No secrets.
//       { en, byLang: { pa: … }, status: 'set'|'partial'|'empty', from,
//         required, warn: null|{ level, gap, from }, daysLeft,
//         automaticMissing, channels: [{ id, kind, include, owner, what }] }
//       and, for a manager or treasurer only (receipts' AGENT_ROLES):
//       receiptsDiffer, receipts: { name, contact, tooLong } | null.
//   site.authorized.fromReceipts   "Use that here": copies the receipts'
//       financial agent into Website → Settings. receipt_settings is only
//       read, never changed; nothing saved is moved or deleted.
import { z } from 'zod';
import { CHANNELS, CHANNEL_IDS, authorizedLine, neededFrom } from '../../../shared/site/authorized.js';
import { authorizedFor } from '../../lib/authorized.js';
import { httpError } from '../../actions/util.js';
import { AGENT_ROLES } from '../receipts/core.js';
import { readSettings } from './store.js';

// The website's boxes (shape.js org.agentName, org.agentContact).
export const SITE_MAX = { name: 80, contact: 120 };
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

const receiptsOf = async (q, ws) => {
  try {
    const r = (await q.query('select agent_name, agent_contact from receipt_settings where workspace_id = $1', [ws])).rows[0];
    const name = clean(r?.agent_name);
    const contact = clean(r?.agent_contact);
    if (!name && !contact) return null;
    return { name, contact, tooLong: name.length > SITE_MAX.name || contact.length > SITE_MAX.contact };
  } catch { return null; }
};
// Both set and different, or only receipts has one.
const differs = (org, rec) => {
  if (!rec) return false;
  const name = clean(org?.agentName);
  const contact = clean(org?.agentContact);
  if (!name && !contact) return true;
  return name !== rec.name || contact !== rec.contact;
};

// Automatic emails and texts that went without the line since its date
// (ladders, the A/B winner's rest: events with auth_missing and no person).
const automaticMissing = async (q, ws, from) => {
  if (!from) return 0;
  try {
    return (await q.query(
      `select count(*)::int as n from events where workspace_id = $1 and actor_id is null
         and payload @> '{"auth_missing": true}'::jsonb and server_ts >= $2::date`, [ws, from],
    )).rows[0].n;
  } catch { return 0; }
};

// Mounted before the Website area's guard: every role reads it.
export const mountAuthorized = (api) => {
  api.get('/site/authorized', async (c) => {
    const ctx = c.get('ctx');
    const db = c.get('db');
    const { org, legal, tz } = await authorizedFor(db, ctx.workspaceId);
    const a = authorizedLine(org, { channel: 'site', tz });
    const byLang = Object.fromEntries(Object.keys(legal).map((lang) => [lang, authorizedLine(org, { channel: 'site', lang, legal, tz }).local?.text]).filter(([, t]) => t));
    const need = neededFrom(org, new Date(), tz);
    const out = {
      en: a.en, byLang, tz: tz || 'America/Vancouver', status: a.status, from: need.from, required: a.required, warn: a.warn, daysLeft: need.daysLeft,
      automaticMissing: await automaticMissing(db, ctx.workspaceId, need.level === 'due' ? need.from : null),
      channels: CHANNEL_IDS.map((id) => ({ id, kind: CHANNELS[id].kind, include: CHANNELS[id].include, owner: CHANNELS[id].owner, what: CHANNELS[id].what })),
    };
    if (AGENT_ROLES.includes(ctx.role)) {
      const rec = await receiptsOf(db, ctx.workspaceId);
      out.receiptsDiffer = differs(org, rec);
      out.receipts = rec;
    }
    return c.json(out);
  });
};

export const authorizedActions = (siteAction) => ({
  'site.authorized.fromReceipts': siteAction(z.object({}), async (tx, ctx, input, emit) => {
    const ws = ctx.workspaceId;
    const rec = await receiptsOf(tx, ws);
    if (!rec?.name) throw httpError(400, 'Your receipts don’t name a financial agent');
    if (rec.tooLong) throw httpError(400, 'Too long to copy — shorten it under Website → Settings');
    const settings = await readSettings(tx, ws);
    const org = { ...(settings?.org || {}), agentName: rec.name, agentContact: rec.contact };
    await tx.query('update site_settings set org = $2, updated_at = now() where workspace_id = $1', [ws, JSON.stringify(org)]);
    emit('site_settings', ws, 'update', { org: { agentName: rec.name, agentContact: rec.contact }, from: 'receipts' });
    return { org: { agentName: rec.name, agentContact: rec.contact } };
  }),
});
