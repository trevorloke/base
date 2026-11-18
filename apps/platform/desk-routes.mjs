// Open desk and Invite the first manager (spec §4.3, §4.4): the code
// window, then every check the campaign's own server will make again; then
// a one-minute token, a line on the log (never the token, never the
// invited email, only its hash), and a redirect to the campaign's own
// Render address. Also the checklist's ticks and base.win’s key.
import { codeWindow } from './auth-routes.mjs';
import { form } from './web.mjs';
import { appendLog } from './log.mjs';
import { sha256 } from './ops-auth.mjs';
import { mintFor } from './mint.mjs';
import { platformKeys, newKid } from './keys.mjs';
import { campaignView, getCampaign, envOf, latestChecks } from './campaigns.mjs';
import { setItem, MANUAL } from './checklist.mjs';
import { typeCodePage, keyPage } from './pages/desk.mjs';
import { BLOCK_WORDS } from './pages/campaigns.mjs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const WRONG_CODE = 'That code didn’t work. Type the one your app shows now.';

export const deskRoutes = (app, ctx, { showCampaign }) => {
  const { db } = ctx;

  const desk = (purpose) => async (c) => {
    const name = c.req.param('name');
    const camp = await getCampaign(db, name);
    if (!camp || (purpose === 'invite' && camp.kind !== 'client')) return c.text('Not found', 404);
    const env = envOf(camp);
    const f = await form(c);
    if (f.env && f.env !== env) return c.text('Not found', 404);
    const email = String(f.email || '').trim().toLowerCase();
    if (purpose === 'invite' && (!EMAIL_RE.test(email) || email.length > 320)) {
      return showCampaign(c, name, { message: 'Type their email address.', code: 400 });
    }
    const w = await codeWindow(c, ctx, f);
    if (w !== 'ok') {
      const keep = purpose === 'invite' ? { env, email } : { env };
      // A stale code is an ordinary page asking for one (200: the new tab
      // logs no error); only a wrong code is refused.
      return c.html(String(typeCodePage({ action: `/c/${name}/${purpose}`, keep, message: w === 'wrong' ? WRONG_CODE : '' })), w === 'wrong' ? 401 : 200);
    }
    const v = await campaignView(db, name);
    if (v.block) return showCampaign(c, name, { message: BLOCK_WORDS[v.block], code: 409 });
    const session = c.get('session');
    const codeAt = (await db.query('select extract(epoch from code_at)::float8 as t from ops_sessions where token_hash = $1', [session.tokenHash])).rows[0]?.t;
    if (codeAt == null) return c.redirect('/signin', 303);
    const aud = v.envRow.server_url;
    let minted;
    try {
      minted = mintFor({
        aud, env, inst: v.envRow.instance,
        op: { id: session.operator.id, email: session.operator.email, stepUpAt: codeAt },
        go: purpose === 'invite' ? '/desk/settings/members' : '/desk',
        invite: purpose === 'invite' ? { email } : null,
      });
    } catch {
      return showCampaign(c, name, { message: 'base.win’s key isn’t set: PLATFORM_SIGNING_KEY in Render is missing or too short.', code: 503 });
    }
    await db.transaction(async (tx) => {
      const payload = { campaign: name, env, aud, nonce: minted.payload.nonce, purpose };
      if (purpose === 'invite') payload.invite_hash = sha256(email);
      await appendLog(tx, { operatorId: session.operator.id, action: 'desk.open', campaign: name, payload });
      if (purpose === 'invite') await setItem(tx, { name, item: 'first-manager-invited', done: true, by: 'auto', operatorId: session.operator.id });
    });
    return c.body(null, 303, {
      Location: `${aud}/admin/enter#t=${minted.token}`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
  };
  app.post('/c/:name/open', desk('open'));
  app.post('/c/:name/invite', desk('invite'));

  // The operator's own ticks (and unticking "First manager invited").
  app.post('/c/:name/tick', async (c) => {
    const name = c.req.param('name');
    const camp = await getCampaign(db, name);
    if (!camp || camp.kind !== 'client') return c.text('Not found', 404);
    const f = await form(c);
    if (!MANUAL.includes(f.item) || !['0', '1'].includes(f.done)) return c.text('Not found', 404);
    const w = await codeWindow(c, ctx, f);
    if (w !== 'ok') return showCampaign(c, name, { stale: `tick:${f.item}`, message: w === 'wrong' ? WRONG_CODE : '', code: 401 });
    await db.transaction((tx) => setItem(tx, { name, item: f.item, done: f.done === '1', by: 'you', operatorId: c.get('session').operator.id }));
    return c.redirect(`/c/${name}`, 303);
  });

  // base.win’s key; while it is being changed, who doesn't have the new one yet.
  app.get('/key', async (c) => {
    const keys = platformKeys();
    let missing = [];
    if (keys.length > 1) {
      const kid = newKid();
      const checks = await latestChecks(db);
      const envs = (await db.query(`select e.campaign, e.env, c.display from environments e join campaigns c on c.name = e.campaign
        where c.archived_at is null and e.server_url is not null order by c.display`)).rows;
      missing = envs.filter((e) => !(checks.get(`${e.campaign}/${e.env}/server`)?.platform_kids || []).includes(kid)).map((e) => e.display);
    }
    return c.html(String(keyPage({ keys, missing })));
  });
};
