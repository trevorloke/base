// The log: newest first, 100 a page, with whether the chain holds.
import { html, num, dayClock } from './html.mjs';
import { page, status } from './layout.mjs';
import { wordsFor } from '../words.mjs';

export const logLine = (r, names) => html`<li class="oc-logline"><span class="oc-when">${dayClock(r.at)}</span> · ${wordsFor(r.action, r.payload)}${r.campaign ? html` · ${names.get(r.campaign) || r.campaign}` : ''}</li>`;

export const logPage = ({ check, rows, names, older }) => page({
  title: 'Log', nav: true, here: 'log',
  body: html`<h1>Log</h1>
  ${status(check.ok ? `Log intact · ${num(check.lines)} ${check.lines === 1 ? 'line' : 'lines'}` : `Changed at line ${num(check.line)}`, check.ok ? 'ok' : 'danger')}
  ${rows.length ? html`<ol class="oc-log">${rows.map((r) => logLine(r, names))}</ol>` : html`<p>Nothing yet.</p>`}
  ${older ? html`<p><a class="btn btn-quiet" href="/log?before=${older}">Older</a></p>` : ''}`,
});
