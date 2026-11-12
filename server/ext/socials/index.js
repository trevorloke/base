// Social media handles that are right, visible and findable.
//
//   person.social.set     { id, platform?, value }  a pasted link or @handle,
//       read by shared/socials.js parseSocial (platform: the network the
//       screen picked for a bare @name). Refused in the parser's words (400,
//       field 'value'). Answers { person, also } — also: { id, name } of
//       someone else on the list with the same handle there, or null.
//       Nothing is merged.
//   person.social.remove  { id, platform }
//   person.followers.set  { id, platform, followers: int | null }  typed in
//       from their public profile, for a handle on file; null takes it off.
//
// person.update's socials are left as they were (an old cached page re-sends
// every stored value on each save, and refusing an old value would block it):
// the events hook below keeps the counts honest whatever wrote the handles.
// The person's area (People) decides who may run these, as every person.*.
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { campaignDay } from '../../lib/gifts.js';
import { DEFAULT_TZ } from '../../lib/org.js';
import { forViewer } from '../../lib/viewer.js';
import { PLATFORMS, parseSocial, sameHandle } from '@starbase/shared/socials';

export { sql } from './sql.js';

const ROLES = ['manager', 'staff', 'treasurer'];
const MAX_FOLLOWERS = 100_000_000;
const parseJ = (v, d) => (typeof v === 'string' ? JSON.parse(v) : (v ?? d));
const todayFor = (ctx) => campaignDay(new Date(), ctx.workspace?.settings?.tz || DEFAULT_TZ);
const bad = (message, field) => Object.assign(httpError(400, message), { field });

// The counts still true: an entry stays only while its handle is on file.
export const keptReach = (socials, reach) => {
  const out = {};
  for (const [p, e] of Object.entries(reach || {})) {
    if (e && Number.isInteger(e.n) && sameHandle(socials?.[p], e.h)) out[p] = e;
  }
  return out;
};
export const mostOf = (reach) => {
  const ns = Object.values(reach || {}).map((e) => e.n).filter(Number.isInteger);
  return ns.length ? Math.max(...ns) : null;
};
const reachJson = (reach) => (Object.keys(reach).length ? JSON.stringify(reach) : null);

const livePerson = async (tx, ws, id) => {
  const p = (await tx.query(
    'select id, name, socials, social_reach, followers from persons where id = $1 and workspace_id = $2 and deleted_at is null for update',
    [id, ws],
  )).rows[0];
  if (!p) throw httpError(404, 'person not found');
  return { ...p, socials: parseJ(p.socials, {}) || {}, social_reach: parseJ(p.social_reach, {}) || {} };
};
const out = (ctx, p) => ({
  person: forViewer(ctx)({ id: p.id, name: p.name, socials: p.socials, social_reach: p.social_reach, followers: p.followers ?? null }),
});
const writeSocials = async (tx, ctx, p, socials, emit) => {
  await tx.query('update persons set socials = $3, updated_at = now() where id = $1 and workspace_id = $2',
    [p.id, ctx.workspaceId, JSON.stringify(socials)]);
  emit('person', p.id, 'update', { socials });
};

// Someone else on the list with the same account on that network.
const alsoOn = async (tx, ws, id, platform, handle) => {
  const key = String(handle).trim().replace(/^@/, '').replace(/\/+$/, '').toLowerCase();
  const rows = (await tx.query(
    `select id, name, socials ->> $3 as h from persons
      where workspace_id = $1 and deleted_at is null and id <> $2 and socials ? $3
        and lower(regexp_replace(regexp_replace(trim(socials ->> $3), '^@', ''), '/+$', '')) = $4
      order by created_at limit 5`,
    [ws, id, platform, key],
  )).rows;
  const hit = rows.find((r) => sameHandle(r.h, handle));
  return hit ? { id: hit.id, name: hit.name } : null;
};

