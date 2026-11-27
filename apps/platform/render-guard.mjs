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
import { hasValues } from './snippets.mjs';

// Settings the control centre may ask Render about, one at a time, and only
// "is it set?": the value is dropped inside render-api.mjs. None is a secret.
export const READABLE = ['NODE_ENV', 'STARBASE_ENV', 'STARBASE_PUBLIC_URL', 'STARBASE_BRAND', 'STARBASE_ORG_NAME', 'STARBASE_JURISDICTION', 'STARBASE_TZ',
  'STARBASE_CITY', 'STARBASE_SLATES', 'STARBASE_PROVINCE', 'STARBASE_GEO_BOUNDS', 'STARBASE_CANDIDATES', 'BASE_PLATFORM_PUBKEY'];
// Settings the control centre may set, and only to a value it works out
// itself. Today that is base.win's public key and nothing else.
export const WRITABLE = ['BASE_PLATFORM_PUBKEY'];
// Every campaign service has this one, so it tells whether Render lets one
// setting be read alone: if Render says it isn't set, nothing was read.
export const CANARY = 'STARBASE_ENV';

// What a campaign's service should have set, by how the campaign came here.
// A client added as already running was set up by hand: the three settings
// it never had are its own configuration, never "missing".
export const neededFor = (campaign) => {
  if (campaign.kind === 'sample') return ['STARBASE_ENV', 'BASE_PLATFORM_PUBKEY'];
  if (!hasValues(campaign.values)) return [...READABLE.slice(0, 9), 'BASE_PLATFORM_PUBKEY'];
  return [...READABLE];
};
export const writableFor = () => [...WRITABLE];

const PUBKEY_VALUE_RE = /^[A-Za-z0-9_-]{43}(,[A-Za-z0-9_-]{43})*$/;
// The value a setting gets, worked out here from base.win's own key. Null
// when the setting may not be written or there is no usable key. No caller
// ever hands a value in.
export const valueFor = (campaign, key) => {
  if (!writableFor(campaign).includes(key)) return null;
  const value = pubkeyValue();
  return PUBKEY_VALUE_RE.test(value) ? value : null;
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
export const guard = ({ campaign, envRow, health = null, self, svc, db, ownId, phase = 'use' }) => {
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
  if (!envRow.instance) return 'unpinned';
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
