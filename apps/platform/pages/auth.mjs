// Setup and sign-in screens. One job each, one primary button each.
import { html, raw } from './html.mjs';
import { page, field, status } from './layout.mjs';

const card = (body) => html`<section class="card oc-narrow">${body}</section>`;

export const setupProblemPage = (problem) => page({
  title: 'Set up the control centre',
  body: card(html`<h1>Set up the control centre</h1>
  ${status(problem === 'short'
    ? 'The setup code in Render is too short. Press Generate next to OPS_SETUP_CODE, then Save and deploy.'
    : 'OPS_SECRET in Render is missing or too short. Press Generate next to it, then Save and deploy.', 'warn')}`),
});

export const setupCodePage = ({ message = '' } = {}) => page({
  title: 'Set up the control centre',
  body: card(html`<h1>Set up the control centre</h1>
  <form method="post" action="/setup" class="oc-form">
    ${field({ label: 'Setup code', name: 'code', autocomplete: 'off', required: true, help: 'Render → base-platform → Environment → OPS_SETUP_CODE.' })}
    ${status(message, message ? 'warn' : '')}
    <button class="btn btn-primary oc-wide" type="submit">Continue</button>
  </form>`),
});

export const setupYouPage = ({ name = '', email = '', message = '' } = {}) => page({
  title: 'About you',
  body: card(html`<h1>About you</h1>
  <form method="post" action="/setup/you" class="oc-form">
    ${field({ label: 'Your name', name: 'name', value: name, autocomplete: 'name', required: true })}
    ${field({ label: 'Email', name: 'email', type: 'email', value: email, autocomplete: 'email', required: true,
    help: 'Use the email you sign in with on Imagine Surrey if you’re a manager there. Otherwise use another address, such as you+support@…' })}
    ${field({ label: 'Password', name: 'password', type: 'password', autocomplete: 'new-password', required: true, help: '12 or more characters.' })}
    ${status(message, message ? 'warn' : '')}
    <button class="btn btn-primary oc-wide" type="submit">Next</button>
  </form>`),
});

export const setupAppPage = ({ setup, message = '' }) => page({
  title: 'Add it to your authenticator app',
  body: card(html`<h1>Add it to your authenticator app</h1>
  ${setup.qr ? html`<svg class="oc-qr" role="img" aria-label="QR code for your authenticator app" viewBox="0 0 ${setup.qr.size} ${setup.qr.size}" xmlns="http://www.w3.org/2000/svg"><rect width="${setup.qr.size}" height="${setup.qr.size}" fill="#fff"/><path d="${setup.qr.d}" fill="#000"/></svg>` : ''}
  <p><a href="${setup.uri}">Add to an authenticator app on this phone</a></p>
  <p class="oc-key" aria-label="The key, to type in by hand">${setup.grouped}</p>
  <p class="oc-help">Google Authenticator, Microsoft Authenticator or 1Password all work.</p>
  <form method="post" action="/setup/app" class="oc-form">
    ${field({ label: 'Code', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', required: true })}
    ${status(message, message ? 'warn' : '')}
    <button class="btn btn-primary oc-wide" type="submit">Turn on</button>
  </form>`),
});

export const setupCodesPage = (codes) => page({
  title: 'Your recovery codes',
  body: card(html`<h1>Your recovery codes</h1>
  <ol class="oc-codes">${codes.map((c) => html`<li>${c}</li>`)}</ol>
  <p>Each works once if you lose your phone. Keep them somewhere safe.</p>
  <a class="btn btn-primary oc-wide" href="/">I’ve saved them</a>`),
});

export const signinPage = ({ email = '', message = '', setupOpen = false } = {}) => page({
  title: 'Sign in',
  body: card(html`<h1>base.win control centre</h1>
  <form method="post" action="/signin" class="oc-form">
    ${field({ label: 'Email', name: 'email', type: 'email', value: email, autocomplete: 'username', required: true })}
    ${field({ label: 'Password', name: 'password', type: 'password', autocomplete: 'current-password', required: true })}
    ${field({ label: 'Code', name: 'code', autocomplete: 'one-time-code', required: true, help: '6-digit code from your authenticator app, or a recovery code.' })}
    ${status(message, message ? 'warn' : '')}
    <button class="btn btn-primary oc-wide" type="submit">Sign in</button>
  </form>
  ${setupOpen ? html`<p><a class="btn btn-quiet" href="/setup">Set up</a></p>` : ''}`),
});

// The code window passed on a route that opens a desk: a fresh code, then
// the same route again, in this same tab.
export const typeCodePage = ({ action, keep = {}, message = '' }) => page({
  title: 'Type your code',
  body: card(html`<h1>Type your code</h1>
  <form method="post" action="${action}" class="oc-form">
    ${Object.entries(keep).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
    ${field({ label: 'Code', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', required: true, help: 'Opening a desk needs a fresh code.' })}
    ${status(message, message ? 'warn' : '')}
    <button class="btn btn-primary oc-wide" type="submit">Continue</button>
  </form>`),
});
export { raw };
