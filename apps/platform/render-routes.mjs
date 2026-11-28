// Render, from the control centre: the board (/render), "Check Render’s
// answers", one campaign's page, and the one route every change goes
// through. All of it is off (Not found) unless a Render key is set.
//
// Render is only ever asked from inside one of these signed-in requests:
// nothing here runs on a timer or at start. Reads need no code. A change is
// two requests, ask then do:
//   ask  the page says what will happen, to which service by name and
//        address; a one-use job row is made. Nothing has been asked of Render.
//   do   the job must be this session's, for this campaign and change, under
//        5 minutes old; a code from the app typed for it (never the 10-minute
//        window, never a recovery code); one change at a time per campaign;
//        6 an hour per campaign, 30 a day in all. The service is checked
//        again, "Asked Render to…" is written to the log and saved before
//        Render is asked, the change is read back, and the result is logged.
// Rows and log lines hold names and ids only: never a value or Render's answer.
//
// Stage 2 (render-make.mjs): Make it in Render and adding a missing setting
// on a campaign made with New campaign. Both are Not found until Check
// Render’s answers has opened them (makeGate), and go through the same ask,
// code, lease, caps and log as every change.
import { randomBytes } from 'node:crypto';
import { cfg } from './config.mjs';
import { freshAppCode } from './auth-routes.mjs';
import { sha256 } from './ops-auth.mjs';
import { form } from './web.mjs';
import { appendLog } from './log.mjs';
import { pollOnce } from './poller.mjs';
import { campaignView, listCampaigns, getCampaign, envOf, entryState, shortCommit } from './campaigns.mjs';
import { platformKeys } from './keys.mjs';
import { guard, neededFor, domainFor, CANARY, REFUSALS, madeHere, makeRefusal, makeNames, WRITABLE_MADE, valueFor } from './render-guard.mjs';
import { makeGate, makeState, runMake, byHand, finished, MAKES_A_DAY, MAKE_WORDS, WAITS } from './render-make.mjs';
import { NO_KEY_WORDS } from './pages/desk.mjs';
import { newNameOf, OLD_SETTINGS } from '../../shared/old-names.js';
import { renderPage, campaignRenderPage, confirmPage, refusedPage, checkPage, problemWords, CODE_WORDS } from './pages/render.mjs';

export const WHATS = ['link', 'deploy', 'restart', 'key', 'domain', 'close-db', 'set', 'make'];
export const CAPS = { perCampaignAnHour: 6, aDay: 30 };
const KEY_SETTING = 'BASE_PLATFORM_PUBKEY';
const OLD_PAGE = 'That page is old. Start again.';
const BUSY = 'Already working on a change here. Wait a minute.';
const TOO_MANY = 'Too many changes. Wait, or do it in Render.';
const TWO_A_DAY = 'Two new campaigns were made in Render today. Make the next one tomorrow, or by hand (More).';
const BY_HAND = 'This campaign’s service was set up by hand. Nothing was changed.';
const ALREADY_MADE = 'This campaign is made in Render already. Nothing more to make.';
const notFound = (c) => c.text('Not found', 404);

// At most `limit` reads at once.
const pool = async (tasks, limit) => {
  const out = new Array(tasks.length);
  let next = 0;
  const work = async () => { while (next < tasks.length) { const i = next++; out[i] = await tasks[i](); } };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, work));
  return out;
};

// A change that began and never got its result (the process stopped
// between the two): after 3 minutes it is "no answer on record". Nothing is
// asked of Render here.
const sweep = (db, name) => db.query(`update render_jobs set state = 'unknown', ended_at = now(), problem = 'no-answer'
  where campaign = $1 and state = 'running' and began_at < now() - interval '3 minutes'`, [name]);
// The newest change that began on this campaign (one still running first).
const lastJob = async (db, name) => (await db.query(`select what, state, problem, detail from render_jobs
  where campaign = $1 and began_at is not null order by (state = 'running') desc, began_at desc, asked_at desc limit 1`, [name])).rows[0] || null;

