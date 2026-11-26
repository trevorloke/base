// Render, as the control centre sees it with a Render key: the board of
// every campaign (/render), one campaign's service, deploys, addresses,
// settings and database (/c/:name/render), the page that says what a change
// will do before it is made (with the Code field every change needs), and
// what "Check Render’s answers" found. Shown only with a key; these pages
// never talk to Render themselves (render-routes.mjs hands them what was read).
import { html, raw, dayClock } from './html.mjs';
import { page, field, status } from './layout.mjs';
import { logLine } from './log.mjs';
import { publicHost } from '../campaigns.mjs';

// ── Render's words, as people read them ──
const title = (s) => String(s).replace(/[_-]+/g, ' ').replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
export const planWords = (plan) => {
  if (!plan) return 'plan not read';
  const size = /^(.*?)[_-](\d+)(mb|gb)$/.exec(plan);
  return size ? `${title(size[1])} ${size[2]} ${size[3].toUpperCase()}` : title(plan);
};
const regionWords = (region) => (region ? title(region) : 'region not read');
const DEPLOY_WORDS = { live: 'Live', deploying: 'Deploying', failed: 'Failed', other: 'Stopped before it went live', none: 'No deploy yet' };
export const PROBLEM_WORDS = {
  'refused-key': 'Render refused the key. See Render, in the menu.',
  'other-workspace': 'This key is for another Render workspace.',
  'no-own-id': 'Not connected: this service doesn’t know its own Render id.',
  busy: 'Render asked us to slow down. Try again in a minute.',
};
export const problemWords = (problem) => PROBLEM_WORDS[problem] || 'Render didn’t answer. Nothing was changed.';
const NO_ANSWER = 'Render didn’t answer. The rest of this page is as usual.';

// Open it in Render's own dashboard: a plain link built from the id. Check
// the address it opens before signing in there.
const inRender = (id, kind = 'web') => html`<a href="https://dashboard.render.com/${kind}/${id}" rel="noreferrer" target="_blank">Open in Render ↗</a>`;

// ── What each change is, in words (the confirm page and its button) ──
// t: { label, url, branch, database, host, listed } — names and addresses
// from Render's own answer for this campaign's service, nothing else.
const hostOf = (url) => { try { return new URL(url).host; } catch { return 'its onrender.com address'; } };
export const CHANGES = {
  link: {
    title: 'Connect to Render', button: 'Connect', busy: 'Connecting…',
    words: (t) => [`Service: ${t.label}, ${t.url}, ${t.branch} branch. Database: ${t.database || 'none found (Close the database won’t be offered)'}.`,
      'This page will show what Render says about these two, and its buttons act on these two only. Nothing in Render changes.'],
  },
  deploy: {
    title: 'Deploy latest', button: 'Deploy latest', busy: 'Asking Render…',
    words: (t) => [`Render builds the newest version on the ${t.branch} branch and switches to it when ready, in 2 to 3 minutes. Nothing in the database changes. Best outside canvassing hours.`],
  },
  restart: {
    title: 'Restart', button: 'Restart', busy: 'Asking Render…',
    words: () => ['The server stops and starts on the same version. It may not answer for a minute. Nothing saved is lost. Use it when the campaign has stopped answering.'],
  },
  key: {
    title: 'Set base.win’s key', button: 'Set base.win’s key', busy: 'Asking Render…',
    words: (t) => [`Sets BASE_PLATFORM_PUBKEY on ${t.label} to base.win’s key, then deploys (2 to 3 minutes). After that, Open desk works. No other setting is touched.`],
  },
  domain: {
    title: 'Add its address', button: 'Add its address', busy: 'Asking Render…',
    words: (t) => (t.listed
      ? [`Asks Render to check ${t.host} again. Where base.win’s domain is registered, the CNAME named ${t.host.split('.')[0]} should point at ${hostOf(t.url)}.`]
      : [`Adds ${t.host} to ${t.label}. Then, where base.win’s domain is registered, add a CNAME named ${t.host.split('.')[0]} pointing at ${hostOf(t.url)}.`]),
  },
  'close-db': {
    title: 'Close the database to the internet', button: 'Close the database to the internet', busy: 'Asking Render…',
    words: (t) => [`Removes ‘anywhere’ from who may connect to ${t.database}. The campaign’s own server still connects. A database tool on your own computer stops connecting until you add its address in Render.`],
  },
};
const changeTitle = (what, t) => (what === 'domain' && t?.listed ? 'Check the address again' : CHANGES[what].title);

