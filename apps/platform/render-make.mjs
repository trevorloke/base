// Stage 2: a new campaign's database and service, made by the control
// centre in Render (Make it in Render, on the campaign's set-up page).
//
// It is off until Check Render’s answers, with the sample connected, has
// seen in Render's own answer about staging every word the creating calls
// send; that check is kept on the log (render.check) and makeGate() reads
// the newest one. A release that changes those words, a failing check or a
// key for another workspace closes it again. Off, nothing of it shows and
// its routes are Not found.
//
// Each press runs what it can finish in about a minute, then stops; Carry
// on (a new code) goes on. Every step is "look, make only if nothing is
// there, save the id, log it":
//   1 the database     base-win-<name>-db, closed to the internet
//   2 ready            Render says the database can be used
//   3 the service      base-win-<name>, every setting in the creating call
//   4 its address      Render's address saved as if pasted, then checked
//   5 <name>.base.win  added to the service in Render
// "Asked Render to…" is on the log, and the make call is marked "no answer
// yet", before Render is asked; only a saved id makes it "made". So a make
// with no answer (or a save that failed after Render made it) is found by
// the next look and used, never made twice; anything else under the name
// stops the run. After a make with no answer, Carry on waits two minutes.
// Nothing is ever deleted to tidy up.
import { appendLog } from './log.mjs';
import { pollOnce } from './poller.mjs';
import { saveEnv, publicHost } from './campaigns.mjs';
import { makeNames, REFUSALS } from './render-guard.mjs';
import { cfg } from './config.mjs';

// Waits, in a press (tests make them nothing).
export const WAITS = { readyEveryMs: 5000, readyTries: 8, lookEveryMs: 2000 };
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
// Two campaigns made a day, in all.
export const MAKES_A_DAY = 2;
// Render's clock and ours may differ a little.
const SKEW_MS = 120_000;

// Is stage 2 open? From the log alone (no question to Render):
// → { open, shapes, owner }
export const makeGate = async (db, client) => {
  if (!cfg().render || !client) return { open: false };
  const p = (await db.query("select payload from ops_log where action = 'render.check' order by seq desc limit 1")).rows[0]?.payload || {};
  const open = p.ok === true && p.make === true && p.shapes === client.makeShapes && typeof p.owner === 'string';
  return { open, shapes: p.shapes || null, owner: p.owner || null };
};

// Where this campaign's making is, from its make jobs (newest first):
// the newest make call for each thing, whether a press began at all, the
// newest press's stop, and whether a make with no answer is under two
// minutes old.
export const makeState = async (db, name) => {
  const jobs = (await db.query(`select id, state, detail, began_at,
      extract(epoch from now() - coalesce(ended_at, began_at))::float8 as ago,
      extract(epoch from now() - began_at)::float8 as since
    from render_jobs where campaign = $1 and what = 'make' and began_at is not null order by began_at desc, asked_at desc`, [name])).rows;
  const newest = (thing) => {
    for (const j of jobs) { const m = j.detail?.made?.[thing]; if (m) return { ...m, ago: j.ago }; }
    return null;
  };
  const database = newest('database');
  const service = newest('service');
  const unsure = [['database', database], ['service', service]].find(([, m]) => m?.outcome === 'unknown' && m.ago < 120);
  return {
    began: jobs.length > 0, jobs, database, service,
    domainAdded: jobs.some((j) => j.detail?.domain === 'added'),
    last: jobs[0] || null,
    recent: jobs.length > 0 && jobs[0].since < 20 * 60,
    unsure: unsure ? unsure[0] : null,
  };
};
// Is this record the id saved? (made here, or found after a make with no answer)
const ours = (m, id) => Boolean(m && id && ['made', 'found'].includes(m.outcome) && m.id === id);

