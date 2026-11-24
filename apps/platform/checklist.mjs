// A client campaign's checklist (spec §6.6): what is done on the way to a
// working campaign. Some items tick themselves from the health checks and
// stay ticked (a later failure shows as a chip instead); the rest the
// operator ticks. Every tick and untick is on the log.
import { appendLog } from './log.mjs';
import { currentKid } from './keys.mjs';

export const ITEMS = [
  { key: 'service', words: 'Database and service made in Render', by: 'you' },
  { key: 'answers', words: 'Answers, database fine', by: 'auto' },
  { key: 'tz', words: 'Time zone data current', by: 'auto' },
  { key: 'entry', words: 'base.win sign-in ready', by: 'auto' },
  { key: 'public', words: 'Answers at <name>.base.win', by: 'auto' },
  { key: 'campaign-made', words: 'Campaign made', by: 'auto' },
  { key: 'first-manager-invited', words: 'First manager invited', by: 'auto' },
  { key: 'email', words: 'Email set up (Settings → Services in the app)', by: 'you' },
  { key: 'first-manager-in', words: 'First manager signed in', by: 'you' },
];
// What the operator may tick or untick by hand.
export const MANUAL = ['service', 'first-manager-invited', 'email', 'first-manager-in'];
export const wordsOf = (key, name) => (ITEMS.find((i) => i.key === key)?.words || key).replace('<name>', name);

// → Map(item → { done_at, done_by })
export const doneFor = async (q, name) => new Map((await q.query(
  'select item, done_at, done_by from checklist where campaign = $1 and done_at is not null', [name])).rows.map((r) => [r.item, r]));

// Tick (once: a done item stays as it was) or untick, and log it.
export const setItem = async (tx, { name, item, done, by, operatorId = null }) => {
  const r = done
    ? await tx.query(`insert into checklist (campaign, item, done_at, done_by) values ($1, $2, now(), $3)
        on conflict (campaign, item) do update set done_at = now(), done_by = excluded.done_by
        where checklist.done_at is null returning item`, [name, item, by])
    : await tx.query('update checklist set done_at = null, done_by = null where campaign = $1 and item = $2 and done_at is not null returning item', [name, item]);
  if (!r.rows.length) return false;
  await appendLog(tx, { operatorId, action: done ? 'checklist.tick' : 'checklist.untick', campaign: name, payload: { item, words: wordsOf(item, name), by } });
  return true;
};

// The items the latest checks show done. (server: the newest server check;
// pub: the newest check of its own address, <name>.base.win; envRow: the
// saved address and pinned instance.)
export const autoDone = ({ envRow, server, pub, kid = currentKid() }) => {
  const out = [];
  if (!server?.answering) return out;
  const here = server.own_origin === envRow.server_url;
  // The built-in database is not a real one: nothing is kept past a
  // restart. (A server too old to say where it keeps its data still ticks.)
  if (server.database === 'ok' && here && server.store !== 'embedded') out.push('answers', 'service');
  if (server.tz_current === true) out.push('tz');
  if (server.entry === 'ready' && kid && (server.platform_kids || []).includes(kid) && envRow.instance && server.instance === envRow.instance) out.push('entry');
  if (pub?.answering && envRow.instance && pub.instance === envRow.instance) out.push('public');
  // A workspace exists (the first entry or sign-up made it). setup_open is
  // no sign of it: it is false on any server holding the control centre's key.
  // A server from before campaignMade (null): setup_open false means made
  // only while it holds none of the control centre's keys.
  const older = server.campaign_made == null && server.setup_open === false && !(server.platform_kids || []).length;
  if (server.campaign_made === true || older) out.push('campaign-made');
  return out;
};

// After a poll: tick what has come true, for each client campaign polled.
export const autoTick = async (db, { only = null } = {}) => {
  const envs = (await db.query(`select e.* from environments e join campaigns c on c.name = e.campaign
    where c.kind = 'client' and c.archived_at is null and e.env = 'production' and e.server_url is not null
      and ($1::text is null or e.campaign = $1)`, [only])).rows;
  for (const envRow of envs) {
    const latest = async (via) => (await db.query(`select * from checks where campaign = $1 and env = 'production' and via = $2
      order by at desc, id desc limit 1`, [envRow.campaign, via])).rows[0] || null;
    const items = autoDone({ envRow, server: await latest('server'), pub: await latest('public') });
    if (!items.length) continue;
    const done = await doneFor(db, envRow.campaign);
    const todo = items.filter((i) => !done.has(i));
    if (!todo.length) continue;
    await db.transaction(async (tx) => {
      for (const item of todo) await setItem(tx, { name: envRow.campaign, item, done: true, by: 'auto' });
    });
  }
};
