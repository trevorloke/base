// The map's check, for managers: GET /api/map/check.
//
// A map can look empty for several unrelated reasons — people never placed,
// a placing run that stopped, a list that mostly lives outside the campaign's
// area, a street map that isn't answering, a page older than the server. One
// answer (and, on the map's Show sheet, one screenshot of it) says which:
//
//   people   { total, onMap, waiting, noAddress } — on file; with a pin;
//            an address but no pin yet; neither. Nobody is placed by
//            guessing: a person with no address stays off the map and is
//            counted here — not one the team marked Address unknown
//            (ext/moves): that case is settled, not work still to do.
//   area     { box: [south, west, north, east], inside, outside } — of those
//            on the map, how many are inside the campaign's own box
//            (STARBASE_GEO_BOUNDS)
//   turfs    how many
//   placing  the background run (ext/geocoding status), and off: address
//            lookup is turned off (GEOCODER=off)
//   tiles    { source, custom, ignored, clean, cartoKey } — which street map the
//            server names (ext/offline), never its whole address
//   build    the web build this server hands out (lib/build.js); commit
//
// GET /api/map/check/services (managers): whether the services behind the
// map answer, asked live — on its own, so the check above still answers at
// once while this one waits on Google (8 s at most; each answer kept 30 s):
//   tiles   { provider, viaServer, probe, last, lastOkAt } — probe only for
//           Google (through this server); a provider the phones reach
//           straight is judged by the page's own tile count
//   lookup  { provider, fallback, probe } — the map's pins
//   suggest { provider, probe, paused } — address suggestions: Google Places
//           (probed whenever ADDRESS_SUGGEST=google and a key is set) or the
//           pins' own service
// Never a key or a tile address.
//
// What only the browser knows (whether tiles loaded, the page's own build,
// the map's size on screen) the page adds itself.
import { Hono } from 'hono';
import { geoBox } from '../../lib/org.js';
import { currentBuild } from '../../lib/build.js';
import { status as placingStatus } from '../geocoding/index.js';
import { tileConfig, tileSource, TILE_DEFAULTS, cartoView } from '../offline/index.js';
import { googleTilesOn, probeTiles, tilesHealth } from '../../lib/gtiles.js';
import { probeLookup } from '../../lib/geocode.js';
import { googleKey } from '../../lib/gtiles.js';
import { addressSuggester, probePlaces, placesHealth } from '../../lib/places.js';

export const api = new Hono();

api.get('/map/check', async (c) => {
  const ctx = c.get('ctx');
  if (ctx.role !== 'manager') return c.json({ error: 'the map check is for managers' }, 403);
  const db = c.get('db');
  const ws = ctx.workspaceId;
  const p = (await db.query(
    `select count(*)::int as total,
            count(*) filter (where lat is not null and lng is not null)::int as on_map,
            count(*) filter (where lat is null and address is not null)::int as waiting,
            count(*) filter (where lat is null and address is null and address_status is null)::int as no_address
     from persons where workspace_id = $1 and deleted_at is null`,
    [ws],
  )).rows[0];
  const box = geoBox();
  const inside = (await db.query(
    `select count(*)::int as n from persons
     where workspace_id = $1 and deleted_at is null and lat between $2 and $4 and lng between $3 and $5`,
    [ws, ...box],
  )).rows[0].n;
  const turfs = (await db.query('select count(*)::int as n from turfs where workspace_id = $1 and deleted_at is null', [ws])).rows[0].n;
  const t = tileConfig();
  return c.json({
    people: { total: p.total, onMap: p.on_map, waiting: p.waiting, noAddress: p.no_address },
    area: { box, inside, outside: Math.max(0, p.on_map - inside) },
    turfs,
    placing: { ...(await placingStatus(db, ws)), off: (process.env.GEOCODER || '').toLowerCase() === 'off' },
    tiles: {
      source: tileSource(t.url), custom: t.url !== TILE_DEFAULTS.url, ignored: t.ignored,
      // The Clean look (CARTO's tiles) is offered beside the standard ones —
      // only with the campaign's CARTO key (said apart: never the key itself).
      clean: t.url === TILE_DEFAULTS.url && Boolean(cartoView()),
      cartoKey: Boolean(String(process.env.STARBASE_TILE_CARTO_KEY ?? '').trim()),
    },
    build: currentBuild(),
    commit: String(process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || '').slice(0, 7) || null,
  });
});

// GEOCODER=google is retired (Google no longer places pins): B.C. places them.
const LOOKUP_NAMES = { bc: 'BC Address Geocoder', nominatim: 'Nominatim', off: 'off' };
const lookupName = (v) => LOOKUP_NAMES[String(v || '').trim().toLowerCase()] || null;
api.get('/map/check/services', async (c) => {
  if (c.get('ctx').role !== 'manager') return c.json({ error: 'the map check is for managers' }, 403);
  const google = googleTilesOn();
  const places = addressSuggester() === 'google' && Boolean(googleKey());
  const [tilesProbe, lookupProbe, placesProbe] = await Promise.all([google ? probeTiles() : null, probeLookup(), places ? probePlaces() : null]);
  const paused = placesHealth().paused;
  const { last, lastOkAt } = tilesHealth();
  const recent = (t) => (t ? { at: new Date(t.at).toISOString(), code: t.code, plain: t.plain, said: t.said, fix: t.step || null, status: t.status } : null);
  return c.json({
    tiles: {
      provider: tileSource(tileConfig().url),
      viaServer: google,
      probe: tilesProbe,
      last: google ? recent(last) : null,
      lastOkAt: google && lastOkAt ? new Date(lastOkAt).toISOString() : null,
    },
    lookup: {
      provider: lookupName(process.env.GEOCODER || 'bc') || 'BC Address Geocoder',
      fallback: lookupName(process.env.GEOCODER_FALLBACK),
      probe: lookupProbe,
    },
    suggest: places
      ? { provider: 'Google Places', probe: placesProbe, paused: paused ? { until: paused.until, code: paused.code, plain: paused.plain, said: paused.said, fix: paused.step || null } : null }
      : { provider: lookupName(addressSuggester() === 'off' ? 'off' : addressSuggester()) || 'BC Address Geocoder', probe: lookupProbe, paused: null },
  });
});
