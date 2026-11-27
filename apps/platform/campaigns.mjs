// Campaigns and their environments: what is saved for each (its Render
// address, the pinned instance), what the last checks said, the chips that
// show what's wrong, and whether a desk may be opened.
import { cfg } from './config.mjs';
import { currentKid } from './keys.mjs';
import { appendLog } from './log.mjs';
import { pickValues } from './snippets.mjs';

// A short name is the first part of the campaign's address (<name>.base.win):
// letters, numbers and dashes, no dash at either end.
export const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
// Names base.win keeps for itself (apps/door/door.mjs has the same list; a test checks).
export const RESERVED = ['ops', 'hub', 'api', 'admin', 'platform', '_ops', '_hooks', 'www', 'door', 'status', 'help', 'mail', 'app', 'desk', 'field', 'site', 'login', 'assets', 'sample', 'staging', 'demo'];
export const NAME_HELP = 'Use letters, numbers and dashes. It’s the address: <name>.base.win.';

// A client's own address, as the owner reads it and as the poller asks it.
export const publicHost = (name) => `${name}.base.win`;
export const publicAddress = (name) => cfg().publicTemplate.replace('{name}', name);

// A pasted Render address → its origin (lowercased, no default port, no
// path), or null. https only; http://127.0.0.1 or localhost in tests only.
export const normalizeOrigin = (x, { allowLocal = cfg().allowLocal } = {}) => {
  let u;
  try { u = new URL(String(x || '').trim()); } catch { return null; }
  if (u.username || u.password) return null;
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !(allowLocal && local && u.protocol === 'http:')) return null;
  return u.origin.toLowerCase();
};

// The environment a campaign has: a client's production, the sample's staging.
export const envOf = (campaign) => (campaign.kind === 'sample' ? 'staging' : 'production');

export const getCampaign = async (db, name) => (await db.query('select * from campaigns where name = $1', [name])).rows[0] || null;
export const getEnv = async (db, name, env) => (await db.query('select * from environments where campaign = $1 and env = $2', [name, env])).rows[0] || null;

// The newest check of each kind for every environment: { 'name/env/via': row }.
export const latestChecks = async (db) => {
  const rows = (await db.query(`select distinct on (campaign, env, via) * from checks
    order by campaign, env, via, at desc`)).rows;
  return new Map(rows.map((r) => [`${r.campaign}/${r.env}/${r.via}`, r]));
};

// Since when a server hasn't answered: the first of its latest run of failed checks.
export const downSince = async (db, name, env) => (await db.query(`select min(at) as since from checks
  where campaign = $1 and env = $2 and via = 'server' and not answering
    and at > coalesce((select max(at) from checks where campaign = $1 and env = $2 and via = 'server' and answering), '-infinity')`,
[name, env])).rows[0]?.since || null;

// The production commit deployed last: the one that first appeared most recently.
export const newestCommit = async (db) => (await db.query(`select commit, min(at) as first from checks
  where env = 'production' and via = 'server' and answering and commit is not null
  group by commit order by first desc limit 1`)).rows[0]?.commit || null;

// The owner's midnight (Vancouver), for "today".
export const startOfToday = (now = new Date()) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offset = localAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day) - offset);
};

// Answered checks today, and the last 24 hours hour by hour (oldest first):
// 'ok' (every check answered), 'some' (some didn't), 'down' (none did), 'none' (no check).
export const history = async (db, name, env, now = new Date()) => {
  const today = (await db.query(`select count(*)::int as total, count(*) filter (where answering)::int as answered
    from checks where campaign = $1 and env = $2 and via = 'server' and at >= $3`, [name, env, startOfToday(now)])).rows[0];
  const hours = (await db.query(`select floor(extract(epoch from ($3::timestamptz - at)) / 3600)::int as ago,
      count(*)::int as total, count(*) filter (where answering)::int as answered
    from checks where campaign = $1 and env = $2 and via = 'server' and at > $3::timestamptz - interval '24 hours'
    group by 1`, [name, env, now])).rows;
  const byAgo = new Map(hours.map((h) => [Number(h.ago), h]));
  const strip = Array.from({ length: 24 }, (_, i) => {
    const h = byAgo.get(23 - i);
    if (!h) return 'none';
    return h.answered === h.total ? 'ok' : h.answered ? 'some' : 'down';
  });
  return { answered: today.answered, total: today.total, strip };
};

