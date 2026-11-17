// The voter guide's writes (VG decisions 5–8). Every one is a Website
// action (siteAction: managers, or whoever a manager grants the Website),
// bumps vote_guide.rev in the same transaction (the field's "anything
// new?") and clears the campaign's cached pages once it commits. Publish,
// unpublish, clear and the embed addresses are a manager's alone.
//
//   site.guide.save          { title?, official_url?, official_label?, vote_anywhere?, ballot_note?,
//                              rules?, mail?, ride_phone?, wait_url?, banner? }
//   site.guide.days          { days: [{ day, kind, opens, closes }] }   the whole list
//   site.guide.place.save    { id?, name, address, city?, lat?, lng?, area?, days, accessible?,
//                              curbside?, note?, closed?, closed_note? }  closed: today only
//   site.guide.place.delete  { id }   site.guide.place.restore { id }
//   site.guide.places.order  { ids }
//   site.guide.places.import { rows, replace, token }   rows as the preview signed them
//   site.guide.ballot        { contests: [{ office, vote_for, names: [{ name, ours? }] }] }
//   site.guide.check         { section, checked }
//   site.guide.publish       { gotv_days? }   site.guide.unpublish {}   site.guide.clear {}
//   site.guide.embed         { origins }
//   site.guide.page          {}   a draft page "Voter guide" holding the module
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { httpError } from '../../actions/util.js';
import { newId, canonical } from '../../lib/events.js';
import { now } from '../../lib/clock.js';
import { localDay } from '../../lib/tzrule.js';
import { normWords, normAddress } from '../../../shared/voteguide.js';
import { authorizedBy } from '../../../shared/site/wording.js';
import { siteAction, actions as siteActions } from '../site/actions.js';
import { readSettings, isAppHost } from '../site/store.js';
import { verify } from '../site/tokens.js';
import { saveVotingDays } from '../voted/actions.js';
import { readRows, buildGuide, tzOf, checklist, deskState, RULE_KEYS, SECTIONS, forgetGuide } from './read.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const text = (max) => z.string().trim().max(max);
// Links are checked in the handler, so the refusal is these words alone.
const httpsUrl = z.string().trim().max(500);
const HTTPS = /^https:\/\/[^\s"'<>\\]+$/i;
const day = z.string().regex(DAY, 'a date like 2030-10-19').refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s, 'a date like 2030-10-19');
const hm = z.string().regex(HM, 'a time like 08:00');
const MAX_PLACES = 300;
const MANAGER_WORDS = 'Only a manager can do this';

// A guide write: the guide's row exists (and is locked), the handler runs,
// rev goes up by one.
const guideAction = (input, handler, { manager = false } = {}) => siteAction(input, async (tx, ctx, data, emit) => {
  if (manager && ctx.role !== 'manager') throw httpError(403, MANAGER_WORDS);
  const ws = ctx.workspaceId;
  await tx.query('insert into vote_guide (workspace_id) values ($1) on conflict (workspace_id) do nothing', [ws]);
  const g = (await tx.query('select * from vote_guide where workspace_id = $1 for update', [ws])).rows[0];
  const out = await handler(tx, ctx, data, emit, g);
  await tx.query('update vote_guide set rev = rev + 1 where workspace_id = $1', [ws]);
  forgetGuide(ws);
  return out;
});

const today = (ctx) => localDay(now(), tzOf(ctx.workspace));
const listedDays = async (tx, ws) => (await tx.query(
  "select to_char(day, 'YYYY-MM-DD') as day, kind, opens, closes from vote_days where workspace_id = $1 and deleted_at is null order by day", [ws],
)).rows;

// ── Where a place is used: Shifts (and GOTV, which extends this) ──
export const placeInUse = async (tx, ws, id) => Boolean((await tx.query(
  'select 1 from shifts where workspace_id = $1 and place_id = $2 and deleted_at is null limit 1', [ws, id],
)).rows[0]);