// The words a stopped press leaves on the set-up page.
export const MAKE_WORDS = {
  'refused-key': () => 'Render refused the key. See Render, in the menu.',
  busy: () => 'Render asked us to slow down. Try again in a minute.',
  payment: () => 'Render needs a payment method for this plan. Nothing was made.',
  'unsure-database': () => 'Render didn’t say whether it made the database. Wait two minutes, then Carry on: it looks first and never makes a second one.',
  'unsure-service': () => 'Render didn’t say whether it made the service. Wait two minutes, then Carry on: it looks first and never makes a second one.',
  'not-ready': () => 'Render is getting the database ready. Press Carry on in a few minutes.',
  'db-failed': () => 'Render couldn’t make the database. Open it in Render.',
  wire: () => 'Couldn’t wire the database. Nothing more was made.',
  'database-refused': (x) => `Render refused the database${x.status ? ` (answer ${x.status})` : ''}. Nothing was made.`,
  'service-refused': (x) => `Render refused the service${x.status ? ` (answer ${x.status})` : ''}. The database is kept; nothing was made twice.`,
  'address-taken': () => 'That Render address is already saved for another campaign here. Nothing more was made: look in Render.',
  'domain-taken': (x) => `${x.host} is already on another service in Render.`,
  'domain-refused': (x) => `Render didn’t add ${x.host}${x.status ? ` (answer ${x.status})` : ''}. Press Carry on to try again.`,
  'unsure-domain': (x) => `Render didn’t say whether it added ${x.host}. Press Carry on: it looks first.`,
  'taken-database': (x) => `A database called ${x.database} is already in Render and this page didn’t make it. Nothing was changed. Choose another short name, or finish by hand (More).`,
  'taken-service': (x) => `A service called ${x.service} is already in Render and this page didn’t make it. Nothing was changed. Choose another short name, or finish by hand (More).`,
  'two-database': (x) => `Two databases called ${x.database} are in Render: look there. Nothing more was made.`,
  'two-service': (x) => `Two services called ${x.service} are in Render: look there. Nothing more was made.`,
  'other-workspace': () => 'This key is for another Render workspace than the one Check Render’s answers saw. Nothing was made.',
  refusal: (x) => REFUSALS[x.refusal] || REFUSALS.unread,
  error: () => 'Render didn’t answer. Nothing more was made: press Carry on to try again.',
};
export const makeWords = (stopped, name) => {
  if (!stopped?.code) return '';
  const n = makeNames(name);
  return (MAKE_WORDS[stopped.code] || MAKE_WORDS.error)({ ...stopped, host: publicHost(name), database: n.database, service: n.service });
};

// The six lines of the set-up page's card, from what is saved here and
// what was read: 'Done' | 'Not yet' | 'Failed'.
export const makeLines = ({ envRow, st, db, deploy, answering }) => {
  const word = (done, failed = false) => (done ? 'Done' : failed ? 'Failed' : 'Not yet');
  const ready = db?.ok ? db.status : null;
  return [
    ['Database made', word(Boolean(envRow.render_db))],
    ['Database ready', word(ready === 'available', ['unavailable', 'suspended', 'recovery_failed'].includes(ready))],
    ['Service made', word(Boolean(envRow.render_service))],
    ['Address added', word(st.domainAdded)],
    ['First build live', word(deploy?.ok && deploy.state === 'live', deploy?.ok && deploy.state === 'failed')],
    ['Answering', word(answering)],
  ];
};

