// Campaigns (/), one campaign (/c/:name) and its Edit page.
import { html, raw, num, clock, ago, dayClock } from './html.mjs';
import { page, field, status, codeField } from './layout.mjs';
import { logLine } from './log.mjs';

const ENV_WORD = { production: 'Production', staging: 'Staging' };
const VALUE_WORDS = { city: 'City', province: 'Province', rules: 'Rules', tz: 'Time zone', races: 'Races' };

// "Production · Answering · d9130ae · checked 2 min ago" (or "Not answering since 3:10 pm").
export const statusLine = (v, now = Date.now()) => {
  if (!v.envRow.server_url) return 'No address yet';
  if (!v.server) return 'Not checked yet';
  const parts = [];
  if (v.campaign.kind === 'client') parts.push(ENV_WORD[v.env]);
  if (v.server.answering) {
    parts.push('Answering');
    if (v.server.commit) parts.push(v.server.commit);
  } else {
    parts.push(v.since ? `Not answering since ${clock(v.since)}` : 'Not answering');
  }
  parts.push(`checked ${ago(v.server.at, now)}`);
  return parts.join(' · ');
};

const chips = (list) => (list.length ? html`<ul class="oc-chips" aria-label="Needs a look">${list.map((t) => html`<li class="chip chip-warn">${t}</li>`)}</ul>` : '');

export const campaignsPage = ({ views }) => {
  const sample = views.find((v) => v.campaign.kind === 'sample');
  const clients = views.filter((v) => v.campaign.kind === 'client' && !v.campaign.archived_at);
  const archived = views.filter((v) => v.campaign.kind === 'client' && v.campaign.archived_at);
  return page({
    title: 'Campaigns', nav: true, here: 'campaigns',
    body: html`<div class="oc-head"><h1>Campaigns</h1><a class="btn btn-primary" href="/new">New campaign</a></div>
    ${sample ? html`<section class="oc-sample card" aria-label="${sample.campaign.display}">
      <a class="oc-name" href="/c/sample">${sample.campaign.display}</a>
      <span class="oc-line">${statusLine(sample)}</span>
      ${sample.envRow.server_url ? '' : html`<a class="btn btn-quiet" href="/c/sample/edit">Set its address</a>`}
      ${chips(sample.chips)}
    </section>` : ''}
    ${clients.length ? html`<ul class="oc-cards">${clients.map((v) => html`<li class="card oc-card">
        <a class="oc-name" href="/c/${v.campaign.name}">${v.campaign.display}</a>
        <span class="oc-line">${statusLine(v)}</span>
        ${chips(v.chips)}
      </li>`)}</ul>
      <details class="oc-more"><summary class="btn btn-quiet">More</summary>
        <p><a href="/existing">Add a campaign that’s already running</a></p>
        ${archived.length ? html`<h2>Archived</h2><ul>${archived.map((v) => html`<li><a href="/c/${v.campaign.name}">${v.campaign.display}</a></li>`)}</ul>` : ''}
      </details>`
    : html`<p>No campaigns yet.</p>
      <p><a class="btn btn-quiet" href="/existing">Add a campaign that’s already running</a></p>
      ${archived.length ? html`<details class="oc-more"><summary class="btn btn-quiet">More</summary><h2>Archived</h2><ul>${archived.map((v) => html`<li><a href="/c/${v.campaign.name}">${v.campaign.display}</a></li>`)}</ul></details>` : ''}`}`,
  });
};

const ENTRY_WORDS = { ready: 'Ready', 'not-set-up': 'Not set up', 'wrong-key': 'Key in Render is wrong' };

// Why the desk can't be opened, in one line.
export const BLOCK_WORDS = {
  archived: 'Archived — bring it back under More to open the desk.',
  'no-address': 'No Render address saved yet — add it under More → Edit.',
  'not-checked': 'Not checked yet — press Check now.',
  'not-answering': 'Not answering — can’t open the desk.',
  'not-set-up': 'base.win sign-in isn’t set up there: add BASE_PLATFORM_PUBKEY in Render (copy it from base.win’s key), Save and deploy. If you just did, wait for ‘Live’, then press Check now.',
  'wrong-key': 'Key in Render is wrong: copy base.win’s key again, then Save and deploy.',
  elsewhere: 'This server says it is somewhere else — check the Render address saved here.',
  changed: 'This server has changed since it was added.',
};