export const CODE_WORDS = {
  missing: 'Render changes take a code every time.',
  recovery: 'Use the code from your app. A recovery code signs you in; it doesn’t change anything in Render.',
  wrong: 'That code didn’t work. Type the one your app shows now.',
};

// Says what will happen, to which service, and asks for a code typed for it.
export const confirmPage = ({ campaign, what, job, t, message = '' }) => {
  const heading = changeTitle(what, t);
  return page({
    title: `${heading} · ${campaign.display}`, nav: true, here: 'render',
    body: html`<section class="card oc-narrow"><h1>${heading}</h1>
    <p class="oc-help">${campaign.display} · ${t.label} · ${t.url}</p>
    ${CHANGES[what].words(t).map((w) => html`<p>${w}</p>`)}
    <form method="post" action="/c/${campaign.name}/render/${what}" class="oc-form" data-busy="${CHANGES[what].busy}">
      <input type="hidden" name="job" value="${job}">
      ${field({ label: 'Code', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', required: true, help: 'From your app, typed for this change. Render changes take a code every time.' })}
      ${status(message, message ? 'warn' : '')}
      <button class="btn btn-primary oc-wide" type="submit">${what === 'domain' && t.listed ? 'Check the address again' : CHANGES[what].button}</button>
    </form>
    <p><a class="btn btn-quiet" href="/c/${campaign.name}/render">Cancel</a></p></section>`,
  });
};

// A change that was turned away: why, in one line, and the way back.
export const refusedPage = ({ campaign, message }) => page({
  title: `Render · ${campaign.display}`, nav: true, here: 'render',
  body: html`<section class="card oc-narrow"><h1>Nothing was changed</h1>
  ${status(message, 'warn')}
  <p><a class="btn btn-quiet" href="/c/${campaign.name}/render">Back to Render · ${campaign.display}</a></p></section>`,
});

// ── One campaign ──
const ask = (name, what, words, { primary = false } = {}) => html`<form method="post" action="/c/${name}/render/${what}" class="oc-inline-form" data-busy="Asking Render…">
  <button class="btn ${primary ? 'btn-primary' : 'btn-quiet'}" type="submit">${words}</button>
</form>`;

// How the last change ended, from its row (never from anything Render said).
export const jobWords = (job) => {
  if (!job) return '';
  if (job.state === 'running') return 'Working on a change here. Wait a minute, then reload.';
  if (job.state === 'unknown') return job.problem === 'no-answer' ? 'The last change has no answer on record: look in Render.' : 'No answer from Render: look there before trying again.';
  if (job.state === 'failed') {
    if (job.problem === 'still-open') return 'Render didn’t close it.';
    if (job.problem === 'not-read-back') return 'Render took the change, but it doesn’t show there: look in Render.';
    return /^\d{3}$/.test(job.problem || '') ? `Render didn’t do it (answer ${job.problem}).` : 'Render didn’t do it.';
  }
  if (job.state === 'done') {
    if (job.detail?.note === 'no-deploy') return 'The key is set. The deploy didn’t start: press Deploy latest.';
    if (job.what === 'link') return 'Connected. Nothing in Render was changed.';
    if (job.what === 'deploy' || job.what === 'key') return 'Render did it. A new version takes 2 to 3 minutes to go live.';
    if (job.what === 'domain') return 'Render did it. The address works once its DNS record is in place and Render has checked it.';
    return 'Render did it.';
  }
  return '';
};

