// New campaign (its values, then the four cards of Set it up) and Add a
// campaign that’s already running (its set-up page is a short one: its
// settings live in Render). Each save goes through the code window and is
// on the log; a saved address is checked at once.
import { codeWindow } from './auth-routes.mjs';
import { form } from './web.mjs';
import { pollOnce } from './poller.mjs';
import { pubkeyValue } from './keys.mjs';
import { NAME_RE, NAME_HELP, RESERVED, normalizeOrigin, getCampaign, campaignView, createCampaign, saveEnv, entryState, oldRelease, publicState } from './campaigns.mjs';
import { doneFor, setItem } from './checklist.mjs';
import { PROVINCES, TIME_ZONES, JURISDICTIONS, RACES, tzFor, pickValues, hasValues, mapBounds, renderSnippet } from './snippets.mjs';
import { newPage, setupPage, runningSetupPage, existingPage } from './pages/wizard.mjs';
import { makeGate, makeState, makeLines, makeWords, byHand, finished } from './render-make.mjs';
import { makeRefusal, makeNames } from './render-guard.mjs';
import { cfg } from './config.mjs';

// A paused make card: why Render can't be asked now. Nothing is lost.
const PAUSED_WORDS = {
  'no-key': 'Render isn’t connected here now. What was made is kept in Render.',
  closed: 'Paused. What was made is kept. Press Check Render’s answers (Render, in the menu), then Carry on here.',
  down: 'Render isn’t answering just now. What was made is kept: look again in a minute.',
  'other-workspace': 'This key is for another Render workspace than the one Check Render’s answers saw. What was made is kept.',
};
// The card's two lines that need a fresh read of Render: left out while paused, not guessed.
const UNREAD_LINES = ['Database ready', 'First build live'];

const WRONG_CODE = 'That code didn’t work. Type the one your app shows now.';
const NOT_AN_ADDRESS = 'That isn’t a Render address: it starts with https:// and has no path.';

// Why a short name can't be used, or null.
export const nameProblem = async (db, name) => {
  if (RESERVED.includes(name)) return 'That name is kept for base.win.';
  if (!NAME_RE.test(name)) return NAME_HELP;
  if (await getCampaign(db, name)) return 'That name is taken.';
  return null;
};

const takenWords = async (db, campaign) => `That address is already saved for ${(await getCampaign(db, campaign))?.display || campaign}.`;

// Is the saved address this campaign's server? 'answering' | 'not-answering' | 'elsewhere' | 'old-release' | 'not-checked'
const addressState = (v) => {
  if (!v.server) return 'not-checked';
  if (!v.server.answering) return 'not-answering';
  if (oldRelease(v.server)) return 'old-release';
  return v.server.own_origin === v.envRow.server_url && v.server.env_reported === 'production' ? 'answering' : 'elsewhere';
};