// What Render says about one connected campaign. Each read fails alone.
const readOne = async (client, v) => {
  const id = v.envRow.render_service;
  const [me, svc, deploy, doms, db] = await pool([
    () => client.self(), () => client.service(id), () => client.lastDeploy(id), () => client.domains(id),
    () => (v.envRow.render_db ? client.database(v.envRow.render_db) : null),
  ], 4);
  const code = me.ok && svc.ok ? guard({ campaign: v.campaign, envRow: v.envRow, health: v.server, self: me, svc, ownId: cfg().ownService }) : null;
  return { linked: true, me, svc, deploy, doms, db, refusal: code ? REFUSALS[code] : null, code };
};
// Which of the settings this campaign should have are set, each by its name
// today or its older name (set when either is). Names only; a value is
// never read. If Render can't say that the one setting every campaign has
// is set, nothing was read ("Not read").
// → { read, missing: [new name], older: [{ old, now }] }: older lists each
// setting still set under its older name, with the name to use instead.
const readSettings = async (client, v) => {
  const id = v.envRow.render_service;
  const canary = await client.isSet(id, CANARY);
  if (!canary.ok || !canary.set) return { read: false, missing: [], older: [] };
  const needed = neededFor(v.campaign).filter((k) => k !== CANARY);
  const got = await pool(needed.map((k) => () => client.isSet(id, k)), 4);
  if (got.some((r) => !r.ok)) return { read: false, missing: [], older: [] };
  const older = [[CANARY, canary], ...needed.map((k, i) => [k, got[i]])].filter(([, r]) => r.older).map(([now]) => ({ old: OLD_SETTINGS[now], now }));
  return { read: true, missing: needed.filter((_, i) => !got[i].set), older };
};

// What needs a look on one campaign, in a few words each.
const looksFor = (v, s, job) => {
  const out = [];
  const host = domainFor(v.campaign);
  if (!s.svc.ok) return ['Render didn’t answer'];
  if (s.refusal) out.push(s.refusal);
  if (s.svc.auto === false) out.push('it doesn’t deploy by itself');
  if (s.deploy?.ok && s.deploy.state === 'failed') out.push('the last deploy failed');
  const serverCommit = v.server?.answering && v.server.commit ? shortCommit(v.server.commit) : null;
  if (s.deploy?.ok && s.deploy.state === 'live' && s.deploy.commit && serverCommit && s.deploy.commit !== serverCommit
    && s.deploy.at && Date.now() - new Date(s.deploy.at).getTime() > 600_000) out.push(`Render deployed ${s.deploy.commit} but the server says it runs ${serverCommit}`);
  if (host && s.doms?.ok) {
    const mine = s.doms.list.find((d) => d.name === host);
    if (!mine) out.push(`${host} isn’t added in Render`);
    else if (!mine.verified) out.push(`${host} is waiting for its DNS record`);
  }
  if (!v.envRow.render_db) out.push('no database found');
  else if (s.db?.ok && s.db.open === true) out.push('its database is open to the internet');
  else if (s.db && !s.db.ok && s.db.problem === 'not-found') out.push('its database wasn’t found');
  if (job?.state === 'unknown') out.push('the last change has no answer on record');
  return out;
};

// The buttons a campaign's page shows: [what, words, setting?].
const buttonsFor = (v, s, { stage2 = false } = {}) => {
  if (s.refusal || !s.me.ok || !s.svc.ok) return [];
  const out = [['deploy', 'Deploy latest'], ['restart', 'Restart']];
  const entry = entryState(v.server);
  if ((s.settings?.read && s.settings.missing.includes(KEY_SETTING)) || entry === 'not-set-up' || entry === 'wrong-key') out.push(['key', 'Set base.win’s key']);
  const host = domainFor(v.campaign);
  if (host && s.doms?.ok) {
    const mine = s.doms.list.find((d) => d.name === host);
    if (!mine) out.push(['domain', 'Add its address']);
    else if (!mine.verified) out.push(['domain', 'Check the address again']);
  }
  if (v.envRow.render_db && s.db?.ok && s.db.open === true) out.push(['close-db', 'Close the database to the internet']);
  // Stage 2: a campaign made with New campaign gets each missing setting of its own added.
  if (stage2 && madeHere(v.campaign) && s.settings?.read) {
    for (const k of s.settings.missing) if (k !== KEY_SETTING && WRITABLE_MADE.includes(k) && valueFor(v.campaign, k, { stage2 })) out.push(['set', `Add ${k}`, k]);
  }
  return out;
};