// Out of the guide (decision 1): the places row goes too unless Shifts or
// GOTV use it — then it stays, still a voting place, with no guide row.
// → { kept }
const removeFromGuide = async (tx, ws, id, emit) => {
  const info = (await tx.query('select * from vote_place_info where place_id = $1 and workspace_id = $2', [id, ws])).rows[0];
  if (await placeInUse(tx, ws, id)) {
    await tx.query('delete from vote_place_info where place_id = $1 and workspace_id = $2', [id, ws]);
    emit('vote_place', id, 'void', { kept: true, info: info ? infoOut(info) : null });
    return { kept: true };
  }
  await tx.query('update places set deleted_at = now() where id = $1 and workspace_id = $2 and deleted_at is null', [id, ws]);
  emit('place', id, 'void', {});
  emit('vote_place', id, 'void', { kept: false });
  return { kept: false };
};
const infoOut = (r) => ({
  city: r.city, pin: r.pin, area: r.area, days: typeof r.days === 'string' ? JSON.parse(r.days) : r.days, accessible: r.accessible, curbside: r.curbside,
  note: r.note, closed_note: r.closed_note, external_id: r.external_id, position: r.position,
});

// ── One place: checked, matched to the places list, written ──
const placeInput = z.object({
  id: z.uuid().optional(),
  name: text(120).min(1, 'Give the place a name'),
  address: text(200).min(1, 'Add its address'),
  city: text(80).optional(),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  area: text(60).optional(),
  days: z.array(z.object({ day, opens: hm.optional(), closes: hm.optional() })).max(30).default([]),
  accessible: z.boolean().nullish(),
  curbside: z.boolean().nullish(),
  note: text(200).optional(),
  closed: z.boolean().optional(),
  closed_note: text(200).optional(),
}).refine((v) => (v.lat == null) === (v.lng == null), 'A pin is a latitude and a longitude');

const daysProblem = (days) => {
  const seen = new Set();
  for (const d of days) {
    if (seen.has(d.day)) return 'A day is there twice';
    seen.add(d.day);
    if (d.opens && d.closes && d.closes <= d.opens) return 'Closing time must be after opening time';
  }
  return null;
};
const sameDays = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);
const cleanDays = (days) => [...days].sort((x, y) => x.day.localeCompare(y.day)).map((d) => ({ day: d.day, ...(d.opens ? { opens: d.opens } : {}), ...(d.closes ? { closes: d.closes } : {}) }));

