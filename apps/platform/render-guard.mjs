// What the control centre may ask Render about, what it may change there,
// and whether a service in Render is really this campaign's. Pure: no
// database, no network. render-api.mjs runs guard() before every change;
// the pages run it to decide which buttons to show.
//
// The rule behind every list here: nothing secret is ever asked for, no
// value is ever typed, and a setting that already has a value is never
// changed (the one exception is base.win's own public key).
import { publicHost } from './campaigns.mjs';
import { pubkeyValue } from './keys.mjs';
import { hasValues, serviceSettings, JURISDICTIONS, PROVINCES, TIME_ZONES } from './snippets.mjs';
import { settingNames } from '../../shared/old-names.js';

// Settings the control centre may ask Render about, one at a time, and only
// "is it set?": the value is dropped inside render-api.mjs. None is a secret.
// Each is listed by its name today; Render is asked about its older name too
// (shared/old-names.js), and it counts as set when either is.
export const READABLE = ['NODE_ENV', 'BASE_ENV', 'BASE_PUBLIC_URL', 'BASE_BRAND', 'BASE_ORG_NAME', 'BASE_JURISDICTION', 'BASE_TZ',
  'BASE_CITY', 'BASE_SLATES', 'BASE_PROVINCE', 'BASE_GEO_BOUNDS', 'BASE_CANDIDATES', 'BASE_PLATFORM_PUBKEY'];
// Settings the control centre may set, and only to a value it works out
// itself. Today that is base.win's public key and nothing else.
export const WRITABLE = ['BASE_PLATFORM_PUBKEY'];
// Stage 2, once Check Render’s answers has opened it: on a campaign made
// with New campaign, a missing setting may also be added, to the value
// worked out from that campaign's own row (the same as its .env block).
export const WRITABLE_MADE = ['BASE_PLATFORM_PUBKEY', 'BASE_PUBLIC_URL', 'BASE_BRAND', 'BASE_ORG_NAME', 'BASE_CITY', 'BASE_JURISDICTION',
  'BASE_PROVINCE', 'BASE_TZ', 'BASE_SLATES', 'BASE_GEO_BOUNDS', 'BASE_CANDIDATES'];
// Every campaign service has this one, so it tells whether Render lets one
// setting be read alone: if Render says it isn't set, nothing was read.
export const CANARY = 'BASE_ENV';
// Every name Render may be asked about: each readable setting, and its older name.
export const READ_NAMES = READABLE.flatMap(settingNames);

// What a campaign's service should have set, by how the campaign came here.
// A client added as already running was set up by hand: the three settings
// it never had are its own configuration, never "missing".
export const neededFor = (campaign) => {
  if (campaign.kind === 'sample') return ['BASE_ENV', 'BASE_PLATFORM_PUBKEY'];
  if (!hasValues(campaign.values)) return [...READABLE.slice(0, 9), 'BASE_PLATFORM_PUBKEY'];
  return [...READABLE];
};
// A campaign made with New campaign: a client with every value kept here.
// Never the sample, never a campaign added as already running.
export const madeHere = (campaign) => campaign?.kind === 'client' && hasValues(campaign.values);
export const writableFor = (campaign, { stage2 = false } = {}) => (stage2 && madeHere(campaign) ? [...WRITABLE_MADE] : [...WRITABLE]);

const PUBKEY_VALUE_RE = /^[A-Za-z0-9_-]{43}(,[A-Za-z0-9_-]{43})*$/;
// One line of words: 1 to 120 characters, no control characters.
const plain = (v) => typeof v === 'string' && v.length >= 1 && v.length <= 120 && !/[\u0000-\u001f\u007f]/.test(v);
const NUM = '-?\\d{1,3}(?:\\.\\d{1,6})?';
// The two random keys Render makes itself, on a service being made here:
// by their names today only.
const GENERATED = ['BASE_TWO_STEP_KEY', 'GOOGLE_TOKEN_KEY'];
export const mayGenerate = (key) => GENERATED.includes(key);
// What each value must look like, whatever the campaign's row says.
const SHAPE_OK = {
  BASE_PLATFORM_PUBKEY: (v) => PUBKEY_VALUE_RE.test(v),
  BASE_PUBLIC_URL: (v, c) => v === `https://${publicHost(c.name)}`,
  BASE_BRAND: (v) => v === 'base',
  BASE_ORG_NAME: plain,
  BASE_CITY: plain,
  BASE_JURISDICTION: (v) => JURISDICTIONS.includes(v),
  BASE_PROVINCE: (v) => PROVINCES.some((p) => p[0] === v),
  BASE_TZ: (v) => TIME_ZONES.includes(v),
  BASE_SLATES: (v) => /^[a-z_]{1,30}:[^,:\u0000-\u001f]{1,60}(,[a-z_]{1,30}:[^,:\u0000-\u001f]{1,60}){0,9}$/.test(v),
  BASE_GEO_BOUNDS: (v) => new RegExp(`^${NUM},${NUM}\\|${NUM},${NUM}$`).test(v),
  BASE_CANDIDATES: (v) => v === 'none',
  NODE_ENV: (v) => v === 'production',
  BASE_ENV: (v) => v === 'production',
};
// The settings a campaign made here is given, from its own row only, each
// checked against its shape: [{ key, value } | { key, generateValue }].
// Null when there is nothing to make them from or any value is off.
export const settingsFor = (campaign) => {
  if (!madeHere(campaign)) return null;
  const list = serviceSettings({ name: campaign.name, display: campaign.display, values: campaign.values, publicKey: pubkeyValue() });
  for (const e of list) {
    if (e.generateValue) { if (!mayGenerate(e.key)) return null; continue; }
    if (!SHAPE_OK[e.key]?.(e.value, campaign)) return null;
  }
  return list;
};
// The value a setting gets, worked out here: base.win's own key, or (stage
// 2, a campaign made here) the campaign's own value. Null when the setting
// may not be written or its value is off. No caller ever hands a value in.
export const valueFor = (campaign, key, { stage2 = false } = {}) => {
  if (!writableFor(campaign, { stage2 }).includes(key)) return null;
  if (key === 'BASE_PLATFORM_PUBKEY') {
    const value = pubkeyValue();
    return PUBKEY_VALUE_RE.test(value) ? value : null;
  }
  const line = settingsFor(campaign)?.find((e) => e.key === key);
  return line && !line.generateValue ? line.value : null;
};

