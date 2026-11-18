// New campaign (its values), Set it up (four cards), and Add a campaign
// that’s already running.
import { html, raw } from './html.mjs';
import { page, field, status, codeField } from './layout.mjs';
import { inviteForm } from './desk.mjs';
import { PROVINCES, TIME_ZONES, RACES, JURISDICTIONS, RULE_WORDS, envLines } from '../snippets.mjs';

const NAME_HELP = 'Use letters, numbers and dashes. It’s the address: base.win/<name>.';
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
    ${select({ label: 'Time zone', name: 'tz', value: v.tz || 'America/Vancouver', options: TIME_ZONES.map((z) => [z, z.replace('America/', '').replace('_', ' ')]) })}
    <fieldset class="oc-fieldset"><legend>Races</legend>
      ${RACES.map(([code, words]) => html`<label class="oc-check-label"><input type="checkbox" name="races" value="${code}"${(v.races || ['council', 'school_board']).includes(code) ? raw(' checked') : ''}> ${words}</label>`)}
    </fieldset>
    <p class="oc-help">The map opens on the city. Candidates are added in the app later.</p>
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
  'not-answering': 'Not answering yet. Wait for ‘Live’ in Render, then press Save address again.',
  elsewhere: 'This server says it is somewhere else: check the address.',
};

// step: { answering, problem } of the saved address; door: { value, keeps, adds }.
export const setupPage = ({ v, values, publicKey, serverUrl, addressState, door, invited, snippet, stale = false, typed = null, message = '' }) => {
  const name = v.campaign.name;
  const answering = addressState === 'answering';
  return page({
    title: `Set up ${v.campaign.display}`, nav: true, here: 'campaigns',
    body: html`<h1>Set up ${v.campaign.display}</h1>
    <ol class="oc-steps">
      <li class="card"><h2>Make its database and service in Render</h2>
        <ol class="oc-howto">
          <li>Render → <b>New → Postgres</b>. Name <code>base-win-${name}-db</code>, region Oregon, PostgreSQL 16, the same plan as Imagine Surrey’s database.</li>
          <li>Render → <b>New → Web Service</b> → this repository. Name <code>base-win-${name}</code>, language Docker, branch <code>production</code>, region Oregon, instance Starter. Under Advanced, health check path <code>/api/health</code>.</li>
          <li>On that page, <b>Environment → Add from .env</b> → paste this block:
            ${envBlock({ name, display: v.campaign.display, values, publicKey })}
            <button class="btn btn-quiet" type="button" data-copy="env-block">Copy</button>
            <p class="oc-help" data-when-empty>STARBASE_TWO_STEP_KEY and GOOGLE_TOKEN_KEY are empty: press Generate next to each of these two in Render.</p>
          </li>
          <li>Add <code>DATABASE_URL</code> = the database page’s <b>Internal Database URL</b> (copy it across).</li>
          <li>Add <code>BASE_DOOR_KEY</code> = the same value as on the door (the service with base.win under Custom Domains).</li>
          <li>Press <b>Create Web Service</b> (or <b>Save and deploy</b>). Wait for “Live”.</li>
        </ol>
        <p class="oc-help">Email, texting and Google come later, from the app’s Settings → Services.</p>
      </li>
      <li class="card"><h2>Paste its address</h2>
        <form method="post" action="/c/${name}/setup" class="oc-form" data-busy="Checking…">
          ${field({ label: 'Render address', name: 'server_url', type: 'url', inputmode: 'url', required: true, value: typed ?? serverUrl ?? '', help: `The address at the top of its Render page, like https://base-win-${name}.onrender.com` })}
          ${codeField(stale)}
          ${status(message || (serverUrl ? (answering ? 'Answering' : ADDRESS_WORDS[addressState] || '') : ''), message || (serverUrl && !answering) ? 'warn' : (answering ? 'ok' : ''))}
          <button class="btn ${answering ? 'btn-quiet' : 'btn-primary'}" type="submit">Save address</button>
        </form>
      </li>
      ${answering ? html`<li class="card"><h2>Tell the door</h2>
        <p>Replace BASE_CLIENTS with this (Render → the service with base.win under Custom Domains → Environment), then Save and deploy.</p>
        <p>${door.keeps.length ? `This keeps: ${door.keeps.join(', ')}. ` : ''}Adds: ${door.adds.join(', ')}.</p>
        <pre class="oc-pre" id="door-value">${door.value}</pre>
        <button class="btn btn-quiet" type="button" data-copy="door-value">Copy</button>
        <p class="oc-help">If the door has a name not listed here, add that campaign first (Add a campaign that’s already running).</p>
      </li>
      <li class="card"><h2>Invite the first manager</h2>
        ${invited ? html`<p>First manager invited. <a href="/c/${name}">Go to ${v.campaign.display}</a></p>`
    : v.block ? html`<p class="oc-block">Not ready to open the desk yet: see <a href="/c/${name}">${v.campaign.display}</a>.</p>` : inviteForm(v, { primary: true })}
      </li>` : ''}
    </ol>
    <details class="oc-more"><summary class="btn btn-quiet">More</summary>
      <h2>Or ask us to add it to render.yaml</h2>
      <pre class="oc-pre" id="yaml-snippet">${snippet}</pre>
      <button class="btn btn-quiet" type="button" data-copy="yaml-snippet">Copy</button>
    </details>`,
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
