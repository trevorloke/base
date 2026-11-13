// Permissions: what each person may do in the app, in one place.
//
// A role is the baseline (manager, treasurer, staff, volunteer — each action
// names the roles that may run it, as before). On top of it a manager can
// grant or deny an AREA — People, Map, Shifts, Money, Signs, Outreach,
// Data, Admin, ImagineU — to a whole role (workspace settings.permissions.roles)
// or to one person (memberships.permissions), under Admin → Permissions.
//
//   decide(perms, area)      false: denied · true: granted · null: the role decides
//   mayRun(ctx, name, action)  the one check for POST /api/actions/:name
//   areaOfPath(path)         a read's area, for the same check on GET
//   areasFor(ctx)            the areas this person has, for the app's tabs
//
// A manager is never denied anything: the one who sets permissions can't lock
// themselves out. A grant lets a volunteer run an area's actions; what a
// volunteer's browser receives about a person (lib/viewer.js) is unchanged.
export const AREAS = [
  { key: 'people', label: 'People', what: 'the directory, profiles, imports' },
  { key: 'map', label: 'Map & turfs', what: 'turfs, walk lists, who canvasses where' },
  { key: 'shifts', label: 'Shifts', what: 'the board, bookings, notices' },
  { key: 'money', label: 'Donations', what: 'gifts, receipts' },
  { key: 'signs', label: 'Signs', what: 'requests, crews, the map of signs' },
  { key: 'outreach', label: 'Outreach', what: 'newsletters, blasts, texts, press, surveys, ladders' },
  { key: 'media', label: 'Media', what: 'press releases, media and influencer contacts' },
  { key: 'data', label: 'Data', what: 'the full export, the event log, records' },
  { key: 'admin', label: 'Admin', what: 'members, teams, permissions, the rating scale' },
  { key: 'learn', label: 'ImagineU', what: 'training: the lessons, their files, who has done what' },
  { key: 'site', label: 'Website', what: 'the public website: its pages, news, petitions and look' },
];
export const AREA_KEYS = AREAS.map((a) => a.key);
// What each role has with nothing granted or denied — the app's tabs.
export const BASE = {
  manager: AREA_KEYS,
  treasurer: ['people', 'map', 'shifts', 'money', 'signs', 'outreach', 'data', 'learn', 'media'],
  staff: ['people', 'map', 'shifts', 'money', 'signs', 'outreach', 'data', 'learn', 'media'],
  volunteer: [],
  // A candidate is a volunteer with a candidate seat (ext/candidates): their
  // own row under Permissions, read through permsOf's 'candidate' key. Their
  // role stays 'volunteer', so this line is only the row's defaults.
  candidate: [],
};

const ACTION_AREA = {
  person: 'people', relationship: 'people', call: 'people', volunteer: 'people', contact: 'people',
  turf: 'map',
  shift: 'shifts',
  place: 'shifts', // places a shift happens at (ext/schedule)
  gift: 'money', receipt: 'money', donor: 'money', membership: 'money',
  payment: 'money', // online payments (ext/payments)
  sign: 'signs',
  blast: 'outreach', survey: 'outreach',
  ladder: 'outreach', text: 'outreach', texting: 'outreach', subscription: 'outreach', script: 'outreach',
  gmail: 'outreach', // one email from your own Gmail (ext/gmail); gmail.settings is manager-only, so Admin
  member: 'admin', team: 'admin', permission: 'admin', workspace: 'admin', scale: 'admin', field: 'admin',
  bank: 'people', list: 'people',
  pass: 'map',
  vote: 'people',
  request: 'people',
  mainstreet: 'people',
  learn: 'learn',
  site: 'site',
  share: 'outreach', // share kits (ext/socials/share.js)
  media: 'media', // press releases and their contacts (ext/media)
};
// field.values.set is a person's record; field.ping ("I'm here", from the
// map) is nobody's area — anyone who canvasses may say where they are; nor
// is share.me, everyone's own link to share.
export const areaOfAction = (name) => {
  if (name === 'field.values.set') return 'people';
  if (name === 'field.ping' || name === 'learn.done' || name === 'person.details' || name === 'share.me') return null;
  return ACTION_AREA[String(name).split('.')[0]] || null;
};