const platform = z.enum(PLATFORMS);
export const actions = {
  'person.social.set': {
    roles: ROLES,
    input: z.object({ id: z.uuid(), platform: platform.optional(), value: z.string().max(300) }),
    handler: async (tx, ctx, input, emit) => {
      const r = parseSocial(input.value, input.platform);
      if (r.error) throw bad(r.error, 'value');
      const p = await livePerson(tx, ctx.workspaceId, input.id);
      const socials = { ...p.socials, [r.platform]: r.handle };
      await writeSocials(tx, ctx, p, socials, emit);
      const now = await livePerson(tx, ctx.workspaceId, input.id);
      return { ...out(ctx, now), platform: r.platform, also: await alsoOn(tx, ctx.workspaceId, p.id, r.platform, r.handle) };
    },
  },

  'person.social.remove': {
    roles: ROLES,
    input: z.object({ id: z.uuid(), platform }),
    handler: async (tx, ctx, input, emit) => {
      const p = await livePerson(tx, ctx.workspaceId, input.id);
      if (!(input.platform in p.socials)) return out(ctx, p);
      const socials = { ...p.socials };
      delete socials[input.platform];
      await writeSocials(tx, ctx, p, socials, emit);
      return out(ctx, await livePerson(tx, ctx.workspaceId, input.id));
    },
  },

  'person.followers.set': {
    roles: ROLES,
    input: z.object({ id: z.uuid(), platform, followers: z.number().int().min(0).max(MAX_FOLLOWERS).nullable() }),
    handler: async (tx, ctx, input, emit) => {
      const p = await livePerson(tx, ctx.workspaceId, input.id);
      const h = p.socials[input.platform];
      if (typeof h !== 'string' || !h.trim()) throw bad('Add the handle first', 'platform');
      const reach = keptReach(p.socials, p.social_reach);
      if (input.followers == null) delete reach[input.platform];
      else reach[input.platform] = { n: input.followers, at: todayFor(ctx), by: 'typed', h };
      const followers = mostOf(reach);
      await tx.query('update persons set social_reach = $3, followers = $4, updated_at = now() where id = $1 and workspace_id = $2',
        [p.id, ctx.workspaceId, reachJson(reach), followers]);
      emit('person', p.id, 'update', { social_reach: reach, followers });
      return out(ctx, { ...p, social_reach: reach, followers });
    },
  },
};

// Whatever wrote a person's handles (these actions, an old page's
// person.update, the import), a count typed for a handle that is no longer
// on file goes with it. A changed largest count is said in the log once.
const events = async (tx, meta, evs) => {
  const ids = [...new Set(evs.filter((e) => e.entityType === 'person' && e.payload && 'socials' in e.payload).map((e) => e.entityId))];
  if (!ids.length) return;
  const rows = (await tx.query(
    `select id, socials, social_reach, followers from persons
      where workspace_id = $1 and id = any($2::uuid[]) and social_reach is not null`,
    [meta.workspaceId, ids],
  )).rows;
  for (const r of rows) {
    const reach = parseJ(r.social_reach, {}) || {};
    const kept = keptReach(parseJ(r.socials, {}) || {}, reach);
    if (Object.keys(kept).length === Object.keys(reach).length) continue;
    const followers = mostOf(kept);
    await tx.query('update persons set social_reach = $3, followers = $4 where id = $1 and workspace_id = $2',
      [r.id, meta.workspaceId, reachJson(kept), followers]);
    if (followers !== (r.followers ?? null)) meta.emit('person', r.id, 'update', { followers });
  }
};

// Two records made one: per network, the count typed for the handle the
// kept record ends up with (keep's own handle stands; drop's fills a gap);
// typed on both for that handle, the newer.
const personMerging = async (tx, ctx, { keep, drop }) => {
  const kr = parseJ(keep.social_reach, {}) || {};
  const dr = parseJ(drop.social_reach, {}) || {};
  if (!Object.keys(kr).length && !Object.keys(dr).length) return;
  const socials = { ...(parseJ(drop.socials, {}) || {}), ...(parseJ(keep.socials, {}) || {}) };
  const reach = {};
  for (const p of new Set([...Object.keys(kr), ...Object.keys(dr)])) {
    const pick = [kr[p], dr[p]].filter((e) => e && sameHandle(socials[p], e.h))
      .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))[0];
    if (pick) reach[p] = pick;
  }
  const kept = keptReach(socials, reach);
  await tx.query('update persons set social_reach = $3, followers = $4 where id = $1 and workspace_id = $2',
    [keep.id, ctx.workspaceId, reachJson(kept), mostOf(kept)]);
};

export const hooks = { events, personMerging };
