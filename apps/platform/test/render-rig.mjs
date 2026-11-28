// Tests only: a control centre holding a Render key, over the in-memory
// stand-in for Render (fake-render.mjs), with an operator set up through
// the real screens and four campaigns added through the real forms:
//   sample          the sample (staging), at base-win-staging's address
//   a, b            two clients made with New campaign
//   imaginesurrey   a client added as already running (no values kept here),
//                   at the hand-made service base-win's address
//   fresh: [...]    stage 2: clients made with New campaign and nothing more
//                   (no Render address yet), for Make it in Render
// Each campaign's server "answers" through the injected fetcher, so its
// instance is pinned the way the poller pins it.
import { baseEnv, freshApp, setUp, browser, codeNow } from './helpers.mjs';
import { fakeWorld, renderEnv } from './fake-render.mjs';
import { makeApp } from '../server.mjs';
import { makeRender } from '../render-api.mjs';
import { currentKid } from '../keys.mjs';

export const ADDR = {
  sample: 'https://base-win-staging.onrender.com',
  a: 'https://base-win-a.onrender.com',
  b: 'https://base-win-b.onrender.com',
  imaginesurrey: 'https://base-win.onrender.com',
};
const INSTANCE = { sample: 'S', a: 'A', b: 'B', imaginesurrey: 'I' };
// No waiting in tests: a new database is read again at once.
export const FAST = { readyEveryMs: 0, readyTries: 3, lookEveryMs: 0 };
const NEW = { city: 'Exampleton', province: 'BC', rules: 'bc-municipal', tz: 'America/Vancouver', races: 'council', sw: '50.6, -120.5', ne: '50.8, -120.2' };

export const rig = async ({ world = fakeWorld(), campaigns = ['sample', 'a', 'b', 'imaginesurrey'], fresh = [], cacheMs = 0, waits = FAST } = {}) => {
  baseEnv();
  renderEnv();
  const { db } = await freshApp();
  // What each campaign's server says when asked for its health. Set
  // health[name] = null for a server that isn't answering.
  const health = {};
  for (const name of fresh) { ADDR[name] = `https://base-win-${name}.onrender.com`; INSTANCE[name] = name[0].toUpperCase(); }
  const answer = (name) => ({
    ok: true, database: 'ok', env: name === 'sample' ? 'staging' : 'production', commit: 'd9130ae', tzdataCurrent: true, ownOrigin: ADDR[name],
    instance: INSTANCE[name].repeat(22), address: `https://${name}.base.win`, entry: 'ready', platformKids: [currentKid()], setupOpen: false, campaignMade: true, store: 'postgres',
  });
  const asked = [];
  const fetcher = async (url) => {
    asked.push(url);
    const origin = new URL(url).origin;
    const name = Object.keys(ADDR).find((n) => ADDR[n] === origin) || /^https:\/\/([a-z0-9-]+)\.base\.win$/.exec(origin)?.[1];
    const h = name ? health[name] : null;
    if (!h) { const e = new Error('ECONNREFUSED'); e.name = 'ECONNREFUSED'; throw e; }
    return { status: 200, ms: 3, body: JSON.stringify(h) };
  };
  // world.send is looked up on each request, so a test can wrap it.
  const render = makeRender({ send: (...args) => world.send(...args), cacheMs, timeoutMs: 300 });
  let app = makeApp({ db, fetcher, render, waits });
  const op = await setUp(app, db);
  let b = op.b;
  for (const name of campaigns) {
    health[name] = answer(name);
    let res;
    if (name === 'sample') res = await b.post('/sample', { server_url: ADDR.sample });
    else if (name === 'imaginesurrey') res = await b.post('/existing', { name, display: 'Imagine Surrey', server_url: ADDR[name] });
    else {
      res = await b.post('/new', { name, display: `Example ${name.toUpperCase()}`, ...NEW });
      if (res.status === 303) res = await b.post(`/c/${name}/setup`, { server_url: ADDR[name] });
    }
    if (res.status !== 303) throw new Error(`adding ${name}: ${res.status} ${await res.text()}`);
  }
  for (const name of fresh) {
    const res = await b.post('/new', { name, display: `Example ${name.toUpperCase()}`, ...NEW });
    if (res.status !== 303) throw new Error(`adding ${name}: ${res.status} ${await res.text()}`);
  }
  const startCalls = world.calls.length;
  const r = {
    db, world, health, answer, asked, op, render,
    get app() { return app; },
    get b() { return b; },
    code: () => codeNow(db, op.secret),
    // A new console over the same database and the same Render (its limits
    // on typed codes start again), signed in as the same session.
    again: () => {
      app = makeApp({ db, fetcher, render, waits });
      const next = browser(app);
      for (const [k, v] of b.jar) next.jar.set(k, v);
      b = next;
      return r;
    },
    // Another signed-in browser (its own session).
    other: async () => {
      const o = browser(app, { ip: '203.0.113.77' });
      const res = await o.post('/signin', { email: op.email, password: op.password, code: await codeNow(db, op.secret) });
      if (res.status !== 303) throw new Error(`signin: ${res.status}`);
      return o;
    },
    // The first request of a change: the page that says what will happen.
    ask: async (name, what, who = b) => {
      const res = await who.post(`/c/${name}/render/${what}`, {});
      const body = await res.text();
      return { res, body, job: /name="job" value="([0-9a-f]{32})"/.exec(body)?.[1] || null };
    },
    // Both requests: ask, then do with a code typed for it.
    change: async (name, what, who = b) => {
      const asked1 = await r.ask(name, what, who);
      if (!asked1.job) return asked1.res;
      return who.post(`/c/${name}/render/${what}`, { job: asked1.job, code: await codeNow(db, op.secret) });
    },
    connect: async (...names) => {
      for (const name of names) {
        const res = await r.change(name, 'link');
        if (res.status !== 303) throw new Error(`connecting ${name}: ${res.status} ${await res.text()}`);
      }
    },
    env: async (name) => (await db.query('select * from environments where campaign = $1', [name])).rows[0],
    jobs: async (name) => (await db.query('select * from render_jobs where campaign = $1 order by asked_at, began_at nulls first', [name])).rows,
    log: async (action = 'render.%') => (await db.query('select seq, action, campaign, payload from ops_log where action like $1 order by seq', [action])).rows,
    // Requests to Render since the rig was built (or since `mark()`).
    from: startCalls,
    mark: () => { r.from = world.calls.length; },
    calls: () => world.calls.slice(r.from).map((c) => `${c.method} ${c.path}`),
    writes: () => world.calls.slice(r.from).filter((c) => c.method !== 'GET'),
    page: async (path, who = b) => { const res = await who.get(path); return { status: res.status, body: (await res.text()).replace(/\s+/g, ' ') }; },
  };
  return r;
};