const failed = (r) => r && !r.ok;
const row = (k, v, help = '') => html`<div><dt>${k}</dt><dd>${v}${help ? html`<p class="oc-help">${help}</p>` : ''}</dd></div>`;

// s: what render-routes.mjs read for this campaign (each read may have failed alone).
export const campaignRenderPage = ({ v, s, message = '', kind = 'warn' }) => {
  const c = v.campaign;
  const name = c.name;
  const host = c.kind === 'client' ? publicHost(name) : null;
  const head = html`<div class="oc-head"><h1>Render · ${c.display}</h1>${s.linked ? html`<p>${inRender(v.envRow.render_service)}</p>` : ''}</div>
    ${c.kind === 'sample' ? html`<p class="oc-help">Staging: made-up data only.</p>` : ''}
    ${status(message, message ? kind : '')}`;
  const back = html`<p><a class="btn btn-quiet" href="/c/${name}">Back to ${c.display}</a></p>`;
  if (!s.linked) {
    return page({
      title: `Render · ${c.display}`, nav: true, here: 'render',
      body: html`${head}
      <section class="card"><h2>Not connected</h2>
        ${v.envRow.server_url
    ? html`<p>Connect finds the one service in Render at this campaign’s saved address, ${v.envRow.server_url}, and its database. It changes nothing there.</p>
          ${c.archived_at ? html`<p class="oc-block">This campaign is archived. Bring it back first.</p>` : ask(name, 'link', 'Connect', { primary: true })}`
    : html`<p class="oc-block">No Render address saved yet: add it under Edit on the campaign’s page.</p>`}
      </section>${back}`,
    });
  }
  const { svc, deploy, doms, db, settings, refusal } = s;
  const serverCommit = v.server?.answering && v.server.commit ? String(v.server.commit).slice(0, 7) : null;
  const differs = deploy?.ok && deploy.state === 'live' && deploy.commit && serverCommit && deploy.commit !== serverCommit;
  const mine = doms?.ok && host ? doms.list.find((d) => d.name === host) : null;
  const others = doms?.ok ? doms.list.filter((d) => d.name !== host) : [];
  const rows = [
    row('Service', failed(svc) ? NO_ANSWER
      : [svc.name, svc.branch ? `${svc.branch} branch` : 'branch not read', planWords(svc.plan), regionWords(svc.region), svc.auto === false ? 'does not deploy by itself' : svc.auto ? 'deploys by itself' : null].filter(Boolean).join(' · ')),
    row('Last deploy', failed(deploy) ? NO_ANSWER
      : [DEPLOY_WORDS[deploy.state], deploy.commit, deploy.at ? dayClock(deploy.at) : null, differs ? `the server says it runs ${serverCommit}` : null].filter(Boolean).join(' · ')),
    row('Addresses', failed(doms) ? NO_ANSWER
      : html`${host ? html`${host} · ${mine ? (mine.verified ? 'Verified' : 'Waiting for the DNS record') : 'Not added yet'}` : ''}${others.map((d, i) => html`${host || i ? html`<br>` : ''}${d.name}`)}${!host && !others.length ? 'None' : ''}`),
    row('Settings', !settings?.read ? 'Not read' : settings.missing.length ? `Missing: ${settings.missing.join(', ')}` : 'Nothing missing',
      settings?.read ? 'Email, texting and Google keys are not read here: the campaign’s Settings → Services says which are set.'
        : 'Render didn’t say which settings are set, so this page can’t tell what is missing: look in Render. Email, texting and Google keys are never read here.'),
    row('Database', !v.envRow.render_db ? 'No database found' : failed(db) ? NO_ANSWER
      : html`${[db.name, planWords(db.plan), db.version ? `PostgreSQL ${db.version}` : null,
        db.open === true ? 'Open to anyone on the internet' : db.open === false ? 'Closed to the internet' : 'who may connect: not read'].filter(Boolean).join(' · ')}`,
    db?.ok && db.open === false && db.others ? `${db.others} other ${db.others === 1 ? 'address' : 'addresses'} may connect (set in Render).` : ''),
  ];
  return page({
    title: `Render · ${c.display}`, nav: true, here: 'render',
    body: html`${head}
    ${s.job ? status(jobWords(s.job), s.job.state === 'done' ? 'ok' : 'warn') : ''}
    <section class="card"><dl class="oc-dl">${rows}</dl>
      ${refusal ? html`<p class="oc-block">${refusal}</p>${s.code === 'changed' ? ask(name, 'link', 'Connect again') : ''}`
    : s.buttons.length ? html`<div class="oc-actions">${s.buttons.map(([what, words]) => ask(name, what, words))}</div>
      <p class="oc-help">Each button first shows what it will do, and asks for a code.</p>` : ''}
    </section>
    ${back}`,
  });
};

