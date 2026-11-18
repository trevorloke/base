// The campaigns: the list, one campaign, Check now, Edit, Archive, and
// confirming a server that changed. Every state-changing form but Check
// now goes through the code window.
import { codeWindow } from './auth-routes.mjs';
import { form } from './web.mjs';
import { appendLog, listLog } from './log.mjs';
import { pollOnce, INSTANCE_RE } from './poller.mjs';
import {
  listCampaigns, campaignView, getCampaign, getEnv, envOf, entryState, normalizeOrigin, saveEnv,
} from './campaigns.mjs';
import { campaignsPage, campaignPage, editPage } from './pages/campaigns.mjs';
import { doneFor } from './checklist.mjs';
import { deskRoutes } from './desk-routes.mjs';

const names = async (db) => new Map((await db.query('select name, display from campaigns')).rows.map((r) => [r.name, r.display]));
const WRONG_CODE = 'That code didn’t work. Type the one your app shows now.';

export const campaignRoutes = (app, ctx) => {
  const { db } = ctx;

  // One campaign's page, with a form's Code field shown (stale) or a line.
  const showCampaign = async (c, name, { stale = '', message = '', code = 200 } = {}) => {
    const v = await campaignView(db, name);
    if (!v) return c.text('Not found', 404);
    const logRows = await listLog(db, { campaign: name, limit: 20 });
    const done = await doneFor(db, name);
    return c.html(String(campaignPage({ v, entry: entryState(v.server), logRows, names: await names(db), done, stale, message })), code);
  };
  deskRoutes(app, ctx, { showCampaign });
  const found = async (c) => {
    const name = c.req.param('name');
    return (await getCampaign(db, name)) ? name : null;
  };

  app.get('/', async (c) => c.html(String(campaignsPage({ views: await listCampaigns(db) }))));

  // The sample's Render address, from the list.
  app.post('/sample', async (c) => {
    const f = await form(c);
    const typed = String(f.server_url || '').trim().slice(0, 300);
    const again = async (message, stale = false, code = 400) => c.html(String(campaignsPage({ views: await listCampaigns(db), sampleStale: stale, sampleValue: typed, sampleMessage: message })), code);
    const w = await codeWindow(c, ctx, f);
    if (w !== 'ok') return again(w === 'wrong' ? WRONG_CODE : '', true, 401);
    const serverUrl = normalizeOrigin(typed);
    if (!serverUrl) return again('That isn’t a Render address: it starts with https:// and has no path.');
    const r = await db.transaction((tx) => saveEnv(tx, { name: 'sample', env: 'staging', serverUrl, operatorId: c.get('session').operator.id }));
    if (!r.ok) return again(`That address is already saved for ${(await names(db)).get(r.taken) || r.taken}.`, false, 409);
    await pollOnce(db, { only: 'sample', fetcher: ctx.fetcher });
    return c.redirect('/c/sample', 303);
  });

  app.get('/c/:name', async (c) => {
    const name = await found(c);
    return name ? showCampaign(c, name) : c.text('Not found', 404);
  });

  // No code needed: it only reads the campaign's public health.
  app.post('/c/:name/check-now', async (c) => {
    const name = await found(c);
    if (!name) return c.text('Not found', 404);
    await pollOnce(db, { only: name, fetcher: ctx.fetcher });
    return c.redirect(`/c/${name}`, 303);
  });

  app.get('/c/:name/edit', async (c) => {
    const name = await found(c);
    if (!name) return c.text('Not found', 404);
    const camp = await getCampaign(db, name);
    const env = await getEnv(db, name, envOf(camp));
    return c.html(String(editPage({ c: camp, serverUrl: env?.server_url || '' })));
  });
  app.post('/c/:name/edit', async (c) => {
    const name = await found(c);
    if (!name) return c.text('Not found', 404);
    const camp = await getCampaign(db, name);
    const f = await form(c);
    const display = String(f.display || '').trim().slice(0, 120);
    const typed = String(f.server_url || '').trim();
    const again = (message, stale = false, code = 400) => c.html(String(editPage({ c: camp, serverUrl: typed, display, stale, message })), code);
    const w = await codeWindow(c, ctx, f);
    if (w !== 'ok') return again(w === 'wrong' ? WRONG_CODE : '', true, 401);
    if (!display) return again('Type the campaign’s name.');
    const serverUrl = typed ? normalizeOrigin(typed) : null;
    if (typed && !serverUrl) return again('That isn’t a Render address: it starts with https:// and has no path.');
    const r = await db.transaction((tx) => saveEnv(tx, { name, env: envOf(camp), display, serverUrl, operatorId: c.get('session').operator.id }));
    if (!r.ok) return again(`That address is already saved for ${(await names(db)).get(r.taken) || r.taken}.`, false, 409);
    if (r.changed && serverUrl) await pollOnce(db, { only: name, fetcher: ctx.fetcher });
    return c.redirect(`/c/${name}`, 303);
  });

  for (const [path, archive] of [['archive', true], ['unarchive', false]]) {
    app.post(`/c/:name/${path}`, async (c) => {
      const name = await found(c);
      if (!name) return c.text('Not found', 404);
      const camp = await getCampaign(db, name);
      if (camp.kind !== 'client') return c.text('Not found', 404);
      const f = await form(c);
      const w = await codeWindow(c, ctx, f);
      if (w !== 'ok') return showCampaign(c, name, { stale: 'archive', message: w === 'wrong' ? WRONG_CODE : '', code: 401 });
      await db.transaction(async (tx) => {
        const r = await tx.query(`update campaigns set archived_at = ${archive ? 'now()' : 'null'}
          where name = $1 and (archived_at is null) = $2 returning name`, [name, archive]);
        if (r.rows.length) await appendLog(tx, { operatorId: c.get('session').operator.id, action: archive ? 'campaign.archive' : 'campaign.unarchive', campaign: name, payload: {} });
      });
      return c.redirect(`/c/${name}`, 303);
    });
  }

  // The server answers with an instance other than the pinned one (a
  // rebuilt database, say): the operator says it's the same campaign.
  app.post('/c/:name/confirm-server', async (c) => {
    const name = await found(c);
    if (!name) return c.text('Not found', 404);
    const camp = await getCampaign(db, name);
    const f = await form(c);
    const env = envOf(camp);
    if (f.env && f.env !== env) return c.text('Not found', 404);
    const w = await codeWindow(c, ctx, f);
    if (w !== 'ok') return showCampaign(c, name, { stale: 'confirm', message: w === 'wrong' ? WRONG_CODE : '', code: 401 });
    const v = await campaignView(db, name);
    const s = v.server;
    if (!s?.answering || s.own_origin !== v.envRow.server_url || s.env_reported !== env || !INSTANCE_RE.test(s.instance || '') || s.instance === v.envRow.instance) {
      return showCampaign(c, name, { message: 'Nothing to confirm: press Check now first.', code: 409 });
    }
    try {
      await db.transaction(async (tx) => {
        await tx.query('update environments set instance = $3, instance_at = now() where campaign = $1 and env = $2', [name, env, s.instance]);
        await appendLog(tx, { operatorId: c.get('session').operator.id, action: 'environment.repin', campaign: name, payload: { env, old: v.envRow.instance, new: s.instance } });
      });
    } catch {
      return showCampaign(c, name, { message: 'Another campaign already has this server: check the Render address saved here.', code: 409 });
    }
    return c.redirect(`/c/${name}`, 303);
  });
};
