// New campaign (its values, then the four cards of Set it up) and Add a
// campaign that’s already running (its set-up page is a short one: its
// settings live in Render). Each save goes through the code window and is
// on the log; a saved address is checked at once.
import { codeWindow } from './auth-routes.mjs';
import { form } from './web.mjs';
import { pollOnce } from './poller.mjs';
import { pubkeyValue } from './keys.mjs';
import { NAME_RE, NAME_HELP, RESERVED, normalizeOrigin, getCampaign, campaignView, createCampaign, saveEnv, entryState, oldRelease } from './campaigns.mjs';
import { doneFor, setItem } from './checklist.mjs';
import { PROVINCES, TIME_ZONES, JURISDICTIONS, RACES, tzFor, pickValues, hasValues, mapBounds, renderSnippet } from './snippets.mjs';
import { newPage, setupPage, runningSetupPage, existingPage } from './pages/wizard.mjs';

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
// Does <name>.base.win reach this campaign's server? The same four answers.
const publicState = (v) => {
  if (!v.pub) return 'not-checked';
  if (!v.pub.answering) return 'not-answering';
  return v.envRow.instance && v.pub.instance === v.envRow.instance ? 'answering' : 'elsewhere';
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
      snippet: renderSnippet({ name, display: v.campaign.display, values }), stale, typed, message,
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
