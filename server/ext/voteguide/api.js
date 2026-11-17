// The voter guide's reads (VG):
//   GET  /guide?rev=n[&draft=1]       every signed-in role: the published
//        guide for the field app, { same: true, now } when rev is unchanged,
//        { rev, now, status: 'not_out' } when not published. Staff with the
//        Website may add draft=1 (the desk's "See it as a canvasser").
//   GET  /site/guide                  the Website area: everything, drafts
//        included, with the checklist and what the desk shows beside it
//   POST /site/guide/import/preview   the Website area: { text } → the rows
//        with their status and pins, and a token the save takes (a read:
//        the addresses are looked up here, outside any transaction)
import { Hono } from 'hono';
import { now } from '../../lib/clock.js';
import { areasFor } from '../../lib/perms.js';
import { basePath } from '../../lib/mount.js';
import { city as orgCity, geoBox } from '../../lib/org.js';
import { geocodeAddress } from '../../lib/geocode.js';
import { parsePlaces, normWords, normAddress } from '../../../shared/voteguide.js';
import { authorizedBy } from '../../../shared/site/wording.js';
import { LANG_BY_CODE } from '../../../shared/site/languages.js';
import { readSettings, mainAddress } from '../site/store.js';
import { languagesFor } from '../site/translate.js';
import { sign } from '../site/tokens.js';
import { guideFor, publicGuide, withNow, checklist, deskState, changedSinceChecked } from './read.js';
import { previewHash } from './actions.js';

export const api = new Hono();

// The public guide page's address in each language the website offers.
export const guideLinks = async (db, ws, guide, fallbackRoot) => {
  const page = guide.pages.find((p) => !p.site_id);
  if (!page) return {};
  const settings = await readSettings(db, ws.id);
  const root = mainAddress(settings, fallbackRoot).replace(/\/+$/, '');
  const path = page.slug === 'home' ? '/' : `/${page.slug}`;
  const out = { en: `${root}${path}` };
  const { offered } = await languagesFor(db, ws, settings || {});
  for (const code of offered) out[code] = `${root}${LANG_BY_CODE[code].path}${path}`;
  return out;
};
// One language's guide address (REP's printed list may carry it later).
export const guideLink = async (db, ws, lang = 'en', fallbackRoot = '') => {
  const links = await guideLinks(db, ws, await guideFor(db, ws), fallbackRoot);
  return links[lang] || links.en || null;
};

const siteRoot = (c) => `${new URL(c.req.url).origin}${basePath()}/site`;

api.get('/guide', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const ws = { ...(ctx.workspace || {}), id: ctx.workspaceId };
  c.header('Cache-Control', 'no-store');
  const guide = await guideFor(db, ws);
  const t = now();
  const draft = c.req.query('draft') === '1' && areasFor(ctx).includes('site');
  const rev = c.req.query('rev');
  if (rev !== undefined && rev !== '' && Number(rev) === guide.rev && !draft) return c.json({ same: true, rev: guide.rev, now: t });
  if (guide.status !== 'published' && !draft) return c.json({ rev: guide.rev, now: t, status: 'not_out' });
  const g = publicGuide(guide, t, { draft });
  const { page: _p, pageModule: _m, banner: _b, ...rest } = g;
  return c.json({ ...rest, links: await guideLinks(db, ws, guide, siteRoot(c)) });
});