// The calls a change makes, then the read-back: the setting is set, the
// address is listed, the database is closed. t is a checked target.
// → { state: 'done' | 'failed' | 'unknown', status, problem, step, note }
const run = async (what, client, t, host, setting = null) => {
  const ended = (r, step) => ({ state: r.unsure ? 'unknown' : 'failed', status: r.status ?? null, problem: r.problem, step });
  const unread = (r, step) => ({ state: 'unknown', status: r.status ?? null, problem: r.problem, step });
  if (what === 'deploy') {
    const r = await client.deploy(t);
    return r.ok ? { state: 'done' } : ended(r, 'deploy');
  }
  if (what === 'restart') {
    const r = await client.restart(t);
    return r.ok ? { state: 'done' } : ended(r, 'restart');
  }
  if (what === 'key') {
    const set = await client.setOne(t, KEY_SETTING);
    if (!set.ok) return ended(set, 'set');
    const back = await client.isSet(t.service, KEY_SETTING, { fresh: true });
    if (!back.ok) return unread(back, 'read-back');
    if (!back.set) return { state: 'failed', status: null, problem: 'not-read-back', step: 'read-back' };
    const dep = await client.deploy(t);
    return dep.ok ? { state: 'done' } : { state: 'done', note: 'no-deploy', status: dep.status ?? null, problem: dep.problem, step: 'deploy' };
  }
  if (what === 'set') {
    // Added only because it is missing: asked again just before.
    const now = await client.isSet(t.service, setting, { fresh: true });
    if (!now.ok) return { state: 'failed', status: now.status ?? null, problem: now.problem, step: 'look' };
    if (now.set) return { state: 'failed', status: null, problem: 'already-set', step: 'look' };
    const set = await client.setOne(t, setting);
    if (!set.ok) return ended(set, 'set');
    const back = await client.isSet(t.service, setting, { fresh: true });
    if (!back.ok) return unread(back, 'read-back');
    if (!back.set) return { state: 'failed', status: null, problem: 'not-read-back', step: 'read-back' };
    const dep = await client.deploy(t);
    return dep.ok ? { state: 'done' } : { state: 'done', note: 'no-deploy', status: dep.status ?? null, problem: dep.problem, step: 'deploy' };
  }
  if (what === 'domain') {
    const before = await client.domains(t.service, { fresh: true });
    if (!before.ok) return { state: 'failed', status: before.status ?? null, problem: before.problem, step: 'look' };
    const listed = before.list.some((d) => d.name === host);
    const r = listed ? await client.checkDomain(t) : await client.addDomain(t);
    if (!r.ok) return ended(r, listed ? 'check' : 'add');
    const back = await client.domains(t.service, { fresh: true });
    if (!back.ok) return unread(back, 'read-back');
    return back.list.some((d) => d.name === host) ? { state: 'done' } : { state: 'failed', status: null, problem: 'not-read-back', step: 'read-back' };
  }
  if (what === 'close-db') {
    const r = await client.closeDatabase(t);
    if (!r.ok) return ended(r, 'close');
    const back = await client.database(t.id, { fresh: true });
    if (!back.ok) return unread(back, 'read-back');
    return back.open === false ? { state: 'done' } : { state: 'failed', status: null, problem: 'still-open', step: 'read-back' };
  }
  return { state: 'failed', status: null, problem: 'not-allowed', step: 'none' };
};