// One press. → { state: 'done' | 'failed' | 'unknown', stopped: { code, status? } | null }
//   client  the Render client; camp, env the campaign; jobId this press's job
//   gate    makeGate()'s answer, checked again inside makeTarget
export const runMake = async ({ db, client, fetcher, camp, env, jobId, operatorId, gate, waits = WAITS }) => {
  const name = camp.name;
  const n = makeNames(name);
  const host = publicHost(name);
  const short = jobId.slice(0, 12);
  const envNow = async () => (await db.query('select * from environments where campaign = $1 and env = $2', [name, env])).rows[0];
  const stop = (code, extra = {}) => ({ state: code.startsWith('unsure') ? 'unknown' : 'failed', stopped: { code, ...extra } });
  // A Render problem, as the card's words.
  const stopFor = (r, refusedCode) => {
    if (r.problem === 'refused-key') return stop('refused-key');
    if (r.problem === 'busy') return stop('busy');
    if (r.problem === 'payment') return stop('payment');
    if (r.problem === 'other-workspace') return stop('other-workspace');
    if (r.refusal) return stop('refusal', { refusal: r.code });
    if (refusedCode && ['invalid', 'conflict'].includes(r.problem)) return stop(refusedCode, { status: r.status });
    return stop('error', r.status ? { status: r.status } : {});
  };
  const about = (payload) => ({ env, what: 'make', job: short, ...payload });
  // This press's own make calls, kept whole in its job row.
  const made = {};
  const keep = (tx) => tx.query('update render_jobs set detail = detail || $2::jsonb where id = $1', [jobId, JSON.stringify({ made })]);
  // "Asked Render to make…" on the log, and the call marked "no answer yet",
  // committed before Render is asked.
  const begin = async (step, label) => {
    if (step !== 'domain') made[step] = { at: new Date().toISOString(), outcome: 'unknown' };
    await db.transaction(async (tx) => {
      if (step !== 'domain') await keep(tx);
      await appendLog(tx, { operatorId, action: 'render.start', campaign: name, payload: about({ step, label, ...(step === 'domain' ? { host } : {}) }) });
    });
  };
  const result = (step, payload, more = async () => {}) => db.transaction(async (tx) => {
    await more(tx);
    await appendLog(tx, { operatorId, action: 'render.result', campaign: name, payload: about({ step, ...payload }) });
  });
  // A failed answer, logged as what it was.
  const ended = (step, r, more) => result(step, { ok: false, ...(r.unsure ? { unsure: true } : {}), ...(r.status ? { status: r.status } : {}), ...(r.problem ? { problem: r.problem } : {}) }, more);
  // Look for one thing by name: after a make with no answer, read the list
  // up to three times before deciding nothing is there.
  const look = async (kind, label, record) => {
    const tries = record?.outcome === 'unknown' ? 3 : 1;
    let got;
    for (let i = 0; i < tries; i += 1) {
      if (i) await sleep(waits.lookEveryMs);
      got = await client.byName(kind, label);
      if (!got.ok || got.list.length) return got;
    }
    return got;
  };
  // A thing found under the name is ours only when this campaign's newest
  // make call for it had no answer and it was made after that call began.
  const adoptable = (record, x, kind) => Boolean(record?.outcome === 'unknown' && x.createdAt && Date.parse(x.createdAt) >= Date.parse(record.at) - SKEW_MS
    && (kind === 'database' || (x.type === 'web_service' && x.branch === 'production' && x.repo && x.repo === t.repo)));

  const mt = await client.makeTarget(camp, await envNow(), gate);
  if (!mt.ok) return stopFor(mt);
  const t = mt.target;
  let st = await makeState(db, name);
  let row = await envNow();

  // 1. The database.
  const stepDatabase = async () => {
    if (row.render_db) return ours(st.database, row.render_db) ? null : stop('wire');
    const found = await look('database', n.database, st.database);
    if (!found.ok) return stopFor(found);
    if (found.list.length > 1) return stop('two-database');
    if (found.list.length === 1) {
      const x = found.list[0];
      if (!adoptable(st.database, x, 'database')) return stop('taken-database');
      made.database = { at: st.database.at, outcome: 'found', id: x.id };
      await result('database', { ok: true, found: true, label: n.database }, async (tx) => {
        await tx.query('update environments set render_db = $3 where campaign = $1 and env = $2', [name, env, x.id]);
        await keep(tx);
      });
      return null;
    }
    await begin('database', n.database);
    const r = await client.makeDatabase(t);
    if (r.ok) {
      try {
        await result('database', { ok: true, label: n.database }, async (tx) => {
          await tx.query('update environments set render_db = $3 where campaign = $1 and env = $2', [name, env, r.id]);
          made.database = { ...made.database, outcome: 'made', id: r.id };
          await keep(tx);
        });
      } catch {
        // Render made it and the id isn't saved: the next look finds it.
        made.database = { ...made.database, outcome: 'unknown' };
        return stop('unsure-database');
      }
      return null;
    }
    if (!r.unsure) made.database = { ...made.database, outcome: 'refused' };
    await ended('database', r, keep);
    return r.unsure ? stop('unsure-database') : stopFor(r, 'database-refused');
  };

  // 2. Ready: Render says the database can be used.
  const stepReady = async () => {
    for (let i = 0; i < waits.readyTries; i += 1) {
      if (i) await sleep(waits.readyEveryMs);
      const d = await client.database(row.render_db, { fresh: true });
      if (!d.ok) return stopFor(d);
      if (d.status === 'available') return null;
      if (['unavailable', 'suspended', 'recovery_failed'].includes(d.status)) return stop('db-failed');
    }
    return stop('not-ready');
  };

  // 3. The service.
  const stepService = async () => {
    if (row.render_service) return ours(st.service, row.render_service) ? null : stop('wire');
    const found = await look('service', n.service, st.service);
    if (!found.ok) return stopFor(found);
    if (found.list.length > 1) return stop('two-service');
    if (found.list.length === 1) {
      const x = found.list[0];
      if (!adoptable(st.service, x, 'service')) return stop('taken-service');
      made.service = { at: st.service.at, outcome: 'found', id: x.id };
      await result('service', { ok: true, found: true, label: n.service }, async (tx) => {
        await tx.query('update environments set render_service = $3 where campaign = $1 and env = $2', [name, env, x.id]);
        await keep(tx);
      });
      return null;
    }
    // Only the database this campaign's own make made (or found).
    if (!ours(st.database, row.render_db)) return stop('wire');
    await begin('service', n.service);
    const r = await client.makeService(t, { database: row.render_db, since: st.database.at });
    if (r.ok) {
      try {
        await result('service', { ok: true, label: n.service }, async (tx) => {
          await tx.query('update environments set render_service = $3 where campaign = $1 and env = $2', [name, env, r.id]);
          made.service = { ...made.service, outcome: 'made', id: r.id };
          await keep(tx);
        });
      } catch {
        made.service = { ...made.service, outcome: 'unknown' };
        return stop('unsure-service');
      }
      return null;
    }
    if (!r.unsure) made.service = { ...made.service, outcome: 'refused' };
    await ended('service', r, keep);
    if (r.unsure) return stop('unsure-service');
    if (['not-allowed', 'wire', 'not-found'].includes(r.problem)) return stop('wire');
    return stopFor(r, 'service-refused');
  };

  // 4. Its address: Render's own, saved as if pasted (a changed address
  // clears the two ids, so they go back in the same transaction), checked.
  const stepAddress = async () => {
    const svc = await client.service(row.render_service, { fresh: true });
    if (!svc.ok) return stopFor(svc);
    if (!svc.url) return stop('error');
    if (row.server_url === svc.url) return null;
    let taken = false;
    try {
      await db.transaction(async (tx) => {
        const saved = await saveEnv(tx, { name, env, serverUrl: svc.url, operatorId });
        if (!saved.ok) { taken = true; throw new Error('taken'); }
        await tx.query('update environments set render_service = $3, render_db = $4 where campaign = $1 and env = $2', [name, env, row.render_service, row.render_db]);
      });
    } catch {
      return stop(taken ? 'address-taken' : 'error');
    }
    await pollOnce(db, { only: name, fetcher });
    return null;
  };

  // 5. <name>.base.win on the service: looked for first, added if missing, read back.
  const stepDomain = async () => {
    const health = (await db.query("select * from checks where campaign = $1 and env = $2 and via = 'server' order by at desc limit 1", [name, env])).rows[0] || null;
    const got = await client.target(camp, row, health, { made: ours(st.service, row.render_service) });
    if (!got.ok) return stopFor(got);
    const listed = async () => {
      const d = await client.domains(row.render_service, { fresh: true });
      return d.ok ? d.list.some((x) => x.name === host) : null;
    };
    const keepDomain = (tx) => tx.query('update render_jobs set detail = detail || $2::jsonb where id = $1', [jobId, JSON.stringify({ domain: 'added' })]);
    const before = await listed();
    if (before == null) return stop('error');
    if (before) { await db.transaction(keepDomain); return null; }
    await begin('domain', host);
    const r = await client.addDomain(got.target);
    if (!r.ok) {
      await ended('domain', r);
      if (r.unsure) return stop('unsure-domain');
      if (r.problem === 'conflict') return stop('domain-taken');
      return ['refused-key', 'busy'].includes(r.problem) ? stopFor(r) : stop('domain-refused', r.status ? { status: r.status } : {});
    }
    if (!(await listed())) {
      await result('domain', { ok: false, problem: 'not-read-back' });
      return stop('domain-refused');
    }
    await result('domain', { ok: true, host }, keepDomain);
    return null;
  };

  for (const step of [stepDatabase, stepReady, stepService, stepAddress, stepDomain]) {
    const out = await step();
    if (out) return out;
    st = await makeState(db, name);
    row = await envNow();
  }
  return { state: 'done', stopped: null };
};

// May this campaign be made here at all (stage 2 aside)? A campaign made
// with New campaign whose service wasn't set up by hand.
export const byHand = (envRow, st) => !st.began && Boolean(envRow.server_url || envRow.render_service || envRow.render_db);
export const finished = (envRow, st) => Boolean(envRow.render_db && envRow.render_service && envRow.server_url && st.domainAdded);