const health = (v, entry) => {
  const s = v.server;
  const rows = [
    ['Answering', !s ? 'Not checked yet' : s.answering ? 'Yes' : (v.since ? `No, since ${clock(v.since)}` : 'No')],
    ['Version', s?.commit || '—'],
    ['Database', !s?.answering ? '—' : s.database === 'ok' ? 'Fine' : 'Not reachable'],
    ['Time zone data', !s?.answering || s.tz_current == null ? '—' : s.tz_current ? 'Current' : 'Old'],
    ['base.win sign-in', entry ? ENTRY_WORDS[entry] : '—'],
    ['Render address', v.envRow.server_url || 'Not saved'],
    ['base.win address', s?.address || '—'],
    ['Last checked', s ? dayClock(s.at) : 'Not yet'],
  ];
  return html`<dl class="oc-dl">${rows.map(([k, val]) => html`<div><dt>${k}</dt><dd>${val}</dd></div>`)}</dl>`;
};

const strip = (hist) => html`<div class="oc-strip" role="img" aria-label="The last 24 hours, hour by hour">${hist.strip.map((s) => html`<span class="oc-hour oc-hour-${s}"></span>`)}</div>
  <p class="oc-help">${hist.total ? `Answered ${num(hist.answered)} of ${num(hist.total)} ${hist.total === 1 ? 'check' : 'checks'} today` : 'No checks yet today'}</p>`;

// stale: which form's code window passed ('archive' | 'confirm'), so it shows a Code field.
export const campaignPage = ({ v, entry, logRows, names, stale = '', message = '', openSlot = '' }) => {
  const c = v.campaign;
  const values = Object.entries(c.values || {});
  return page({
    title: c.display, nav: true, here: 'campaigns',
    body: html`<h1>${c.display}</h1>
    ${chips(v.chips)}
    ${status(message, message ? 'warn' : '')}
    ${v.block ? html`<p class="oc-block">${BLOCK_WORDS[v.block] || ''}</p>` : openSlot}
    ${v.block === 'changed' ? html`<form method="post" action="/c/${c.name}/confirm-server" class="oc-form">
      <input type="hidden" name="env" value="${v.env}">
      ${codeField(stale === 'confirm')}
      <button class="btn" type="submit">Confirm it’s the same campaign</button>
    </form>` : ''}
    <section class="card"><h2>Health</h2>
      ${health(v, entry)}
      ${strip(v.history)}
      <form method="post" action="/c/${c.name}/check-now"><button class="btn btn-quiet" type="submit">Check now</button></form>
    </section>
    <details class="oc-more"${stale === 'archive' ? raw(' open') : ''}><summary class="btn btn-quiet">More</summary>
      <p><a class="btn btn-quiet" href="/c/${c.name}/edit">Edit</a></p>
      ${c.kind === 'client' ? html`<form method="post" action="/c/${c.name}/${c.archived_at ? 'unarchive' : 'archive'}" class="oc-form">
        ${codeField(stale === 'archive')}
        <button class="btn btn-quiet" type="submit">${c.archived_at ? 'Bring it back' : 'Archive'}</button>
      </form>` : ''}
      ${values.length ? html`<h2>Its values</h2><dl class="oc-dl">${values.map(([k, val]) => html`<div><dt>${VALUE_WORDS[k] || k}</dt><dd>${Array.isArray(val) ? val.join(', ') : val}</dd></div>`)}</dl>` : ''}
      <h2>Its log</h2>
      ${logRows.length ? html`<ol class="oc-log">${logRows.map((r) => logLine(r, names))}</ol>` : html`<p>Nothing yet.</p>`}
    </details>`,
  });
};

export const editPage = ({ c, serverUrl = '', display = c.display, stale = false, message = '' }) => page({
  title: `Edit ${c.display}`, nav: true, here: 'campaigns',
  body: html`<section class="card oc-narrow"><h1>Edit ${c.display}</h1>
  <form method="post" action="/c/${c.name}/edit" class="oc-form">
    ${field({ label: 'Campaign name', name: 'display', value: display, required: true })}
    ${field({ label: 'Render address', name: 'server_url', type: 'url', value: serverUrl, inputmode: 'url', help: `The address at the top of its Render page, like https://base-win-${c.name}.onrender.com` })}
    ${codeField(stale)}
    ${status(message, message ? 'warn' : '')}
    <button class="btn btn-primary oc-wide" type="submit">Save</button>
  </form>
  <p><a class="btn btn-quiet" href="/c/${c.name}">Back</a></p></section>`,
});
