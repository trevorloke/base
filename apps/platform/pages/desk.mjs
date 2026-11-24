// Opening a campaign's desk: the Open desk and Invite forms (each opens a
// new tab: the platform answers with a redirect to the campaign's own
// address), the checklist, and base.win’s key.
import { html, raw } from './html.mjs';
import { page, field, status, codeField } from './layout.mjs';
import { ITEMS, MANUAL, wordsOf } from '../checklist.mjs';
import { pubkeyValue } from '../keys.mjs';

// A new tab, with nothing of this page passed on (no opener, no referrer).
const NEW_TAB = raw(' target="_blank" rel="noopener noreferrer"');

export const openForm = (v, { primary = false } = {}) => html`<form method="post" action="/c/${v.campaign.name}/open"${NEW_TAB} class="oc-inline-form">
  <input type="hidden" name="env" value="${v.env}">
  <button class="btn ${primary ? 'btn-primary' : 'btn-quiet'}" type="submit">Open desk</button>
</form>`;

export const inviteForm = (v, { primary = false, help = 'Do this first, so the campaign has its own manager.' } = {}) => html`<form method="post" action="/c/${v.campaign.name}/invite"${NEW_TAB} class="oc-form oc-invite">
  <input type="hidden" name="env" value="${v.env}">
  ${field({ label: 'Their email', name: 'email', type: 'email', autocomplete: 'off', required: true, id: `invite-${v.campaign.name}`, help })}
  <button class="btn ${primary ? 'btn-primary' : 'btn-quiet'}" type="submit">Invite and open the desk</button>
</form>`;

const DONE_WORDS = { auto: 'Done by itself', you: 'Done by you' };

// stale: the item whose form's code window passed (it shows a Code field).
export const checklist = (name, done, { stale = '' } = {}) => html`<ol class="oc-check">${ITEMS.map((i) => {
  const d = done.get(i.key);
  const manual = MANUAL.includes(i.key);
  return html`<li class="oc-check-item${d ? ' oc-done' : ''}">
    <span class="oc-check-words">${wordsOf(i.key, name)}</span>
    <span class="oc-check-state">${d ? DONE_WORDS[d.done_by] || 'Done' : 'Not yet'}</span>
    ${manual && (!d || d.done_by === 'you' || i.key === 'first-manager-invited') ? html`<form method="post" action="/c/${name}/tick" class="oc-inline-form">
      <input type="hidden" name="item" value="${i.key}"><input type="hidden" name="done" value="${d ? '0' : '1'}">
      ${codeField(stale === i.key)}
      <button class="btn btn-quiet" type="submit" aria-label="${d ? 'Untick' : 'Tick'}: ${wordsOf(i.key, name)}">${d ? 'Untick' : 'Tick'}</button>
    </form>` : ''}
  </li>`;
})}</ol>`;

// No usable signing key: there is no public half to hand to a campaign.
export const NO_KEY_WORDS = 'PLATFORM_SIGNING_KEY in Render is missing or too short. Press Generate next to it, then Save and deploy.';

// base.win’s key: what each campaign's BASE_PLATFORM_PUBKEY holds.
export const keyPage = ({ keys, missing, short = 0 }) => page({
  title: 'base.win’s key', nav: true, here: 'key',
  body: html`<section class="card oc-narrow oc-keypage"><h1>base.win’s key</h1>
  ${keys.length && short ? status(`PLATFORM_SIGNING_KEY in Render has ${short === 1 ? 'a value' : `${short} values`} after the first that ${short === 1 ? 'is' : 'are'} too short, so ${short === 1 ? 'it is' : 'they are'} left out. Press Generate for a new key, keeping the old one first.`, 'warn') : ''}
  ${keys.length ? html`<p>Paste this as BASE_PLATFORM_PUBKEY on each campaign’s service in Render, then Save and deploy.</p>
    <div class="oc-copy">
      <p class="oc-help">The setting</p>
      <pre class="oc-pre" id="key-name">BASE_PLATFORM_PUBKEY</pre>
      <button class="btn btn-quiet oc-copy-btn" type="button" data-copy="key-name">Copy the name</button>
    </div>
    <div class="oc-copy">
      <p class="oc-help">${keys.length > 1 ? 'Its value: the new key, then the old one' : 'Its value'}</p>
      <pre class="oc-pre" id="key-value">${pubkeyValue(keys)}</pre>
      <button class="btn btn-primary oc-wide" type="button" data-copy="key-value">Copy</button>
    </div>
    ${keys.length > 1 && missing.length ? status(`Don’t remove the old key yet: ${missing.join(', ')} don’t have the new one.`, 'warn') : status('')}`
    : status(NO_KEY_WORDS, 'warn')}
  </section>`,
});

// The code window passed on Open or Invite: this is already the new tab.
export { typeCodePage } from './auth.mjs';