const kidsOf = (check) => (Array.isArray(check?.platform_kids) ? check.platform_kids : []);

// A campaign server that has the control centre's side always says how
// ready it is for base.win sign-in (health entry) and where it is. One that
// answers as a campaign server and says neither is on a release from before
// it: no setting there will help, only a newer release.
export const oldRelease = (server) => Boolean(server?.answering) && server.entry == null && server.own_origin == null && server.database != null;

// What base.win sign-in looks like there: 'ready' | 'not-set-up' | 'wrong-key' |
// 'old-release' | null (no answer).
export const entryState = (server, kid = currentKid()) => {
  if (!server?.answering) return null;
  if (oldRelease(server)) return 'old-release';
  if (server.entry !== 'ready') return 'not-set-up';
  return kid && kidsOf(server).includes(kid) ? 'ready' : 'wrong-key';
};

// Why a desk can't be opened, or null when it can (§4.3; the campaign
// server checks everything again itself).
export const openBlock = (campaign, envRow, server, kid = currentKid()) => {
  if (campaign.archived_at) return 'archived';
  if (!envRow?.server_url) return 'no-address';
  if (!server) return 'not-checked';
  if (!server.answering) return 'not-answering';
  if (oldRelease(server)) return 'old-release';
  if (server.own_origin !== envRow.server_url || server.env_reported !== envRow.env) return 'elsewhere';
  if (!envRow.instance) return server.instance ? 'elsewhere' : 'not-checked';
  if (server.instance !== envRow.instance) return 'changed';
  const entry = entryState(server, kid);
  if (entry !== 'ready') return entry;
  return null;
};

// Does <name>.base.win reach this campaign's server? 'not-checked' |
// 'not-answering' | 'answering' (the pinned instance) | 'elsewhere' (a
// different instance) | 'unknown' (it answers, but it can't be told: no
// instance pinned yet; or the answer names none, as from an older release
// or a server whose database is down; or it is the same server as at the
// Render address, changed since it was pinned, which "Server changed" says).
export const publicState = ({ envRow, server = null, pub }) => {
  if (!pub) return 'not-checked';
  if (!pub.answering) return 'not-answering';
  if (!envRow.instance || !pub.instance) return 'unknown';
  if (pub.instance === envRow.instance) return 'answering';
  return server?.answering && server.instance === pub.instance ? 'unknown' : 'elsewhere';
};

// A commit as the pages show it.
export const shortCommit = (commit) => String(commit || '').slice(0, 7);

// The chips, only those that are true. (pub: the newest check of the
// client's own address; newest: the production commit deployed last;
// staging: the commit the sample's staging server is on.)
export const chipsFor = ({ campaign, envRow, server, pub, newest, staging = null, kid = currentKid() }) => {
  const out = [];
  if (!server?.answering) return out;
  const client = campaign.kind === 'client';
  if (server.database !== 'ok') out.push('Database not reachable');
  if (server.store === 'embedded') out.push('Not on a real database');
  if (client && server.setup_open === true && server.campaign_made === false) out.push('Sign-up is open to anyone');
  if (server.tz_current === false) out.push('Time zone data old');
  const entry = entryState(server, kid);
  if (entry === 'old-release') out.push('On a release from before base.win sign-in');
  if (entry === 'not-set-up') out.push('base.win sign-in not set up');
  if (entry === 'wrong-key') out.push('Key in Render is wrong: copy base.win’s key again');
  // An older release doesn't say where it is: that is not "somewhere else".
  if (entry !== 'old-release') {
    if (server.own_origin !== envRow.server_url || server.env_reported !== envRow.env) out.push('This server says it is somewhere else');
    else if (envRow.instance && server.instance !== envRow.instance) out.push('Server changed: confirm it');
    else if (!envRow.instance && server.instance) out.push('This server says it is somewhere else');
  }
  if (client && pub && !pub.answering) out.push(`${publicHost(campaign.name)} not answering`);
  if (client && publicState({ envRow, server, pub }) === 'elsewhere') out.push(`${publicHost(campaign.name)} answers from another server`);
  if (client && newest && server.commit && server.commit !== newest) out.push('Version differs');
  // A Promote is waiting: staging has a release production doesn't.
  if (client && staging && server.commit && shortCommit(server.commit) !== shortCommit(staging)) {
    out.push(`Production is on ${shortCommit(server.commit)}; staging is on ${shortCommit(staging)}`);
  }
  return out;
};