// ── The board ──
// The owner's steps (the same words as README and GOING-LIVE section 8).
const ownerSteps = () => html`<details class="oc-more"><summary class="btn btn-quiet">The key: set it up, change it, turn it off</summary>
  <h2>Before the key</h2>
  <ol class="oc-howto">
    <li>Promote, so production holds this release.</li>
    <li>Render → <code>base-platform</code> → <b>Settings</b>: Branch <code>production</code>; Build Command <code>npm ci --omit=dev --ignore-scripts</code>.</li>
    <li>GitHub: two-step sign-in on; protect <code>main</code> and <code>production</code> (no force push, CI required). Render: two-step sign-in on.</li>
    <li>Render → each database → <b>Recovery</b>: read what your plan keeps.</li>
    <li>Turn on Render’s notifications for each service and database.</li>
  </ol>
  <h2>Make the key</h2>
  <p>Render → your picture, top right → <b>Account Settings → API Keys → Create API Key</b>, named “base.win control centre” and the month. Copy it; Render shows it once.</p>
  <h2>Put it in</h2>
  <p>Render → <code>base-platform</code> → <b>Environment → Add</b> <code>RENDER_API_KEY</code>, paste, <b>Save and deploy</b>. Nowhere else: not a chat, an email, a note, a file, GitHub or this console.</p>
  <h2>Try it</h2>
  <p>This page says Connected. Press <b>Check Render’s answers</b>. Connect <b>Sample (staging)</b> and press each button there first; then connect each campaign. On any campaign that says “Open to anyone on the internet”: <b>Close the database to the internet</b>.</p>
  <h2>Change it</h2>
  <p>Every six months, after a lost laptop or phone, when anyone who could push code leaves, and on any doubt: make a new key, replace the value, Save and deploy, see Connected here, then remove the old key in Render.</p>
  <h2>Turn it off</h2>
  <p>Remove <code>RENDER_API_KEY</code> on <code>base-platform</code>, Save and deploy, then remove the key in Render. The control centre goes back to walking you through Render by hand.</p>
  <h2>If the key may have leaked</h2>
  <p>Render → Account Settings → API Keys → remove it; that ends it at once. Then follow “If the key may have leaked” in GOING-LIVE.md, section 8, before making a new one.</p>
</details>`;

const boardLine = (r) => {
  if (!r.linked) return r.v.envRow.server_url ? 'Not connected' : 'No Render address saved yet';
  if (failed(r.svc)) return 'Render didn’t answer';
  const parts = [r.svc.name];
  if (r.deploy?.ok) parts.push(DEPLOY_WORDS[r.deploy.state], r.deploy.commit, r.deploy.at ? dayClock(r.deploy.at) : null);
  if (r.v.campaign.kind === 'sample') parts.push('made-up data only');
  else if (r.db?.ok && r.db.open != null) parts.push(r.db.open ? 'database open to the internet' : 'database closed');
  return parts.filter(Boolean).join(' · ');
};