api.get('/site/guide', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const ws = { ...(ctx.workspace || {}), id: ctx.workspaceId };
  const t = now();
  const guide = withNow(await guideFor(db, ws), t);
  const settings = await readSettings(db, ws.id);
  const asked = (await db.query(
    "select count(distinct person_id)::int as n from site_actions where workspace_id = $1 and kind = 'newsletter' and source = 'voter-guide'", [ws.id],
  )).rows[0].n;
  const gotv = (await db.query('select election_day, advance_days from voted_settings where workspace_id = $1', [ws.id])).rows[0];
  const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);
  const { rawDays: _r, ...g } = guide;
  return c.json({
    guide: { ...g, places: g.places.map(({ own_days: own, ...p }) => ({ ...p, own_days: own })) },
    state: deskState(guide, t),
    checklist: checklist(guide, authorizedBy(settings?.org || {}), t),
    changed_since_checked: changedSinceChecked(guide),
    asked,
    pages: guide.pages.map((p) => ({ id: p.id, path: p.slug === 'home' ? '/' : `/${p.slug}`, site_id: p.site_id })),
    site: mainAddress(settings, siteRoot(c)),
    gotv: {
      election_day: gotv?.election_day ? (gotv.election_day instanceof Date ? gotv.election_day.toISOString().slice(0, 10) : String(gotv.election_day).slice(0, 10)) : null,
      advance_days: parse(gotv?.advance_days),
    },
    gotv_only: guide.gotvOnly,
    lookup: String(process.env.GEOCODER || 'bc').toLowerCase() === 'off' ? 'off' : 'on',
  });
});

// ── The import's preview ──
const LOOKUP_MS = 5000;
const PREVIEW_MS = 60_000;
const AT_ONCE = 4;
const KM = 10;
// The campaign's box (STARBASE_GEO_BOUNDS), grown by 10 km on every side.
export const inFence = (lat, lng) => {
  const [s, w, n, e] = geoBox();
  const dLat = KM / 111;
  const dLng = KM / (111 * Math.cos(((s + n) / 2) * Math.PI / 180));
  return lat >= s - dLat && lat <= n + dLat && lng >= w - dLng && lng <= e + dLng;
};
const lookupOff = () => String(process.env.GEOCODER || 'bc').trim().toLowerCase() === 'off';
const withLimit = (p, ms) => Promise.race([p, new Promise((resolve) => { setTimeout(() => resolve({ error: 'timeout' }), ms).unref?.(); })]);

// → { lat, lng } | { none: reason }
const lookUp = async (address, city, deadline) => {
  if (Date.now() >= deadline) return { none: 'Not looked up — the list took too long' };
  const r = await withLimit(geocodeAddress({ address, city: city || orgCity() }).catch(() => ({ error: 'failed' })), Math.min(LOOKUP_MS, deadline - Date.now()));
  if (!r || r.error || r.weak || !Number.isFinite(Number(r.lat))) return { none: 'Address not found' };
  if (!inFence(Number(r.lat), Number(r.lng))) return { none: 'Looked up outside the campaign’s area' };
  return { lat: Number(r.lat), lng: Number(r.lng) };
};

const FIELDS = ['name', 'address', 'city', 'days', 'accessible', 'curbside', 'area', 'note'];
const FIELD_WORDS = { name: 'name', address: 'address', city: 'city', days: 'days', accessible: 'accessible', curbside: 'curbside', area: 'area', note: 'note' };

