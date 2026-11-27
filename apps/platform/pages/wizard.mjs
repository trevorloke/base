// New campaign (its values), Set it up (four cards; two for a campaign
// that was already running), and Add a campaign that’s already running.
import { html, raw } from './html.mjs';
import { page, field, status, codeField } from './layout.mjs';
import { inviteForm, NO_KEY_WORDS } from './desk.mjs';
import { NAME_HELP, publicHost } from '../campaigns.mjs';
import { PROVINCES, TIME_ZONES, RACES, JURISDICTIONS, RULE_WORDS, envLines } from '../snippets.mjs';

// "America/St_Johns" reads "St. John’s"; the rest lose "America/" and "_".
const zoneWords = (z) => (z === 'America/St_Johns' ? 'St. John’s' : z.replace('America/', '').replace(/_/g, ' '));
const select = ({ label, name, options, value, help = '' }) => html`<div class="field">
  <label for="${name}">${label}</label>
  <select class="input" id="${name}" name="${name}"${help ? html` aria-describedby="${name}-help"` : ''}>
    ${options.map(([v, words, data]) => html`<option value="${v}"${v === value ? raw(' selected') : ''}${data ? html` data-tz="${data}"` : ''}>${words}</option>`)}
  </select>
  ${help ? html`<p class="oc-help" id="${name}-help">${help}</p>` : ''}
</div>`;

export const newPage = ({ v = {}, stale = false, message = '' } = {}) => page({
  title: 'New campaign', nav: true, here: 'campaigns',
  body: html`<section class="card oc-narrow"><h1>New campaign</h1>
  <form method="post" action="/new" class="oc-form">
    ${field({ label: 'Short name', name: 'name', value: v.name || '', required: true, autocomplete: 'off', help: NAME_HELP })}
    ${field({ label: 'Campaign name', name: 'display', value: v.display || '', required: true, autocomplete: 'off' })}
    ${field({ label: 'City', name: 'city', value: v.city || '', required: true, autocomplete: 'off' })}
    ${select({ label: 'Province', name: 'province', value: v.province || 'BC', options: PROVINCES.map(([code, words, tz]) => [code, words, tz]) })}
    ${select({ label: 'Rules', name: 'rules', value: v.rules || 'bc-municipal', options: JURISDICTIONS.map((j) => [j, RULE_WORDS[j]]) })}
    ${select({ label: 'Time zone', name: 'tz', value: v.tz || 'America/Vancouver', options: TIME_ZONES.map((z) => [z, zoneWords(z)]) })}
    <fieldset class="oc-fieldset"><legend>Races</legend>
      ${RACES.map(([code, words]) => html`<label class="oc-check-label"><input type="checkbox" name="races" value="${code}"${(v.races || ['council', 'school_board']).includes(code) ? raw(' checked') : ''}> ${words}</label>`)}
    </fieldset>
    <fieldset class="oc-fieldset"><legend>Map area</legend>
      <p class="oc-help">A box around the city: the map opens on it and addresses are looked for inside it.</p>
      ${field({ label: 'South-west corner', name: 'sw', value: v.sw || '', required: true, autocomplete: 'off', help: 'In Google Maps, right-click the bottom-left corner of the city, then click the two numbers at the top of the menu to copy them. Paste them here.' })}
      ${field({ label: 'North-east corner', name: 'ne', value: v.ne || '', required: true, autocomplete: 'off', help: 'The same for the top-right corner of the city.' })}
    </fieldset>
    <p class="oc-help">Candidates are added in the app later.</p>
    ${codeField(stale)}
    ${status(message, message ? 'warn' : '')}
    <button class="btn btn-primary oc-wide" type="submit">Next</button>
  </form></section>`,
});

// The .env block: the random lines are empty spans the page's script fills.
const envBlock = (opts) => html`<pre class="oc-pre" id="env-block">${envLines(opts).map((l, i) => html`${i ? '\n' : ''}${l.key}=${l.random ? raw('<span data-random></span>') : l.value}`)}</pre>`;

// The address card's answer, next to the field.
const ADDRESS_WORDS = {
  'not-checked': 'Not checked yet.',
  'not-answering': 'Not answering yet. Wait for ‘Live’ in Render, then press Save address again. If it never goes ‘Live’, its Render log says why: with DATABASE_URL empty the server won’t start.',
  elsewhere: 'This server says it is somewhere else: check the address.',
  'old-release': 'Answering, but on a release from before base.win sign-in. Run Promote to production (GitHub → Actions), wait for ‘Live’ in Render, then press Save address again.',
};

// No usable signing key: the warning the key page shows, where the key would be.
const noKey = html`${status(NO_KEY_WORDS, 'warn')}
  <p class="oc-help">That setting is on the control centre’s own service in Render (base-platform). What to paste shows here once it is set.</p>`;