// Every campaign for the list, with its environment and newest checks.
export const listCampaigns = async (db) => {
  const campaigns = (await db.query("select * from campaigns order by kind = 'sample' desc, archived_at is not null, display")).rows;
  const envs = (await db.query('select * from environments')).rows;
  const checks = await latestChecks(db);
  const newest = await newestCommit(db);
  // What staging is on: the sample's newest answer.
  const sample = campaigns.find((c) => c.kind === 'sample');
  const sampleCheck = sample ? checks.get(`${sample.name}/staging/server`) : null;
  const staging = sampleCheck?.answering && sampleCheck.commit ? sampleCheck.commit : null;
  const out = [];
  for (const c of campaigns) {
    const env = envOf(c);
    const envRow = envs.find((e) => e.campaign === c.name && e.env === env) || { campaign: c.name, env };
    const server = checks.get(`${c.name}/${env}/server`) || null;
    const pub = checks.get(`${c.name}/${env}/public`) || null;
    const since = server && !server.answering ? await downSince(db, c.name, env) : null;
    out.push({ campaign: c, env, envRow, server, pub, since, chips: chipsFor({ campaign: c, envRow, server, pub, newest, staging }), block: openBlock(c, envRow, server) });
  }
  return out;
};

export const campaignView = async (db, name) => {
  const c = await getCampaign(db, name);
  if (!c) return null;
  const all = await listCampaigns(db);
  const v = all.find((x) => x.campaign.name === name);
  return { ...v, history: await history(db, name, v.env) };
};

// Save the Render address (and name shown). A changed address forgets the
// pinned instance (the next matching answer pins again) and Render's ids
// for the service and database that were at the old address.
// → { ok } | { ok: false, taken }
export const saveEnv = async (tx, { name, env, display, serverUrl, operatorId }) => {
  const c = (await tx.query('select * from campaigns where name = $1 for update', [name])).rows[0];
  const before = (await tx.query('select * from environments where campaign = $1 and env = $2', [name, env])).rows[0] || { server_url: null, instance: null };
  if (serverUrl) {
    const other = (await tx.query('select campaign from environments where server_url = $1 and not (campaign = $2 and env = $3)', [serverUrl, name, env])).rows[0];
    if (other) return { ok: false, taken: other.campaign };
  }
  const changed = (before.server_url || null) !== (serverUrl || null);
  await tx.query(`insert into environments (campaign, env, server_url) values ($1, $2, $3)
    on conflict (campaign, env) do update set server_url = excluded.server_url,
      instance = case when $4 then null else environments.instance end,
      instance_at = case when $4 then null else environments.instance_at end,
      render_service = case when $4 then null else environments.render_service end,
      render_db = case when $4 then null else environments.render_db end`, [name, env, serverUrl || null, changed]);
  if (display && display !== c.display) await tx.query('update campaigns set display = $2 where name = $1', [name, display]);
  if (changed || (display && display !== c.display)) {
    await appendLog(tx, {
      operatorId, action: 'campaign.edit', campaign: name,
      payload: { env, before: { display: c.display, server_url: before.server_url || null }, after: { display: display || c.display, server_url: serverUrl || null } },
    });
  }
  return { ok: true, changed };
};

// A new campaign row and its environment (the wizard and "already running" use it).
export const createCampaign = async (tx, { name, display, kind = 'client', values = {}, serverUrl = null, operatorId = null, action = 'campaign.create' }) => {
  await tx.query('insert into campaigns (name, display, kind, values) values ($1, $2, $3, $4)', [name, display, kind, JSON.stringify(pickValues(values))]);
  await tx.query('insert into environments (campaign, env, server_url) values ($1, $2, $3)', [name, kind === 'sample' ? 'staging' : 'production', serverUrl]);
  await appendLog(tx, { operatorId, action, campaign: name, payload: { display } });
};