// ── Making (stage 2): the names a new campaign's service and database get ──
export const makeNames = (name) => ({ service: `base-win-${name}`, database: `base-win-${name}-db` });
const PROTECTED = ['base-win', 'base-win-db', 'base-win-staging', 'base-win-staging-db', 'base-platform', 'base-platform-db'];
// Why a short name can't be made in Render, or null.
export const makeRefusal = (name) => {
  const n = makeNames(name);
  const then = 'Make it by hand (More), or start again with another short name.';
  if (name === 'db' || name.endsWith('-db')) return `The short name ${name} can’t be made in Render: ${n.service} would look like a database’s name. ${then}`;
  if (PROTECTED.includes(n.service) || PROTECTED.includes(n.database)) return `The short name ${name} can’t be made in Render: ${n.service} is kept for base.win. ${then}`;
  return null;
};

// Names nothing here may ever target: the control centre itself.
export const OWN_NAMES = ['base-platform', 'base-platform-db'];
export const STAGING_NAME = 'base-win-staging';
const CLIENT_NAME_RE = /^base-win(-[a-z0-9-]+)?$/;
export const databaseNameFor = (serviceName) => `${serviceName}-db`;
// The branch a client's service deploys from: production, or its own
// production-<name> when it must stay on an older version.
export const clientBranchOk = (branch, name) => branch === 'production' || branch === `production-${name}`;

export const REFUSALS = {
  own: 'This is the control centre’s own service. Nothing here changes it.',
  workspace: 'This service isn’t in base.win’s workspace.',
  repository: 'This service isn’t built from base.win’s repository.',
  type: 'This isn’t a web service in Render.',
  database: 'This isn’t this service’s database in Render.',
  address: 'No service in Render has this campaign’s address: check the address on Edit.',
  two: 'Two services in Render have this address: look in Render.',
  changed: 'Connect again: the service changed in Render since it was connected.',
  unpinned: 'This campaign’s server hasn’t been recognised yet: press Check now on its page first.',
  elsewhere: 'This server says it is somewhere else: check the Render address saved here.',
  staging: 'This is staging’s service. It can’t be a client’s.',
  'not-client': 'This isn’t a campaign’s service in Render.',
  'not-staging': 'The sample connects to staging’s service only.',
  branch: 'This service isn’t on the production branch: look in Render.',
  'staging-branch': 'Staging’s service isn’t on the main branch: look in Render.',
  archived: 'This campaign is archived. Bring it back first.',
  suspended: 'Suspended in Render: resume it there.',
  unread: 'Render’s answer about this service couldn’t be read: press Check Render’s answers.',
};

// Is this service (and, for a database change, this database) the one this
// campaign's changes may go to? → null when it is, or why not: a key of
// REFUSALS. phase 'link' is Connect; 'use' is every later page and change,
// where a service that no longer fits means "connect again".
//   campaign, envRow  the control centre's own rows
//   health            the newest check of the saved Render address (or null)
//   self              render-api's self(): this service's own workspace and repository
//   svc, db           render-api's reduced answers
//   made              stage 2: the service was made here by this campaign's own
//                     make job and hasn't answered yet (no pin to check)
export const guard = ({ campaign, envRow, health = null, self, svc, db, ownId, phase = 'use', made = false }) => {
  const later = (code) => (phase === 'use' ? 'changed' : code);
  if (!svc || !self) return 'unread';
  // 1. Not ourselves.
  if (!ownId || svc.id === ownId || OWN_NAMES.includes(svc.name)) return 'own';
  // 2. Our workspace, our repository.
  if (!self.ownerId || svc.ownerId !== self.ownerId) return 'workspace';
  if (!self.repo || !svc.repo || svc.repo !== self.repo) return 'repository';
  // 3. A web service; a database is the one named after it.
  if (svc.type !== 'web_service') return 'type';
  if (db !== undefined) {
    if (!db || OWN_NAMES.includes(db.name) || db.ownerId !== self.ownerId || db.name !== databaseNameFor(svc.name)) return 'database';
  }
  // 4. This campaign's server.
  if (!envRow?.server_url || !svc.url || svc.url !== envRow.server_url) return later('address');
  if (!envRow.instance && !made) return 'unpinned';
  if (health?.answering && (health.own_origin !== envRow.server_url || health.env_reported !== envRow.env)) return 'elsewhere';
  // 5. The right kind.
  if (campaign.kind === 'sample') {
    if (svc.name !== STAGING_NAME) return 'not-staging';
    if (svc.branch !== 'main') return later('staging-branch');
  } else {
    if (svc.name === STAGING_NAME) return 'staging';
    if (!CLIENT_NAME_RE.test(svc.name)) return 'not-client';
    if (!svc.branch || !clientBranchOk(svc.branch, campaign.name)) return later('branch');
  }
  // 6. Standing.
  if (campaign.archived_at) return 'archived';
  if (svc.suspended === true) return 'suspended';
  if (svc.suspended !== false) return 'unread';
  return null;
};

// The campaign's own address at base.win, as Render lists it.
export const domainFor = (campaign) => (campaign.kind === 'client' ? publicHost(campaign.name) : null);