export const wizardRoutes = (app, ctx) => {
  const { db } = ctx;
  const operatorId = (c) => c.get('session').operator.id;

  app.get('/new', (c) => c.html(String(newPage())));
  app.post('/new', async (c) => {
    const body = await c.req.parseBody({ all: true });
    const one = (k) => String(Array.isArray(body[k]) ? body[k][0] : body[k] ?? '').slice(0, 200);
    const races = [].concat(body.races ?? []).map(String).filter((r) => RACES.some(([code]) => code === r));
    const v = {
      name: one('name').trim(), display: one('display').trim(), city: one('city').trim(),
      province: one('province'), rules: one('rules'), tz: one('tz'), races: [...new Set(races)],
      sw: one('sw').trim(), ne: one('ne').trim(),
    };
    if (!PROVINCES.some((p) => p[0] === v.province)) v.province = 'BC';
    if (!TIME_ZONES.includes(v.tz)) v.tz = tzFor(v.province);
    const again = (message, stale = false, code = 400) => c.html(String(newPage({ v, stale, message })), code);
    const w = await codeWindow(c, ctx, { code: one('code') });
    if (w !== 'ok') return again(w === 'wrong' ? WRONG_CODE : '', true, 401);
    const problem = await nameProblem(db, v.name);
    if (problem) return again(problem);
    if (!v.display) return again('Type the campaign’s name.');
    if (!v.city) return again('Type the city.');
    if (!JURISDICTIONS.includes(v.rules)) return again('Choose the rules.');
    if (!v.races.length) return again('Tick at least one race.');
    const area = mapBounds(v.sw, v.ne);
    if (area.problem) return again(area.problem);
    try {
      await db.transaction((tx) => createCampaign(tx, { name: v.name, display: v.display, values: pickValues({ ...v, bounds: area.bounds }), operatorId: operatorId(c) }));
    } catch {
      return again('That name is taken.', false, 409);
    }
    return c.redirect(`/c/${v.name}/setup`, 303);
  });

  // Stage 2: card 1 as Make it in Render, or null for today's hand steps.
  // Off without a Render key, until Check Render’s answers has opened it,
  // for a campaign whose service was set up by hand, and for a short name
  // that can't be made there. Reads Render only once it is on.
  // Once a make has begun here it is never null again: with the gate
  // closed, no key, or Render not answering, the card is paused (what is
  // saved here, the two names, no button), so the page never sends you
  // back to making a second database or service under the name by hand.
  const makeView = async (v) => {
    const name = v.campaign.name;
    const st = await makeState(db, name);
    const client = ctx.render?.();
    const gate = await makeGate(db, client);
    if (!st.began && (!gate.open || byHand(v.envRow, st) || makeRefusal(name))) return null;
    const answering = addressState(v) === 'answering';
    const made = finished(v.envRow, st);
    const paused = (why) => ({
      paused: true, began: true, button: null, done: made, names: makeNames(name),
      lines: makeLines({ envRow: v.envRow, st, db: null, deploy: null, answering }).filter(([k]) => !UNREAD_LINES.includes(k)),
      words: made ? 'Made in Render.' : PAUSED_WORDS[why],
      refresh: why === 'down' && st.recent && !made,
    });
    if (!cfg().render || !client) return paused('no-key');
    if (!gate.open) return paused('closed');
    const me = await client.self();
    if (!me.ok) return st.began ? paused('down') : null;
    if (me.ownerId !== gate.owner) return st.began ? paused('other-workspace') : null;
    // Read afresh: while it is being made this page looks again every 15 seconds.
    const [dbRead, deploy] = await Promise.all([
      v.envRow.render_db ? client.database(v.envRow.render_db, { fresh: true }) : null,
      v.envRow.render_service ? client.lastDeploy(v.envRow.render_service, { fresh: true }) : null,
    ]);
    const lines = makeLines({ envRow: v.envRow, st, db: dbRead, deploy, answering });
    const done = lines.every(([, w]) => w === 'Done');
    let words = makeWords(st.last?.detail?.stopped, name);
    if (deploy?.ok && deploy.state === 'failed') words = 'The first build failed. Open its log in Render, then Deploy latest (Render, in the menu).';
    else if (made && !done) words = 'Made in Render. The first build takes a few minutes; this page looks again by itself.';
    else if (done) words = 'Made in Render, and answering.';
    return { lines, words, done, began: st.began, names: makeNames(name), button: made ? null : st.began ? 'Carry on' : 'Make it in Render', refresh: st.recent && !done };
  };

  const showSetup = async (c, name, { stale = false, typed = null, message = '', code = 200 } = {}) => {
    const v = await campaignView(db, name);
    if (!v || v.campaign.kind !== 'client') return c.text('Not found', 404);
    const values = v.campaign.values || {};
    const shared = { v, publicKey: pubkeyValue(), serverUrl: v.envRow.server_url, publicState: publicState(v) };
    // Added when it was already running: nothing was typed here to make a
    // block from, so only the two steps that are the same for every campaign.
    if (!hasValues(values)) return c.html(String(runningSetupPage({ ...shared, entry: entryState(v.server), message })), code);
    return c.html(String(setupPage({
      ...shared, values, addressState: addressState(v), invited: (await doneFor(db, name)).has('first-manager-invited'),
      snippet: renderSnippet({ name, display: v.campaign.display, values }), stale, typed, message, make: await makeView(v),
    })), code);
  };
  app.get('/c/:name/setup', (c) => showSetup(c, c.req.param('name')));
  app.post('/c/:name/setup', async (c) => {
    const name = c.req.param('name');
    const camp = await getCampaign(db, name);
    if (!camp || camp.kind !== 'client') return c.text('Not found', 404);
    const f = await form(c);
    const typed = String(f.server_url || '').trim().slice(0, 300);
    const w = await codeWindow(c, ctx, f);
    if (w !== 'ok') return showSetup(c, name, { stale: true, typed, message: w === 'wrong' ? WRONG_CODE : '', code: 401 });
    const serverUrl = normalizeOrigin(typed);
    if (!serverUrl) return showSetup(c, name, { typed, message: NOT_AN_ADDRESS, code: 400 });
    const r = await db.transaction((tx) => saveEnv(tx, { name, env: 'production', serverUrl, operatorId: operatorId(c) }));
    if (!r.ok) return showSetup(c, name, { typed, message: await takenWords(db, r.taken), code: 409 });
    await pollOnce(db, { only: name, fetcher: ctx.fetcher });
    return c.redirect(`/c/${name}/setup`, 303);
  });

  app.get('/existing', (c) => c.html(String(existingPage())));
  app.post('/existing', async (c) => {
    const f = await form(c);
    const v = { name: String(f.name || '').trim(), display: String(f.display || '').trim().slice(0, 120), server_url: String(f.server_url || '').trim().slice(0, 300) };
    const again = (message, stale = false, code = 400) => c.html(String(existingPage({ v, stale, message })), code);
    const w = await codeWindow(c, ctx, f);
    if (w !== 'ok') return again(w === 'wrong' ? WRONG_CODE : '', true, 401);
    const problem = await nameProblem(db, v.name);
    if (problem) return again(problem);
    if (!v.display) return again('Type the campaign’s name.');
    const serverUrl = normalizeOrigin(v.server_url);
    if (!serverUrl) return again(NOT_AN_ADDRESS);
    const taken = (await db.query('select campaign from environments where server_url = $1', [serverUrl])).rows[0];
    if (taken) return again(await takenWords(db, taken.campaign), false, 409);
    try {
      await db.transaction(async (tx) => {
        await createCampaign(tx, { name: v.name, display: v.display, serverUrl, operatorId: operatorId(c), action: 'campaign.add-existing' });
        await setItem(tx, { name: v.name, item: 'service', done: true, by: 'you', operatorId: operatorId(c) });
      });
    } catch {
      return again('That name or address is taken.', false, 409);
    }
    await pollOnce(db, { only: v.name, fetcher: ctx.fetcher });
    return c.redirect(`/c/${v.name}`, 303);
  });
};