// "Give it its address": <name>.base.win, a custom domain on the campaign's
// own service. state: what the last check of that address said
// (campaigns.mjs publicState). old: the campaign is on a release from
// before base.win sign-in, which never says which server it is.
const PUBLIC_WORDS = {
  'not-answering': (host) => `Not answering at ${host} yet. It is checked every 5 minutes.`,
  elsewhere: (host) => `${host} answers, but from another server: check the CNAME record.`,
  unknown: (host, old) => (old ? `${host} answers. Whether it is this campaign’s server shows after Promote to production.`
    : `${host} answers. Whether it is this campaign’s server isn’t known yet: see the campaign’s page.`),
  answering: (host) => `Answering at ${host}`,
};
const publicCard = ({ name, serverUrl, state, old = false }) => {
  const host = publicHost(name);
  let target = '';
  try { target = serverUrl ? new URL(serverUrl).host : ''; } catch { target = ''; }
  const words = PUBLIC_WORDS[state]?.(host, old) || '';
  return html`<li class="card"><h2>Give it its address</h2>
    <ol class="oc-howto">
      <li>Render → this campaign’s service → <b>Settings → Custom Domains</b> → add <code>${host}</code>.</li>
      <li>Where base.win’s domain is registered, add a <b>CNAME</b> record named <code>${name}</code> pointing at ${target ? html`<code>${target}</code>` : 'the service’s onrender.com address (at the top of its Render page)'}.</li>
      <li>Wait until Render shows the domain as verified and its certificate as issued.</li>
    </ol>
    ${status(words, words ? (state === 'answering' ? 'ok' : 'warn') : '')}
    <p class="oc-help">“Answers at ${host}” on the campaign’s checklist ticks by itself.</p>
  </li>`;
};

// The first manager's invite link is made from the campaign's own address
// (its STARBASE_PUBLIC_URL), so it opens only once that address is ready.
const inviteNotReady = (name) => `Their invite link goes to ${publicHost(name)}, which isn’t ready yet. The link opens once it is: do “Give it its address” first.`;

// Stage 2, with a Render key and Check Render’s answers done: card 1 is
// Make it in Render. make: { lines: [[words, 'Done' | 'Not yet' | 'Failed']],
// words, button ('Make it in Render' | 'Carry on' | null), began, refresh }.
const makeCard = ({ name, make, answering }) => html`<li class="card"><h2>Make it in Render</h2>
        ${make.began ? '' : html`<p>Makes its database and service in Render from here, with this campaign’s own settings, then adds ${publicHost(name)}. It asks for a code first.</p>`}
        <dl class="oc-dl oc-make">${make.lines.map(([k, w]) => html`<div><dt>${k}</dt><dd>${w}</dd></div>`)}</dl>
        ${status(make.words, make.words ? (make.done ? 'ok' : 'warn') : '')}
        ${make.button ? html`<form method="post" action="/c/${name}/render/make" class="oc-form" data-busy="Asking Render…">
          <button class="btn ${answering ? 'btn-quiet' : 'btn-primary'} oc-wide" type="submit">${make.button}</button>
        </form>` : ''}
        <p class="oc-help">Email, texting and Google come later, from the app’s Settings → Services. Or do it by hand: More, below.</p>
      </li>`;