// Write one guide place. `pin`: 'lookup' | 'hand' | undefined (as it is).
// → { id, created, changed: [fields] }
const writePlace = async (tx, ctx, emit, g, p, { pin } = {}) => {
  const ws = ctx.workspaceId;
  const published = g.status === 'published';
  let row = p.id ? (await tx.query('select * from places where id = $1 and workspace_id = $2 and deleted_at is null', [p.id, ws])).rows[0] : null;
  if (p.id && !row) throw httpError(404, 'That place is gone — reload');
  // The places list keeps one name per campaign, however it's capitalised.
  const clash = (await tx.query(
    `select * from places where workspace_id = $1 and deleted_at is null and lower(trim(name)) = lower($2) and ($3::uuid is null or id <> $3::uuid) limit 1`,
    [ws, p.name, row?.id || null],
  )).rows[0];
  if (clash) {
    if (row || normAddress(clash.address) !== normAddress(p.address)) throw httpError(400, 'A place with this name is already at another address');
    row = clash; // the same place, already in Shifts or GOTV: it becomes a voting place
  }
  const info = row ? (await tx.query(
    "select *, to_char(closed_on, 'YYYY-MM-DD') as closed_day from vote_place_info where place_id = $1 and workspace_id = $2", [row.id, ws],
  )).rows[0] : null;
  if (!info) {
    const n = (await tx.query(
      'select count(*)::int as n from vote_place_info i join places p on p.id = i.place_id where i.workspace_id = $1 and p.deleted_at is null', [ws],
    )).rows[0].n;
    if (n >= MAX_PLACES) throw httpError(400, `${MAX_PLACES} voting places is the most`);
  }
  const days = cleanDays(p.days || []);
  const dp = daysProblem(days);
  if (dp) throw httpError(400, dp);
  const pinGiven = p.lat !== undefined;
  const lat = pinGiven ? (p.lat ?? null) : (row ? row.lat : null);
  const lng = pinGiven ? (p.lng ?? null) : (row ? row.lng : null);
  const pinKind = pinGiven ? (lat == null ? null : (pin || 'hand')) : (info?.pin ?? (lat != null ? 'hand' : null));
  const closedOn = p.closed === undefined ? (info?.closed_day || null) : p.closed ? today(ctx) : null;
  const next = {
    name: p.name, address: p.address, city: p.city ?? info?.city ?? '', area: p.area ?? info?.area ?? '',
    days, accessible: p.accessible === undefined ? (info?.accessible ?? null) : p.accessible,
    curbside: p.curbside === undefined ? (info?.curbside ?? null) : p.curbside,
    note: p.note ?? info?.note ?? '', closed_on: closedOn, closed_note: p.closed_note ?? info?.closed_note ?? '',
  };
  const before = row ? {
    name: row.name, address: row.address || '', days: info ? (typeof info.days === 'string' ? JSON.parse(info.days) : info.days) : [],
    closed_on: info?.closed_day || null, note: info?.note || '',
  } : null;
  const watched = ['name', 'address', 'days', 'closed_on', 'note'];
  const changed = before ? watched.filter((k) => (k === 'days' ? !sameDays(before.days, next.days) : (before[k] ?? null) !== (next[k] ?? null))) : [];
  const id = row?.id || newId();
  if (row) {
    await tx.query(
      "update places set name = $3, address = $4, lat = $5, lng = $6, kind = 'voting' where id = $1 and workspace_id = $2",
      [id, ws, next.name, next.address, lat, lng],
    );
    emit('place', id, 'update', { name: next.name, address: next.address, lat, lng, kind: 'voting' });
  } else {
    await tx.query(
      "insert into places (id, workspace_id, name, lat, lng, address, source, created_by, kind) values ($1, $2, $3, $4, $5, $6, 'typed', $7, 'voting')",
      [id, ws, next.name, lat, lng, next.address, ctx.user?.id || null],
    );
    emit('place', id, 'create', { id, name: next.name, address: next.address, lat, lng, source: 'typed', kind: 'voting' });
  }
  const position = info ? info.position : (await tx.query(
    'select coalesce(max(position), -1) + 1 as n from vote_place_info where workspace_id = $1', [ws],
  )).rows[0].n;
  const stamp = published && info && changed.length;
  await tx.query(
    `insert into vote_place_info (place_id, workspace_id, city, pin, area, days, accessible, curbside, note, closed_on, closed_note, external_id, position, changed_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, null, now())
     on conflict (place_id) do update set city = excluded.city, pin = excluded.pin, area = excluded.area, days = excluded.days,
       accessible = excluded.accessible, curbside = excluded.curbside, note = excluded.note, closed_on = excluded.closed_on,
       closed_note = excluded.closed_note, external_id = coalesce(excluded.external_id, vote_place_info.external_id),
       changed_at = case when $14 then $15::timestamptz else vote_place_info.changed_at end, updated_at = now()`,
    // "Changed 2:14 p.m." is the campaign's clock (lib/clock.js), the one its day is read by.
    [id, ws, next.city, pinKind, next.area, JSON.stringify(next.days), next.accessible, next.curbside, next.note, next.closed_on, next.closed_note,
      p.external_id || null, position, Boolean(stamp), new Date(now()).toISOString()],
  );
  const payload = { name: next.name, address: next.address, city: next.city, area: next.area, days: next.days, accessible: next.accessible, curbside: next.curbside, note: next.note, closed_on: next.closed_on, closed_note: next.closed_note, pin: pinKind };
  if (stamp) {
    payload.before = Object.fromEntries(changed.map((k) => [k, before[k]]));
    payload.after = Object.fromEntries(changed.map((k) => [k, next[k]]));
  }
  emit('vote_place', id, info ? 'update' : 'create', payload);
  return { id, created: !row, adopted: Boolean(row && !info && !p.id), changed };
};

// The candidates' names as the ballot matches them: lowercase, accents and
// punctuation dropped, "SURNAME, Given" read as "Given Surname".
export const ballotName = (s) => {
  const t = String(s ?? '').trim();
  const m = /^([^,]+),\s*(.+)$/.exec(t);
  return normWords(m ? `${m[2]} ${m[1]}` : t);
};

const previewHash = (rows) => createHash('sha256').update(canonical(rows)).digest('base64url');
export { previewHash };

const ORIGIN = /^(https:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?)$/i;