// b: { connected: { ok, label, problem }, warnings, rows, production, staging, promote, blueprint, logRows, names }
export const renderPage = ({ b, message = '' }) => page({
  title: 'Render', nav: true, here: 'render',
  body: html`<h1>Render</h1>
  ${status(b.connected.ok ? `Connected to Render${b.connected.label ? `: ${b.connected.label}` : ''}` : b.connected.words, b.connected.ok ? 'ok' : 'warn')}
  ${status(message, message ? 'warn' : '')}
  ${b.warnings.map((w) => html`<p class="oc-block">${w}</p>`)}
  ${b.connected.ok ? html`<section class="card"><h2>${b.looks.length ? `Needs a look (${b.looks.length})` : 'Nothing needs a look.'}</h2>
    ${b.looks.length ? html`<ul class="oc-chips">${b.looks.map(([display, words]) => html`<li class="chip chip-warn">${display}: ${words}</li>`)}</ul>` : ''}
    ${b.production ? html`<p>${b.production}</p>` : ''}
    ${b.staging ? html`<p>${b.staging}${b.promote ? html` <a href="${b.promote}" rel="noreferrer" target="_blank">Promote to production (GitHub) ↗</a>` : ''}</p>` : ''}
  </section>
  <ul class="oc-cards">${b.rows.map((r) => html`<li class="card oc-card">
    <a class="oc-name" href="/c/${r.v.campaign.name}/render">${r.v.campaign.display}</a>
    <span class="oc-line">${boardLine(r)}</span>
    ${r.linked ? html`<p><a class="btn btn-quiet" href="/c/${r.v.campaign.name}/render">Open</a></p>`
    : (r.v.envRow.server_url ? ask(r.v.campaign.name, 'link', 'Connect') : '')}
  </li>`)}</ul>
  <p>${b.blueprint}</p>
  <form method="post" action="/render/check" class="oc-form" data-busy="Asking Render…"><button class="btn btn-quiet" type="submit">Check Render’s answers</button></form>
  <p class="oc-help">Reads only. It asks Render each question this page relies on and says whether the answer came back as expected.</p>` : ''}
  <h2>Render changes on the log</h2>
  ${b.logRows.length ? html`<ol class="oc-log">${b.logRows.map((r) => logLine(r, b.names))}</ol>` : html`<p>Nothing yet.</p>`}
  ${ownerSteps()}`,
});

// ── Check Render’s answers ──
const CALL_WORDS = {
  self: 'The control centre’s own service', workspaces: 'The workspaces this key sees', services: 'The list of services', databases: 'The list of databases',
  blueprints: 'Blueprints', service: 'Staging’s service', lastDeploy: 'Staging’s last deploy', domains: 'Staging’s addresses',
  isSet: 'One setting read alone (STARBASE_ENV, set or not)', database: 'Staging’s database',
};
const checkWords = (l) => {
  if (l.ok) return 'As expected';
  if (l.problem) return `${problemWords(l.problem).replace(' Nothing was changed.', '')}${l.fields.length ? ` Missing: ${l.fields.join(', ')}.` : ''}${l.status ? ` (answer ${l.status})` : ''}`;
  return `Not as expected. Missing: ${l.fields.join(', ')}.`;
};
export const checkPage = ({ lines, sample }) => page({
  title: 'Check Render’s answers', nav: true, here: 'render',
  body: html`<h1>Check Render’s answers</h1>
  <p>Each question the Render page asks, and whether Render’s answer came back the way the control centre expects. Nothing was changed.</p>
  <section class="card"><dl class="oc-dl">${lines.map((l) => row(CALL_WORDS[l.call] || l.call, checkWords(l)))}</dl></section>
  ${sample ? '' : html`<p class="oc-block">Connect Sample (staging) to check the rest: its service, last deploy, addresses, one setting and its database.</p>`}
  ${status(lines.every((l) => l.ok) ? 'Every answer is as expected.' : 'Some answers are not as expected. Each is put right in one file, apps/platform/render-api.mjs; until then the pages say “not read” for what they can’t tell.', lines.every((l) => l.ok) ? 'ok' : 'warn')}
  <p><a class="btn btn-quiet" href="/render">Back to Render</a></p>`,
});
export { raw };