api.post('/site/guide/import/preview', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const ws = { ...(ctx.workspace || {}), id: ctx.workspaceId };
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Send the list as text' }, 400); }
  const text = String(body?.text ?? '');
  if (!text.trim()) return c.json({ error: 'Paste the list first' }, 400);
  if (text.length > 200_000) return c.json({ error: 'That list is too long — 200 KB is the most' }, 400);
  const guide = await guideFor(db, ws);
  const listed = guide.days.map((d) => ({ day: d.day, kind: d.kind }));
  const parsed = parsePlaces(text, listed);
  if (parsed.error) return c.json({ error: parsed.error }, 400);
  const everyDay = listed.map((d) => d.day);
  const mine = guide.places;
  const others = (await db.query(
    `select p.id, p.name, p.address, p.lat, p.lng from places p where p.workspace_id = $1 and p.deleted_at is null
        and not exists (select 1 from vote_place_info i where i.place_id = p.id)`, [ws.id],
  )).rows;
  const key = (p) => `${normWords(p.name)}|${normAddress(p.address)}`;
  const used = new Set();
  const names = new Map();
  const rows = parsed.rows.map((r) => {
    const out = { ...r, days: r.days || everyDay, status: 'New', changes: [], reason: '', place_id: null, lat: null, lng: null, pin: null, on_map: false };
    if (r.problem) return { ...out, status: 'Problem', reason: r.problem };
    const nm = normWords(r.name);
    if (names.has(nm)) return { ...out, status: 'Problem', reason: 'This name is in the list twice' };
    names.set(nm, true);
    const hit = (r.external_id && mine.find((p) => p.external_id && p.external_id === r.external_id))
      || mine.find((p) => key(p) === key(r))
      || mine.find((p) => normAddress(p.address) === normAddress(r.address) && !used.has(p.id));
    if (hit && used.has(hit.id)) return { ...out, status: 'Problem', reason: 'Two rows are the same place' };
    if (hit) {
      used.add(hit.id);
      const was = {
        name: hit.name, address: hit.address, city: hit.city, days: hit.own_days.map((d) => d.day).sort(), accessible: hit.accessible,
        curbside: hit.curbside, area: hit.area, note: hit.note,
      };
      const now2 = { name: r.name, address: r.address, city: r.city || hit.city, days: out.days, accessible: r.accessible ?? hit.accessible, curbside: r.curbside ?? hit.curbside, area: r.area || hit.area, note: r.note || hit.note };
      const changes = FIELDS.filter((f) => JSON.stringify(was[f] ?? null) !== JSON.stringify(now2[f] ?? null)).map((f) => FIELD_WORDS[f]);
      const sameAddress = normAddress(hit.address) === normAddress(r.address);
      return {
        ...out, ...now2, place_id: hit.id, status: changes.length ? 'Changed' : 'Same', changes,
        lat: sameAddress ? hit.lat : null, lng: sameAddress ? hit.lng : null, pin: sameAddress ? hit.pin : null, lookup: !sameAddress || hit.lat == null,
      };
    }
    // A place already in Shifts (or GOTV) with this name and address.
    const shift = others.find((p) => key(p) === key(r));
    if (shift) {
      return { ...out, place_id: shift.id, reason: 'Uses the place already in Shifts', lat: shift.lat == null ? null : Number(shift.lat), lng: shift.lng == null ? null : Number(shift.lng), pin: shift.lat == null ? null : 'hand', lookup: shift.lat == null };
    }
    const clash = [...others, ...mine].find((p) => normWords(p.name) === nm);
    if (clash) return { ...out, status: 'Problem', reason: 'A place with this name is already at another address' };
    return { ...out, lookup: true };
  });

  // The new and moved addresses, looked up 4 at a time (none with GEOCODER=off).
  const off = lookupOff();
  const deadline = Date.now() + PREVIEW_MS;
  const todo = rows.filter((r) => r.lookup && r.status !== 'Problem');
  if (!off) {
    let i = 0;
    const worker = async () => {
      while (i < todo.length) {
        const r = todo[i]; i += 1;
        const got = await lookUp(r.address, r.city, deadline);
        if (got.none) { r.lat = null; r.lng = null; r.pin = null; r.reason = r.reason || got.none; } else { r.lat = got.lat; r.lng = got.lng; r.pin = 'lookup'; }
      }
    };
    await Promise.all(Array.from({ length: AT_ONCE }, worker));
  } else {
    for (const r of todo) { r.lat = null; r.lng = null; r.pin = null; }
  }
  for (const r of rows) { r.on_map = r.lat != null; delete r.lookup; delete r.problem; }
  const notInList = mine.filter((p) => !used.has(p.id)).map((p) => ({ id: p.id, name: p.name, address: p.address }));
  const count = (s) => rows.filter((r) => r.status === s).length;
  const counts = {
    new: count('New'), changed: count('Changed'), same: count('Same'),
    not_on_map: rows.filter((r) => r.status !== 'Problem' && !r.on_map).length, problem: count('Problem'), not_in_list: notInList.length,
  };
  const token = await sign('vg-import', { w: ws.id, u: ctx.user?.id || null, h: previewHash(rows) }, 30 * 60);
  return c.json({ rows, counts, not_in_list: notInList, token, lookup: off ? 'off' : 'on', places: mine.length, header: parsed.header });
});