export const actions = {
  'site.guide.save': guideAction(z.object({
    title: text(120).optional(),
    official_url: httpsUrl.optional(),
    official_label: text(120).optional(),
    vote_anywhere: z.boolean().nullable().optional(),
    ballot_note: text(300).optional(),
    rules: z.object(Object.fromEntries(RULE_KEYS.map((k) => [k, text(1200).optional()]))).strict().optional(),
    mail: z.object({ request_by: day.nullable().optional(), url: httpsUrl.optional() }).strict().optional(),
    ride_phone: z.string().trim().max(40).optional(),
    wait_url: httpsUrl.optional(),
    banner: z.boolean().optional(),
  }).strict(), async (tx, ctx, input, emit, g) => {
    const ws = ctx.workspaceId;
    for (const u of [input.official_url, input.wait_url, input.mail?.url]) if (u && !HTTPS.test(u)) throw httpError(400, 'Use a link that starts with https://');
    if (input.ride_phone && !/^[\d +()-]{7,20}$/.test(input.ride_phone)) throw httpError(400, 'A phone number: 7 to 20 digits, spaces and + ( ) -');
    const rules = { ...(typeof g.rules === 'string' ? JSON.parse(g.rules) : g.rules || {}), ...(input.rules || {}) };
    const mail = { ...(typeof g.mail === 'string' ? JSON.parse(g.mail) : g.mail || {}), ...(input.mail || {}) };
    const set = (k, v, fallback) => (v === undefined ? fallback : v);
    const next = {
      title: set('title', input.title, g.title), official_url: set('o', input.official_url, g.official_url), official_label: set('l', input.official_label, g.official_label),
      vote_anywhere: input.vote_anywhere === undefined ? g.vote_anywhere : input.vote_anywhere,
      ballot_note: set('b', input.ballot_note, g.ballot_note), ride_phone: set('r', input.ride_phone, g.ride_phone), wait_url: set('w', input.wait_url, g.wait_url),
      banner: set('n', input.banner, g.banner),
    };
    // A draft from the start: something is entered.
    const status = g.status === 'not_out' ? 'draft' : g.status;
    await tx.query(
      `update vote_guide set title = $2, official_url = $3, official_label = $4, vote_anywhere = $5, ballot_note = $6, rules = $7, mail = $8,
         ride_phone = $9, wait_url = $10, banner = $11, status = $12, updated_at = now() where workspace_id = $1`,
      [ws, next.title, next.official_url, next.official_label, next.vote_anywhere, next.ballot_note, JSON.stringify(rules), JSON.stringify(mail),
        next.ride_phone, next.wait_url, next.banner, status],
    );
    emit('vote_guide', ws, 'update', { ...input });
    return { ok: true };
  }),

  'site.guide.days': guideAction(z.object({
    days: z.array(z.object({ day, kind: z.enum(['advance', 'general']), opens: hm, closes: hm })).max(60),
  }).strict(), async (tx, ctx, input, emit, g) => {
    const ws = ctx.workspaceId;
    if (input.days.length > 30) throw httpError(400, '30 days is the most');
    const seen = new Set();
    for (const d of input.days) {
      if (seen.has(d.day)) throw httpError(400, 'Two rows have the same day');
      seen.add(d.day);
      if (d.closes <= d.opens) throw httpError(400, 'Closing time must be after opening time');
    }
    const had = (await tx.query(
      "select id, to_char(day, 'YYYY-MM-DD') as day, kind, opens, closes from vote_days where workspace_id = $1 and deleted_at is null", [ws],
    )).rows;
    for (const old of had.filter((h) => !seen.has(h.day))) {
      await tx.query('update vote_days set deleted_at = now() where id = $1', [old.id]);
      emit('vote_day', old.id, 'void', { day: old.day });
    }
    for (const d of input.days) {
      const old = had.find((h) => h.day === d.day);
      if (old) {
        if (old.kind === d.kind && old.opens === d.opens && old.closes === d.closes) continue;
        await tx.query('update vote_days set kind = $2, opens = $3, closes = $4, updated_at = now() where id = $1', [old.id, d.kind, d.opens, d.closes]);
        emit('vote_day', old.id, 'update', d);
      } else {
        const id = newId();
        await tx.query('insert into vote_days (id, workspace_id, day, kind, opens, closes) values ($1, $2, $3, $4, $5, $6)', [id, ws, d.day, d.kind, d.opens, d.closes]);
        emit('vote_day', id, 'create', d);
      }
    }
    if (g.status === 'not_out') await tx.query("update vote_guide set status = 'draft' where workspace_id = $1", [ws]);
    return { days: input.days.length };
  }),

  'site.guide.place.save': guideAction(placeInput, async (tx, ctx, input, emit, g) => {
    const { closed, ...p } = input;
    const out = await writePlace(tx, ctx, emit, g, { ...p, closed });
    if (g.status === 'not_out') await tx.query("update vote_guide set status = 'draft' where workspace_id = $1", [ctx.workspaceId]);
    return { place: { id: out.id }, created: out.created, adopted: out.adopted };
  }),

  'site.guide.place.delete': guideAction(z.object({ id: z.uuid() }).strict(), async (tx, ctx, input, emit) => {
    const ws = ctx.workspaceId;
    const there = (await tx.query(
      'select 1 from vote_place_info i join places p on p.id = i.place_id where i.place_id = $1 and i.workspace_id = $2 and p.deleted_at is null', [input.id, ws],
    )).rows[0];
    if (!there) throw httpError(404, 'That place isn’t in the guide — reload');
    const { kept } = await removeFromGuide(tx, ws, input.id, emit);
    return { id: input.id, kept };
  }),

  'site.guide.place.restore': guideAction(z.object({ id: z.uuid() }).strict(), async (tx, ctx, input, emit) => {
    const ws = ctx.workspaceId;
    const row = (await tx.query('select * from places where id = $1 and workspace_id = $2', [input.id, ws])).rows[0];
    if (!row) throw httpError(404, 'That place is gone');
    if (row.deleted_at) {
      if ((await tx.query('select 1 from places where workspace_id = $1 and deleted_at is null and lower(trim(name)) = lower(trim($2)) and id <> $3', [ws, row.name, row.id])).rows[0]) {
        throw httpError(409, 'Another place has that name now — rename it first');
      }
      await tx.query('update places set deleted_at = null where id = $1', [row.id]);
      emit('place', row.id, 'restore', {});
    }
    const info = (await tx.query('select 1 from vote_place_info where place_id = $1', [row.id])).rows[0];
    if (!info) {
      // Kept for Shifts or GOTV when it left the guide: its facts come back
      // from the removal's own event.
      const ev = (await tx.query(
        "select payload from events where workspace_id = $1 and entity_type = 'vote_place' and entity_id = $2 and op = 'void' order by seq desc limit 1", [ws, row.id],
      )).rows[0];
      const was = (typeof ev?.payload === 'string' ? JSON.parse(ev.payload) : ev?.payload)?.info || {};
      await tx.query(
        `insert into vote_place_info (place_id, workspace_id, city, pin, area, days, accessible, curbside, note, closed_note, external_id, position)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [row.id, ws, was.city || '', was.pin || null, was.area || '', JSON.stringify(was.days || []), was.accessible ?? null, was.curbside ?? null,
          was.note || '', was.closed_note || '', was.external_id || null, Number(was.position) || 0],
      );
    }
    await tx.query("update places set kind = 'voting' where id = $1", [row.id]);
    emit('vote_place', row.id, 'restore', {});
    return { id: row.id };
  }),

  'site.guide.places.order': guideAction(z.object({ ids: z.array(z.uuid()).max(MAX_PLACES) }).strict(), async (tx, ctx, input, emit) => {
    const ws = ctx.workspaceId;
    for (const [i, id] of input.ids.entries()) {
      await tx.query('update vote_place_info set position = $3 where place_id = $1 and workspace_id = $2', [id, ws, i]);
    }
    emit('vote_guide', ws, 'update', { order: input.ids });
    return { ok: true };
  }),

  // Rows as the preview answered them (api.js), with its token: the pins
  // were looked up there, outside any transaction; nothing is looked up here.
  'site.guide.places.import': guideAction(z.object({
    rows: z.array(z.any()).max(MAX_PLACES),
    replace: z.boolean().default(false),
    token: z.string().max(4000),
  }).strict(), async (tx, ctx, input, emit, g) => {
    const ws = ctx.workspaceId;
    const claims = await verify('vg-import', input.token);
    if (!claims || claims.w !== ws || claims.u !== ctx.user?.id || claims.h !== previewHash(input.rows)) {
      throw httpError(400, 'This preview is out of date — preview again');
    }
    const keep = [];
    let added = 0; let updated = 0;
    for (const [i, r] of input.rows.entries()) {
      if (r?.status === 'Problem') continue;
      const parsed = placeInput.safeParse({
        id: r.place_id || undefined, name: r.name, address: r.address, city: r.city || '', area: r.area || '', note: r.note || '',
        accessible: r.accessible ?? null, curbside: r.curbside ?? null, days: (r.days || []).map((d) => ({ day: d })),
        lat: r.lat ?? null, lng: r.lng ?? null,
      });
      if (!parsed.success) throw httpError(400, `Row ${r.line || i + 1}: ${parsed.error.issues[0]?.message || 'check it'}`);
      const out = await writePlace(tx, ctx, emit, g, { ...parsed.data, external_id: r.external_id || null }, { pin: r.lat == null ? null : (r.pin === 'hand' ? 'hand' : 'lookup') })
        .catch((e) => { throw httpError(e.status || 400, `Row ${r.line || i + 1}: ${e.message}`); });
      keep.push(out.id);
      if (out.created || out.adopted) added += 1; else if (out.changed.length) updated += 1;
    }
    let removed = 0;
    if (input.replace) {
      const others = (await tx.query(
        'select i.place_id from vote_place_info i join places p on p.id = i.place_id where i.workspace_id = $1 and p.deleted_at is null and not (i.place_id = any($2::uuid[]))',
        [ws, keep],
      )).rows;
      for (const o of others) { await removeFromGuide(tx, ws, o.place_id, emit); removed += 1; }
    }
    if (g.status === 'not_out') await tx.query("update vote_guide set status = 'draft' where workspace_id = $1", [ws]);
    return { added, updated, removed };
  }),

  'site.guide.ballot': guideAction(z.object({
    contests: z.array(z.object({
      office: text(80).min(1, 'Name the office'),
      vote_for: z.number().int().min(1, 'Vote for at least 1').max(20, 'Vote for at most 20'),
      names: z.array(z.object({ name: text(80).min(1), ours: z.boolean().optional() }).passthrough()).max(120, '120 names is the most'),
    })).max(6, '6 offices is the most'),
  }).strict(), async (tx, ctx, input, emit) => {
    const ws = ctx.workspaceId;
    const slate = (await tx.query('select id, name from candidates where workspace_id = $1 and removed_at is null', [ws])).rows
      .map((c) => ({ id: c.id, key: ballotName(c.name) }));
    for (const old of (await tx.query('select id from vote_contests where workspace_id = $1 and deleted_at is null', [ws])).rows) {
      await tx.query('update vote_contests set deleted_at = now() where id = $1', [old.id]);
      emit('vote_contest', old.id, 'void', {});
    }
    const out = [];
    for (const [i, c] of input.contests.entries()) {
      // The slate's names link by themselves; input never names a candidate.
      const names = c.names.map((n) => {
        const hit = slate.find((s) => s.key && s.key === ballotName(n.name));
        return { name: n.name, ours: hit ? n.ours !== false : n.ours === true, candidate_id: hit?.id || null };
      });
      const id = newId();
      await tx.query('insert into vote_contests (id, workspace_id, office, vote_for, names, position) values ($1, $2, $3, $4, $5, $6)',
        [id, ws, c.office, c.vote_for, JSON.stringify(names), i]);
      emit('vote_contest', id, 'create', { office: c.office, vote_for: c.vote_for, names });
      out.push({ id, office: c.office, vote_for: c.vote_for, names });
    }
    return { contests: out };
  }),

  'site.guide.check': guideAction(z.object({ section: z.enum(SECTIONS), checked: z.boolean() }).strict(), async (tx, ctx, input, emit, g) => {
    const ws = ctx.workspaceId;
    const checked = { ...(typeof g.checked === 'string' ? JSON.parse(g.checked) : g.checked || {}) };
    if (input.checked) checked[input.section] = { on: today(ctx), at: new Date().toISOString(), by: ctx.user?.id || null, by_name: ctx.user?.name || '' };
    else delete checked[input.section];
    await tx.query('update vote_guide set checked = $2 where workspace_id = $1', [ws, JSON.stringify(checked)]);
    emit('vote_guide', ws, 'update', { check: input.section, checked: input.checked });
    return { checked: checked[input.section] || null };
  }),

  'site.guide.publish': guideAction(z.object({ gotv_days: z.boolean().optional() }).strict(), async (tx, ctx, input, emit) => {
    const ws = ctx.workspaceId;
    const guide = buildGuide(await readRows(tx, ws), tzOf(ctx.workspace));
    const settings = await readSettings(tx, ws);
    const list = checklist(guide, authorizedBy(settings?.org || {}), now());
    const missing = list.find((c) => !c.done);
    if (missing) throw httpError(400, missing.words);
    await tx.query("update vote_guide set status = 'published', published_at = now(), published_by = $2 where workspace_id = $1", [ws, ctx.user?.id || null]);
    emit('vote_guide', ws, 'update', { status: 'published' });
    let gotv = null;
    if (input.gotv_days) {
      const general = guide.days.filter((d) => d.kind === 'general');
      gotv = await saveVotingDays(tx, ctx, {
        advance_days: guide.days.filter((d) => d.kind === 'advance').map((d) => d.day),
        election_day: general.at(-1).day,
      }, emit);
    }
    return { status: 'published', gotv };
  }, { manager: true }),

  'site.guide.unpublish': guideAction(z.object({}).strict(), async (tx, ctx, input, emit, g) => {
    if (g.status !== 'published') return { status: g.status };
    await tx.query("update vote_guide set status = 'draft' where workspace_id = $1", [ctx.workspaceId]);
    emit('vote_guide', ctx.workspaceId, 'update', { status: 'draft' });
    return { status: 'draft' };
  }, { manager: true }),

  'site.guide.clear': guideAction(z.object({}).strict(), async (tx, ctx, input, emit) => {
    const ws = ctx.workspaceId;
    const guide = buildGuide(await readRows(tx, ws), tzOf(ctx.workspace));
    if (guide.status === 'published' && deskState(guide, now()) !== 'over') throw httpError(400, 'Unpublish it first');
    const days = (await tx.query('update vote_days set deleted_at = now() where workspace_id = $1 and deleted_at is null returning id', [ws])).rows;
    for (const d of days) emit('vote_day', d.id, 'void', {});
    const contests = (await tx.query('update vote_contests set deleted_at = now() where workspace_id = $1 and deleted_at is null returning id', [ws])).rows;
    for (const c of contests) emit('vote_contest', c.id, 'void', {});
    let kept = 0;
    for (const p of guide.places) if ((await removeFromGuide(tx, ws, p.id, emit)).kept) kept += 1;
    await tx.query(
      `update vote_guide set status = 'not_out', title = '', vote_anywhere = null, ballot_note = '', checked = '{}', mail = '{}', wait_url = '',
         published_at = null, published_by = null, updated_at = now() where workspace_id = $1`, [ws],
    );
    const counts = { days: days.length, places: guide.places.length, kept, contests: contests.length };
    emit('vote_guide', ws, 'update', { cleared: counts });
    return counts;
  }, { manager: true }),

  'site.guide.embed': guideAction(z.object({ origins: z.array(z.string().trim().max(300)).max(20) }).strict(), async (tx, ctx, input, emit) => {
    const ws = ctx.workspaceId;
    const origins = [...new Set(input.origins.map((o) => o.replace(/\/+$/, '').toLowerCase()).filter(Boolean))];
    if (origins.length > 5) throw httpError(400, '5 addresses is the most');
    for (const o of origins) {
      if (!ORIGIN.test(o)) throw httpError(400, 'Use the website’s address, like https://www.example.ca');
      const host = new URL(o).hostname;
      if (isAppHost(host)) throw httpError(400, 'That’s base.win itself');
    }
    await tx.query('update vote_guide set embed_origins = $2 where workspace_id = $1', [ws, JSON.stringify(origins)]);
    emit('vote_guide', ws, 'update', { embed_origins: origins });
    return { origins };
  }, { manager: true }),

  // "Add the guide page" (decision 20): a draft, voter-guide (or -2 …).
  'site.guide.page': guideAction(z.object({}).strict(), async (tx, ctx, input, emit) => {
    const ws = ctx.workspaceId;
    let slug = 'voter-guide';
    for (let n = 2; (await tx.query('select 1 from site_pages where workspace_id = $1 and slug = $2 and site_id is null and deleted_at is null', [ws, slug])).rows[0]; n += 1) slug = `voter-guide-${n}`;
    const create = siteActions['site.page.create'].handler;
    return create(tx, ctx, { title: 'Voter guide', slug, modules: [{ id: `vg-${newId().slice(0, 8)}`, kind: 'voterguide', hidden: false, props: {} }] }, emit);
  }),
};