export const renderRoutes = (app, ctx) => {
  const { db } = ctx;
  const waits = ctx.waits || WAITS;
  const names = async () => new Map((await db.query('select name, display from campaigns')).rows.map((r) => [r.name, r.display]));

  // One campaign's Render page, with a line of words when a change was refused.
  const showOne = async (c, client, v, { message = '', code = 200 } = {}) => {
    let s = { linked: false };
    if (v.envRow.render_service) {
      s = await readOne(client, v);
      s.settings = s.svc.ok ? await readSettings(client, v) : { read: false, missing: [], older: [] };
      s.job = await lastJob(db, v.campaign.name);
      s.buttons = buttonsFor(v, s, { stage2: (await makeGate(db, client)).open });
    }
    return c.html(String(campaignRenderPage({ v, s, message })), code);
  };

  // What a change needs to be true before it is offered, and again before it is made.
  const notNow = async (what, client, got, setting = null) => {
    if (what === 'deploy') {
      const d = await client.lastDeploy(got.target.service, { fresh: true });
      if (d.ok && d.state === 'deploying') return 'A deploy is already running there. Wait for it to finish.';
    }
    if (what === 'key' && !platformKeys().length) return NO_KEY_WORDS;
    if (what === 'set') {
      const now = await client.isSet(got.target.service, setting, { fresh: true });
      if (!now.ok) return problemWords(now.problem);
      if (now.set) return `${setting} is already set on ${got.svc.name}. Nothing was changed.`;
    }
    if (what === 'close-db') {
      if (got.db.open === false) return 'This database is already closed to the internet.';
      if (got.db.open !== true) return 'Render’s answer about who may connect couldn’t be read: press Check Render’s answers.';
    }
    return null;
  };

  app.get('/render', async (c) => {
    if (!cfg().render) return notFound(c);
    const client = ctx.render();
    const logRows = (await db.query("select seq, at, action, campaign, payload from ops_log where action like 'render.%' order by seq desc limit 20")).rows;
    const b = { connected: { ok: false, words: problemWords('no-own-id') }, warnings: [], looks: [], rows: [], production: '', staging: '', promote: '', blueprint: '', logRows, names: await names() };
    const me = client ? await client.self() : null;
    if (!me?.ok) {
      if (me) b.connected.words = me.problem === 'refused-key' ? 'Render refused the key. Make a new one: see below.' : problemWords(me.problem).replace(' Nothing was changed.', '');
      return c.html(String(renderPage({ b })));
    }
    const [ws, bps] = await Promise.all([client.workspaces(), client.blueprints()]);
    b.connected = { ok: true, label: ws.ok ? ws.label : null };
    if (me.branch !== 'production') b.warnings.push('The control centre itself isn’t running from the production branch yet. Until it is, code that hasn’t been through Promote runs beside this key: do “Before the key” below.');
    if (me.build !== 'ignore-scripts') b.warnings.push('The control centre’s build command in Render isn’t npm ci --omit=dev --ignore-scripts yet: do “Before the key” below.');
    if (ws.ok && ws.count > 1) b.warnings.push(`This key sees ${ws.count} workspaces. It should see only base.win’s.`);
    const views = (await listCampaigns(db)).filter((v) => !v.campaign.archived_at);
    for (const v of views) await sweep(db, v.campaign.name);
    // One campaign after another, its four reads at once: never more than four requests to Render at a time.
    // Each connected campaign's settings too (names only), for the older names still set on it.
    const read = await pool(views.map((v) => async () => {
      if (!v.envRow.render_service) return { v, linked: false };
      const one = await readOne(client, v);
      return { v, ...one, settings: one.svc.ok ? await readSettings(client, v) : { read: false, missing: [], older: [] }, job: await lastJob(db, v.campaign.name) };
    }), 1);
    b.rows = read;
    for (const r of read.filter((x) => x.linked)) for (const words of looksFor(r.v, r, r.job)) b.looks.push([r.v.campaign.display, words]);
    // Production: which version each connected client's last deploy put live.
    const clients = read.filter((r) => r.linked && r.v.campaign.kind === 'client' && r.svc.ok && r.deploy?.ok);
    const live = clients.filter((r) => r.deploy.state === 'live' && r.deploy.commit);
    if (clients.length) {
      const tally = new Map();
      for (const r of live) tally.set(r.deploy.commit, (tally.get(r.deploy.commit) || 0) + 1);
      const [top, n] = [...tally].sort((x, y) => y[1] - x[1])[0] || [null, 0];
      const rest = clients.filter((r) => !(r.deploy.state === 'live' && r.deploy.commit === top))
        .map((r) => `${r.v.campaign.display}: ${r.deploy.state === 'deploying' ? 'still deploying' : r.deploy.state === 'failed' ? 'the last deploy failed' : r.deploy.commit ? `on ${r.deploy.commit}` : 'not live'}.`);
      if (!top) b.production = `Production: ${rest.join(' ')}`;
      else if (n === clients.length) b.production = `Production: ${n === 1 ? 'the 1 connected campaign is' : `all ${n} connected campaigns are`} on ${top}.`;
      else b.production = `Production: ${n} of ${clients.length} are on ${top}. ${rest.join(' ')}`;
      const sample = read.find((r) => r.linked && r.v.campaign.kind === 'sample' && r.deploy?.ok && r.deploy.state === 'live' && r.deploy.commit);
      if (sample && top) {
        const waiting = sample.deploy.commit !== top;
        b.staging = waiting ? `Staging is on ${sample.deploy.commit}: Promote is waiting.` : `Staging is on ${sample.deploy.commit}, the same as production.`;
        if (waiting && me.repo) b.promote = `${me.repo}/actions/workflows/promote.yml`;
      }
    }
    const bp = bps.ok ? bps.list[0] : null;
    b.blueprint = !bps.ok ? 'Blueprint: Render didn’t answer.'
      : bp ? `Blueprint: listed${bp.branch ? `, follows ${bp.branch}` : ''}${bp.autoSync == null ? '' : `, Auto Sync ${bp.autoSync ? 'on' : 'off'}`}${bps.list.length > 1 ? ` (and ${bps.list.length - 1} more)` : ''}` : 'No Blueprint';
    return c.html(String(renderPage({ b })));
  });

  // Reads only, no code: each question the pages ask, and whether the answer
  // came back as expected. It runs against the sample's service and database
  // (staging holds only made-up data); before the sample is connected, only
  // the reads that need no campaign.
  app.post('/render/check', async (c) => {
    if (!cfg().render) return notFound(c);
    const client = ctx.render();
    if (!client) return notFound(c);
    const sample = (await db.query("select e.render_service, e.render_db from environments e join campaigns c on c.name = e.campaign where c.kind = 'sample'")).rows[0];
    const lines = await client.check({ service: sample?.render_service || null, database: sample?.render_db || null });
    // Stage 2: the words making needs, in Render's own answer about
    // staging. What was seen goes on the log; the newest line opens or
    // closes Make it in Render (makeGate).
    const make = await client.checkMake({ service: sample?.render_service || null, database: sample?.render_db || null });
    const ok = lines.every((l) => l.ok);
    await db.transaction((tx) => appendLog(tx, { operatorId: c.get('session').operator.id, action: 'render.check', payload: { ok, make: ok && make.ready, shapes: make.shapes, owner: make.owner } }));
    return c.html(String(checkPage({ lines, sample: Boolean(sample?.render_service), make: { ...make, open: ok && make.ready } })));
  });

  app.get('/c/:name/render', async (c) => {
    if (!cfg().render) return notFound(c);
    const client = ctx.render();
    const name = c.req.param('name');
    if (!client || !(await getCampaign(db, name))) return notFound(c);
    await sweep(db, name);
    return showOne(c, client, await campaignView(db, name));
  });

  // Every change, ask then do.
  app.post('/c/:name/render/:what', async (c) => {
    if (!cfg().render) return notFound(c);
    const client = ctx.render();
    const name = c.req.param('name');
    const what = c.req.param('what');
    const camp = client ? await getCampaign(db, name) : null;
    if (!camp || !WHATS.includes(what)) return notFound(c);
    if (what === 'domain' && camp.kind !== 'client') return notFound(c);
    // Stage 2: nothing of it until Check Render’s answers has opened it, and
    // only on a campaign made with New campaign.
    const gate = what === 'set' || what === 'make' ? await makeGate(db, client) : null;
    if (gate && (!gate.open || !madeHere(camp))) return notFound(c);
    const f = await form(c);
    const env = envOf(camp);
    await sweep(db, name);
    const v = await campaignView(db, name);
    if (what !== 'make' && (what === 'link' ? !v.envRow.server_url : !v.envRow.render_service)) return notFound(c);
    if (what === 'close-db' && !v.envRow.render_db) return notFound(c);
    // set: one setting of this campaign's own, missing, and never base.win's key (it has its own button).
    const settingOk = (k) => WRITABLE_MADE.includes(k) && k !== KEY_SETTING && Boolean(valueFor(camp, k, { stage2: true }));
    // A setting is always named by its name today: one from a page or a job
    // row saved under its older name is read as the new one.
    const asked = what === 'set' && !f.job ? newNameOf(String(f.setting || '')) : null;
    if (what === 'set' && !f.job && !settingOk(asked)) return notFound(c);
    const session = c.get('session');
    const operatorId = session.operator.id;
    const host = domainFor(camp);
    // A change turned away: one line of words, and no further question to Render.
    const refuse = (message, code = 409) => c.html(String(refusedPage({ campaign: camp, message })), code);
    // The service this change would go to, read from Render now and checked.
    const find = () => (what === 'link' ? client.candidate(camp, v.envRow, v.server) : client.target(camp, v.envRow, v.server, { database: what === 'close-db', stage2: what === 'set' }));
    const wordsOf = (got) => got.refusal || problemWords(got.problem);
    // What the confirm page names: Render's own names for this campaign's service, nothing else.
    const named = async (got) => {
      const svc = what === 'link' ? got.service : got.svc;
      const dbName = what === 'link' ? got.database?.name : (got.db?.name || null);
      let listed = false;
      if (what === 'domain') {
        const d = await client.domains(svc.id, { fresh: true });
        listed = d.ok && d.list.some((x) => x.name === host);
      }
      return { id: svc.id, target: what === 'link' ? svc.id : got.target.id, label: svc.name, url: svc.url, branch: svc.branch, database: dbName || null, host, listed };
    };
    // Make it in Render: may this press go ahead? The words why not, or null.
    const n = makeNames(name);
    // What is known here is looked at first; Render is asked last.
    const makeBlock = async () => {
      const st = await makeState(db, name);
      const envRow = (await db.query('select * from environments where campaign = $1 and env = $2', [name, env])).rows[0];
      const why = makeRefusal(name) || (camp.archived_at ? REFUSALS.archived : null) || (byHand(envRow, st) ? BY_HAND : null)
        || (finished(envRow, st) ? ALREADY_MADE : null) || (!platformKeys().length ? NO_KEY_WORDS : null)
        || (st.unsure ? MAKE_WORDS[`unsure-${st.unsure}`]() : null);
      if (why) return { words: why, st };
      const today = (await db.query("select count(distinct campaign)::int as n from render_jobs where what = 'make' and began_at > now() - interval '1 day' and campaign <> $1", [name])).rows[0].n;
      if (today >= MAKES_A_DAY) return { words: TWO_A_DAY, code: 429, st };
      // The workspace Check Render’s answers saw.
      const me = await client.self({ fresh: true });
      if (!me.ok) return { words: problemWords(me.problem), st };
      if (me.ownerId !== gate.owner) return { notFound: true, st };
      return { st };
    };

    if (!f.job && what === 'make') {
      // ── Ask: Make it in Render (nothing exists yet to target) ──
      const block = await makeBlock();
      if (block.notFound) return notFound(c);
      if (block.words) return refuse(block.words, block.code || 409);
      const job = randomBytes(16).toString('hex');
      const t = { label: n.service, database: n.database, host, carry: block.st.began };
      await db.query("delete from render_jobs where state = 'asked' and asked_at < now() - interval '1 hour'");
      await db.query(`insert into render_jobs (id, campaign, env, what, target, detail, state, asked_in) values ($1, $2, $3, $4, null, $5, 'asked', $6)`,
        [job, name, env, what, JSON.stringify(t), sha256(session.tokenHash + job)]);
      return c.html(String(confirmPage({ campaign: camp, what, job, t })));
    }
    if (!f.job) {
      // ── Ask ──
      const got = await find();
      if (!got.ok) return refuse(wordsOf(got));
      const setting = what === 'set' ? asked : null;
      const wait = what === 'link' ? null : await notNow(what, client, got, setting);
      if (wait) return refuse(wait);
      const t = { ...(await named(got)), ...(setting ? { setting, value: valueFor(camp, setting, { stage2: true }) } : {}) };
      const job = randomBytes(16).toString('hex');
      const detail = {
        label: t.label, branch: t.branch, ...(t.database ? { database: t.database } : {}), ...(what === 'key' ? { setting: KEY_SETTING } : {}), ...(setting ? { setting } : {}),
        ...(what === 'domain' ? { host, listed: t.listed } : {}),
      };
      await db.query("delete from render_jobs where state = 'asked' and asked_at < now() - interval '1 hour'");
      await db.query(`insert into render_jobs (id, campaign, env, what, target, detail, state, asked_in) values ($1, $2, $3, $4, $5, $6, 'asked', $7)`,
        [job, name, env, what, t.target, JSON.stringify(detail), sha256(session.tokenHash + job)]);
      return c.html(String(confirmPage({ campaign: camp, what, job, t })));
    }

    // ── Do ──
    const jobId = String(f.job);
    const short = jobId.slice(0, 12);
    const denied = (problem, extra = {}) => db.transaction((tx) => appendLog(tx, { operatorId, action: 'render.denied', campaign: name, payload: { env, what, job: short, problem, ...extra } }));
    const row = /^[0-9a-f]{32}$/.test(jobId) ? (await db.query("select *, (asked_at > now() - interval '5 minutes') as young from render_jobs where id = $1", [jobId])).rows[0] : null;
    if (row?.detail?.setting) row.detail.setting = newNameOf(String(row.detail.setting));
    if (!row || row.campaign !== name || row.what !== what || row.state !== 'asked' || !row.young || row.asked_in !== sha256(session.tokenHash + row.id)) {
      await denied('old');
      return refuse(OLD_PAGE);
    }
    const typed = await freshAppCode(c, ctx, f);
    if (typed !== 'ok') {
      // Nothing is asked of Render. The page comes back for another try, from what the job row kept.
      await denied('code', { service: row.target, label: row.detail.label });
      const t = { label: row.detail.label, url: v.envRow.server_url, branch: row.detail.branch, database: row.detail.database || null, host, listed: Boolean(row.detail.listed),
        carry: Boolean(row.detail.carry), ...(what === 'set' ? { setting: row.detail.setting, value: valueFor(camp, row.detail.setting, { stage2: true }) } : {}) };
      return c.html(String(confirmPage({ campaign: camp, what, job: jobId, t, message: CODE_WORDS[typed] })), 401);
    }
    const used = (state, problem) => db.query("update render_jobs set state = $2, ended_at = now(), problem = $3 where id = $1 and state = 'asked'", [jobId, state, problem]);
    // One change at a time, and not too many.
    if ((await db.query("select 1 from render_jobs where campaign = $1 and state = 'running'", [name])).rows.length) {
      await denied('busy');
      await used('failed', 'denied');
      return refuse(BUSY);
    }
    if (what !== 'link') {
      const n = (await db.query(`select count(*) filter (where campaign = $1 and began_at > now() - interval '1 hour')::int as here,
        count(*) filter (where began_at > now() - interval '1 day')::int as all_day from render_jobs where what <> 'link' and began_at is not null`, [name])).rows[0];
      if (n.here >= CAPS.perCampaignAnHour || n.all_day >= CAPS.aDay) {
        await denied('caps');
        await used('failed', 'denied');
        return refuse(TOO_MANY, 429);
      }
    }
    if (what === 'make') {
      // Everything again, now; then the steps (render-make.mjs), each with
      // its own "Asked Render to…" line before Render is asked.
      const block = await makeBlock();
      if (block.notFound || block.words) {
        await denied(block.code === 429 ? 'caps' : block.st?.unsure ? 'wait' : 'state', { label: n.service });
        await used('failed', 'denied');
        return block.notFound ? notFound(c) : refuse(block.words, block.code || 409);
      }
      let started = false;
      try {
        started = (await db.query("update render_jobs set state = 'running', began_at = now() where id = $1 and state = 'asked' returning id", [jobId])).rows.length > 0;
      } catch { started = false; }
      if (!started) {
        await denied('busy');
        await used('failed', 'denied');
        return refuse(BUSY);
      }
      let out;
      try {
        out = await runMake({ db, client, fetcher: ctx.fetcher, camp, env, jobId, operatorId, gate, waits });
      } catch { out = { state: 'unknown', stopped: { code: 'error' } }; }
      await db.query('update render_jobs set state = $2, ended_at = now(), problem = $3, detail = detail || $4::jsonb where id = $1',
        [jobId, out.state, out.stopped?.code || null, JSON.stringify({ stopped: out.stopped })]);
      client.forget();
      await pollOnce(db, { only: name, fetcher: ctx.fetcher });
      return c.redirect(`/c/${name}/setup`, 303);
    }
    // The service again, now: it must still be the one the page named.
    const got = await find();
    const gotId = got.ok ? (what === 'link' ? got.service.id : got.target.id) : null;
    if (!got.ok || gotId !== row.target) {
      await denied('target', { service: row.target, label: row.detail.label });
      await used('failed', 'denied');
      return refuse(got.ok ? REFUSALS.changed : wordsOf(got));
    }
    const payload = { env, what, job: short, service: got.ok && what !== 'link' ? got.target.service : row.target, label: row.detail.label, ...(row.detail.setting ? { setting: row.detail.setting } : {}), ...(what === 'domain' ? { host } : {}),
      ...(what === 'close-db' && row.detail.database ? { database: row.detail.database } : {}) };

    if (what === 'link') {
      // Connect: Render's two ids are saved. Nothing in Render changes.
      try {
        await db.transaction(async (tx) => {
          const mine = await tx.query("update render_jobs set state = 'done', began_at = now(), ended_at = now() where id = $1 and state = 'asked' returning id", [jobId]);
          if (!mine.rows.length) throw new Error('used');
          await tx.query('update environments set render_service = $3, render_db = $4 where campaign = $1 and env = $2', [name, env, got.service.id, got.database?.id || null]);
          await appendLog(tx, { operatorId, action: 'render.link', campaign: name, payload: { ...payload, database: got.database?.name || null } });
        });
      } catch {
        await used('failed', 'denied');
        return refuse('This service or its database is already connected to another campaign here.');
      }
      client.forget();
      return c.redirect(`/c/${name}/render`, 303);
    }

    const wait = await notNow(what, client, got, row.detail.setting || null);
    if (wait) {
      await denied('state', { service: payload.service, label: payload.label });
      await used('failed', 'denied');
      return refuse(wait);
    }
    // "Asked Render to…" is on the log, and saved, before Render is asked.
    let began = false;
    try {
      began = await db.transaction(async (tx) => {
        const mine = await tx.query("update render_jobs set state = 'running', began_at = now() where id = $1 and state = 'asked' returning id", [jobId]);
        if (!mine.rows.length) return false;
        await appendLog(tx, { operatorId, action: 'render.start', campaign: name, payload });
        return true;
      });
    } catch { began = false; }
    if (!began) {
      await denied('busy');
      await used('failed', 'denied');
      return refuse(BUSY);
    }
    let out;
    try { out = await run(what, client, got.target, host, row.detail.setting || null); } catch { out = { state: 'unknown', status: null, problem: 'error', step: 'none' }; }
    await db.transaction(async (tx) => {
      await tx.query('update render_jobs set state = $2, ended_at = now(), problem = $3, detail = detail || $4::jsonb where id = $1',
        [jobId, out.state, out.state === 'done' ? null : String(out.status || out.problem || 'error'), JSON.stringify({ ...(out.step ? { step: out.step } : {}), ...(out.note ? { note: out.note } : {}) })]);
      await appendLog(tx, {
        operatorId, action: 'render.result', campaign: name,
        payload: { ...payload, ok: out.state === 'done', ...(out.state === 'unknown' ? { unsure: true } : {}), ...(out.step ? { step: out.step } : {}), ...(out.status ? { status: out.status } : {}), ...(out.problem ? { problem: out.problem } : {}) },
      });
    });
    client.forget();
    await pollOnce(db, { only: name, fetcher: ctx.fetcher });
    return c.redirect(`/c/${name}/render`, 303);
  });
};
