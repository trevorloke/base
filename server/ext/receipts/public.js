// /r/:token — the donor's own receipt. No sign-in: the link is the key (192
// random bits, never in the event log). It shows that one receipt and
// nothing else — no other gifts, no campaign data — and is never cached or
// indexed. A void receipt still opens, marked VOID.
import { Hono } from 'hono';
import { getDb } from '../../db/client.js';
import { loadSettings, docOf, campaignName, money, longDate, methodWord, agentLine } from './core.js';
import { publicHead, PUBLIC_CSS, campHtml, settingsOf } from '../../lib/publicpage.js';
import { brandFor, campaignBrand } from '../../lib/brand.js';

export const publicRoutes = new Hono();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// The campaign's public look (lib/publicpage.js: its brand, its logo over
// its name), with the receipt's own rules: the facts in a card, VOID and
// SAMPLE as stamps, and a plain black-on-white print.
const page = (brand, title, inner) => `<!doctype html><html lang="en"><head>${publicHead(brand, title, { noindex: true })}
<style>${PUBLIC_CSS}
  main{max-width:560px}
  h1{font-size:24px;margin:0 0 16px}
  .void{border:3px solid var(--bad);border-radius:var(--r-card);color:var(--bad);font:800 22px/1.2 'Inter',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;letter-spacing:.2em;text-align:center;padding:10px;margin:0 0 16px}
  dl{display:grid;grid-template-columns:max-content 1fr;gap:10px 16px;margin:0 0 20px;padding:18px;border:1px solid var(--rule);border-radius:var(--r-card);background:var(--card)}
  dt{font-size:14px;font-weight:500;line-height:1.7;color:var(--ink2)}
  dd{margin:0;overflow-wrap:anywhere}
  .n{font-weight:700;font-size:18px;font-variant-numeric:tabular-nums}
  p{margin:0 0 10px;color:var(--ink)}
  .notice{font-weight:700}
  @media(max-width:420px){dl{grid-template-columns:1fr;gap:2px}dd{margin-bottom:8px}}
  @media print{:root{--paper:#fff;--card:#fff;--ink:#000;--ink2:#333}button{display:none}main{padding:0}}
</style></head><body><main>
${inner}
</main></body></html>`;

const send = (c, status, html) => {
  c.header('Cache-Control', 'no-store');
  c.header('X-Robots-Tag', 'noindex');
  c.header('Referrer-Policy', 'no-referrer');
  return c.html(html, status);
};

export const receiptHtml = (doc, brand = brandFor(null)) => `
${campHtml(brand, doc.campaign)}
<h1>Contribution receipt</h1>
${doc.void ? '<div class="void" role="note">VOID</div>' : ''}
${doc.sample ? '<div class="void" role="note">SAMPLE</div>' : ''}
<dl>
  <dt>Receipt</dt><dd class="n">${esc(doc.number)}</dd>
  <dt>Received from</dt><dd>${esc(doc.contributor)}</dd>
  <dt>Home address</dt><dd>${doc.address ? esc(doc.address) : '<span class="muted">Not on file</span>'}</dd>
  <dt>Amount</dt><dd class="n">${esc(money(doc.amount_cents))}</dd>
  <dt>Date received</dt><dd>${esc(longDate(doc.received_on))}</dd>
  <dt>Method</dt><dd>${esc(methodWord(doc.method))}</dd>
</dl>
<p>Financial agent: ${esc(agentLine(doc))}</p>
<p class="notice">${esc(doc.notice)}</p>
${doc.footer ? `<p class="muted">${esc(doc.footer)}</p>` : ''}`;

publicRoutes.get('/r/:token', async (c) => {
  const token = c.req.param('token');
  const db = await getDb();
  const r = /^[0-9a-f]{48}$/.test(token)
    ? (await db.query('select * from receipts where token = $1', [token])).rows[0]
    : null;
  if (!r) return send(c, 404, page(await campaignBrand(), 'Receipt not found', '<h1>This receipt link isn’t valid.</h1>'));
  const settings = await loadSettings(db, r.workspace_id);
  const doc = docOf(r, settings, await campaignName(db, r.workspace_id));
  const ws = (await db.query('select settings from workspaces where id = $1', [r.workspace_id])).rows[0];
  const brand = brandFor(settingsOf(ws));
  return send(c, 200, page(brand, `Receipt ${doc.number} · ${doc.campaign}`,
    `${receiptHtml(doc, brand)}\n<button type="button" onclick="window.print()">Print</button>`));
});