const PATH_AREA = [
  [/^\/api\/(records|export|events|audit|reports)(\/|$)/, 'data'],
  [/^\/api\/data\/(import|export)/, 'data'],
  [/^\/api\/(gifts|receipts|money|cap|stewardship|membership)(\/|$)/, 'money'],
  [/^\/api\/payments(\/|$)/, 'money'],
  [/^\/api\/persons\/[^/]+\/membership$/, 'money'],
  [/^\/api\/(blasts|surveys|ladders|subscriptions|texting|inbox)(\/|$)/, 'outreach'],
  [/^\/api\/gmail(\/|$)/, 'outreach'],
  [/^\/api\/share\/(kits|top)(\/|$)/, 'outreach'], // GET /api/share (your own link) is no area
  [/^\/api\/shifts(\/|$)/, 'shifts'],
  [/^\/api\/signs(\/|$)/, 'signs'],
  [/^\/api\/turfs(\/|$)/, 'map'],
  [/^\/api\/(team|admin|invites)(\/|$)/, 'admin'],
  [/^\/api\/candidates(\/|$)/, 'admin'],
  // Call time's pledges are the treasurer's; a candidate's own call time
  // (/calltime/:bankId) is no area's — it answers its candidate alone.
  [/^\/api\/calltime\/(pledges|seats)$/, 'money'],
  [/^\/api\/fields(\/|$)/, 'admin'],
  [/^\/api\/learn\/progress$/, 'learn'],
  [/^\/api\/(banks|lists)(\/|$)/, 'people'],
  [/^\/api\/callhub(\/|$)/, 'people'],
  [/^\/api\/persons(\/|$)/, 'people'],
  // Other people's ties; My people (/relationships/mine) is in no area on purpose.
  [/^\/api\/relationships\/(key|connected)(\/|$)/, 'people'],
  [/^\/api\/duplicates$/, 'people'],
  [/^\/api\/passes(\/|$)/, 'map'],
  [/^\/api\/voted(\/|$)/, 'people'],
  [/^\/api\/requests(\/|$)/, 'people'],
  [/^\/api\/field-report/, 'data'],
  [/^\/api\/pathtowin(\/|$)/, 'data'],
  [/^\/api\/shiftturfs(\/|$)/, 'shifts'],
  [/^\/api\/(crew|volunteers)(\/|$)/, 'shifts'],
  [/^\/api\/(places|schedule)(\/|$)/, 'shifts'],
  [/^\/api\/connections(\/|$)/, 'admin'],
  [/^\/api\/intake(\/|$)/, 'admin'],
  [/^\/api\/site(\/|$)/, 'site'],
  [/^\/api\/media(\/|$)/, 'media'],
];
export const areaOfPath = (path) => PATH_AREA.find(([re]) => re.test(path))?.[1] || null;

const list = (v) => (Array.isArray(v) ? v.filter((k) => AREA_KEYS.includes(k)) : []);
// The grants and denies that apply to one person: the role's, then their own
// (a person's grant lifts the role's deny and the other way round).
export const permsOf = (role, wsSettings, memberPerms) => {
  if (role === 'manager') return { grant: new Set(), deny: new Set() };
  const r = wsSettings?.permissions?.roles?.[role] || {};
  const m = memberPerms || {};
  const grant = new Set(list(r.grant)); const deny = new Set(list(r.deny));
  for (const k of list(m.grant)) { grant.add(k); deny.delete(k); }
  for (const k of list(m.deny)) { deny.add(k); grant.delete(k); }
  return { grant, deny };
};
export const decide = (perms, area) => {
  if (!area || !perms) return null;
  if (perms.deny.has(area)) return false;
  if (perms.grant.has(area)) return true;
  return null;
};
// A manager-only action (a campaign-wide switch such as Election day or the
// texting hours) is the Admin area's, whatever its name says: granting
// People or Outreach lets someone work in that area, not change its settings.
// An action that names its area (action.area, e.g. the Website's) is that
// area's, manager-only or not: granting the area lets someone run it.
const managerOnly = (action) => !action.area && action.roles.length === 1 && action.roles[0] === 'manager';
export const mayRun = (ctx, name, action) => {
  const d = decide(ctx.perms, action.area || (managerOnly(action) ? 'admin' : areaOfAction(name)));
  if (d === false) return false;
  if (action.roles.includes(ctx.role)) return true;
  return d === true;
};
export const areasFor = (ctx) => AREA_KEYS.filter((k) => {
  const d = decide(ctx.perms, k);
  return d === null ? (BASE[ctx.role] || []).includes(k) : d;
});