export const setupPage = ({ v, values, publicKey, serverUrl, addressState, publicState, invited, snippet, stale = false, typed = null, message = '', make = null }) => {
  const name = v.campaign.name;
  const answering = addressState === 'answering';
  const invite = publicState === 'answering' ? { primary: true } : { primary: true, help: inviteNotReady(name) };
  const handCard = html`<li class="card"><h2>Make its database and service in Render</h2>
        <ol class="oc-howto">
          <li>Render → <b>New → Postgres</b>. Name <code>base-win-${name}-db</code>, region Oregon, PostgreSQL 16, the plan named in <code>render.yaml</code> (<code>basic-1gb</code>).</li>
          <li>Render → <b>New → Web Service</b> → this repository. Name <code>base-win-${name}</code>, language Docker, branch <code>production</code>, region Oregon, instance Starter. Under Advanced, health check path <code>/api/health</code>.</li>
          <li>On that page, <b>Environment → Add from .env</b> → paste this block:
            ${publicKey ? html`${envBlock({ name, display: v.campaign.display, values, publicKey })}
            <button class="btn btn-quiet oc-copy-btn" type="button" data-copy="env-block">Copy</button>
            <p class="oc-help" data-when-empty>STARBASE_TWO_STEP_KEY and GOOGLE_TOKEN_KEY are empty: press Generate next to each of these two in Render.</p>` : noKey}
          </li>
          <li>Add <code>DATABASE_URL</code> = the database page’s <b>Internal Database URL</b> (copy it across).</li>
          <li>Press <b>Create Web Service</b> (or <b>Save and deploy</b>). Wait for “Live”.</li>
        </ol>
        <p class="oc-help">Email, texting and Google come later, from the app’s Settings → Services.</p>
      </li>`;
  const pasteCard = (quiet) => html`<li class="card"><h2>Paste its address</h2>
        <form method="post" action="/c/${name}/setup" class="oc-form" data-busy="Checking…">
          ${field({ label: 'Render address', name: 'server_url', type: 'url', inputmode: 'url', required: true, value: typed ?? serverUrl ?? '', help: `The address at the top of its Render page, like https://base-win-${name}.onrender.com` })}
          ${codeField(stale)}
          ${status(message || (serverUrl ? (answering ? 'Answering' : ADDRESS_WORDS[addressState] || '') : ''), message || (serverUrl && !answering) ? 'warn' : (answering ? 'ok' : ''))}
          <button class="btn ${answering || quiet ? 'btn-quiet' : 'btn-primary'}" type="submit">Save address</button>
        </form>
      </li>`;
  return page({
    title: `Set up ${v.campaign.display}`, nav: true, here: 'campaigns', refresh: make?.refresh ? 15 : 0,
    body: html`<h1>Set up ${v.campaign.display}</h1>
    <ol class="oc-steps">
      ${make ? makeCard({ name, make, answering }) : handCard}
      ${make ? '' : pasteCard(false)}
      ${answering ? html`${publicCard({ name, serverUrl, state: publicState })}
      <li class="card"><h2>Invite the first manager</h2>
        ${invited ? html`<p>First manager invited. <a href="/c/${name}">Go to ${v.campaign.display}</a></p>`
    : v.block ? html`<p class="oc-block">Not ready to open the desk yet: see <a href="/c/${name}">${v.campaign.display}</a>.</p>` : inviteForm(v, invite)}
      </li>` : ''}
    </ol>
    <details class="oc-more"><summary class="btn btn-quiet">More</summary>
      ${make ? html`<h2>Or do it by hand</h2>
      <ol class="oc-steps">${handCard}${pasteCard(true)}</ol>
      ` : ''}${make?.began ? '' : html`<h2>Or ask us to add it to render.yaml</h2>
      <p>Each of the campaign's own settings is <code>sync: false</code>. Set it on the new service in Render, to the value after its <code>#</code>.</p>
      <pre class="oc-pre" id="yaml-snippet">${snippet}</pre>
      <button class="btn btn-quiet oc-copy-btn" type="button" data-copy="yaml-snippet">Copy</button>`}
    </details>`,
  });
};

// Set-up steps for a campaign added when it was already running. Nothing
// was typed here to make its settings from, so this page shows none: only
// the one line every campaign gets (base.win’s public key) and its address.
// On a release from before base.win sign-in the line isn't read yet, so
// Promote comes first; adding the line early does no harm.
const OLD_RELEASE_WORDS = 'This campaign is on a release from before base.win sign-in, which doesn’t read the line below. Run Promote to production (GitHub → Actions) first, wait for ‘Live’ in Render, then press Check now on its page.';
export const runningSetupPage = ({ v, publicKey, serverUrl, publicState, entry = null, message = '' }) => {
  const name = v.campaign.name;
  const old = entry === 'old-release';
  return page({
    title: `Set up ${v.campaign.display}`, nav: true, here: 'campaigns',
    body: html`<h1>Set up ${v.campaign.display}</h1>
    <p>This campaign was already running when it was added here, so its settings live in Render (its service → <b>Environment</b>). Two things are set from here.</p>
    ${status(message, message ? 'warn' : '')}
    <ol class="oc-steps">
      <li class="card"><h2>Let base.win sign in</h2>
        ${old ? status(OLD_RELEASE_WORDS, 'warn') : ''}
        ${publicKey ? html`<p>Render → this campaign’s service → <b>Environment</b> → add this line, then <b>Save and deploy</b>.</p>
        <pre class="oc-pre" id="key-line">BASE_PLATFORM_PUBKEY=${publicKey}</pre>
        <button class="btn btn-quiet oc-copy-btn" type="button" data-copy="key-line">Copy</button>
        ${status(entry === 'ready' ? 'base.win sign-in is ready there' : '', entry === 'ready' ? 'ok' : '')}` : noKey}
      </li>
      ${publicCard({ name, serverUrl, state: publicState, old })}
    </ol>
    <p><a class="btn btn-quiet" href="/c/${name}">Back to ${v.campaign.display}</a></p>`,
  });
};

export const existingPage = ({ v = {}, stale = false, message = '' } = {}) => page({
  title: 'Add a running campaign', nav: true, here: 'campaigns',
  body: html`<section class="card oc-narrow"><h1>Add a running campaign</h1>
  <form method="post" action="/existing" class="oc-form" data-busy="Adding…">
    ${field({ label: 'Short name', name: 'name', value: v.name || '', required: true, autocomplete: 'off', help: NAME_HELP })}
    ${field({ label: 'Campaign name', name: 'display', value: v.display || '', required: true, autocomplete: 'off' })}
    ${field({ label: 'Render address', name: 'server_url', type: 'url', inputmode: 'url', value: v.server_url || '', required: true, help: 'The address at the top of its Render page.' })}
    ${codeField(stale)}
    ${status(message, message ? 'warn' : '')}
    <button class="btn btn-primary oc-wide" type="submit">Add</button>
  </form></section>`,
});
