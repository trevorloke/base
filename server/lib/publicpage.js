// The look of the app's own public pages — unsubscribe, a donor's receipt
// (ext/receipts), a ladder email's unsubscribe (ext/ladders), a public
// lesson (ext/learn): the campaign's brand (lib/brand.js) on the app's own
// neutral grounds. Its logo over its name, a rule and the one button in its
// colour, Inter, sentence case, light or dark as the reader's device is.
// One column, one big button, and a link back to the campaign's website
// (workspace settings.website) when it has one. The campaign's website
// itself lives elsewhere.
import { deriveLook } from '@starbase/shared/brand-look';
import { FONT_BY_VALUE } from '@starbase/shared/site/theme';
import { brandFor } from './brand.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
export const settingsOf = (ws) => (typeof ws?.settings === 'string' ? JSON.parse(ws.settings) : (ws?.settings || {}));

// The brand's shades as these pages name them, light and dark — each
// readable where it is used, by the one rule (shared/brand-look.js) — and
// its corners and heading face. Errors are the app's own danger colour.
const DANGER = { light: '#c8151b', dark: '#ff8a8a' };
const looks = new WeakMap();
export const publicLook = (brand) => {
  if (looks.has(brand)) return looks.get(brand);
  const vars = (scheme) => {
    const l = deriveLook(brand, scheme);
    return `--paper:${l.page};--card:${l.card};--ink:${l.text};--ink2:${l.quiet};--rule:${l.line};--field:${l.fieldEdge};`
      + `--mark:${l.accent};--mark-ink:${l.accentInk};--mark-hover:${l.accentHover};--words:${l.accentWords};--edge:${l.accentEdge};--bad:${DANGER[scheme]}`;
  };
  const light = deriveLook(brand, 'light');
  const [, ctrl, card] = light.radii;
  // In dark mode a logo with no version for dark grounds sits on the light card colour.
  const css = `:root{${vars('light')};--r-ctrl:${ctrl}px;--r-card:${card}px;--heading:${FONT_BY_VALUE[light.heading].stack};--chip:${light.card}}`
    + `@media(prefers-color-scheme:dark){:root{${vars('dark')}}}`;
  looks.set(brand, css);
  return css;
};

// What every one of these pages starts from (a page adds its own rules).
export const PUBLIC_CSS = `
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.55 'Inter',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;-webkit-text-size-adjust:100%}
  main{max-width:520px;margin:0 auto;padding:28px 16px 56px}
  main.wide{max-width:720px}
  .camp{margin:0 0 24px;padding-bottom:14px;border-bottom:3px solid var(--edge)}
  .camp-logo{display:block;margin:0 0 10px}
  .camp-logo img{display:block;height:auto;width:auto;max-width:100%;max-height:48px}
  @media(prefers-color-scheme:dark){.camp-logo.on-light img{background:var(--chip);padding:6px 8px;border-radius:var(--r-ctrl)}}
  .camp-name{font:600 22px/1.2 var(--heading);margin:0;color:var(--ink);overflow-wrap:anywhere}
  h1{font:600 26px/1.2 var(--heading);letter-spacing:-0.02em;margin:0 0 12px;overflow-wrap:anywhere}
  h2{font:600 20px/1.25 var(--heading);margin:22px 0 8px}
  p{color:var(--ink2);margin:0 0 14px}
  a{color:var(--words)}
  .muted{color:var(--ink2)}
  button,.btn{display:block;width:100%;min-height:52px;margin-top:24px;font:600 16px/1.2 'Inter',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;background:var(--mark);color:var(--mark-ink);border:0;padding:14px 22px;border-radius:var(--r-ctrl);cursor:pointer;text-align:center;text-decoration:none}
  @media(hover:hover){button:hover,.btn:hover{background:var(--mark-hover)}}
  button:focus-visible,.btn:focus-visible,a:focus-visible{outline:2px solid var(--edge);outline-offset:2px}
  .done{border:1px solid var(--rule);border-left:3px solid var(--edge);border-radius:var(--r-card);background:var(--card);color:var(--ink);padding:18px;margin-top:16px}
  .err{border-left-color:var(--bad);margin:0 0 8px}
  footer{margin-top:40px;border-top:1px solid var(--rule);padding-top:12px;font-size:13px;color:var(--ink2)}
  footer a{color:var(--ink2)}
`;
const CSS = `${PUBLIC_CSS}
  .prose{color:var(--ink)}
  .prose p,.prose li{color:var(--ink)}
  .prose img{max-width:100%;height:auto;border-radius:var(--r-ctrl)}
  .prose blockquote{margin:0 0 14px;padding-left:14px;border-left:3px solid var(--rule);color:var(--ink2)}
  .note{font-size:15px;margin:16px 0 0}
  .learn-list{list-style:none;margin:0;padding:0}
  .learn-list li{padding:12px 0;border-bottom:1px solid var(--rule)}
  .learn-video{position:relative;padding-top:56.25%;margin:0 0 14px}
  .learn-video iframe{position:absolute;inset:0;width:100%;height:100%;border:0;border-radius:var(--r-ctrl)}
`;

// The head every one of these pages carries: its title, the app's faces and
// the brand's shades (no address in them but the faces', which a client's
// path is put in front of, lib/mount.js).
export const publicHead = (brand, title, { noindex = false } = {}) => `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>${noindex ? '<meta name="robots" content="noindex">' : ''}
<link rel="stylesheet" href="/fonts/fonts.css"><style>${publicLook(brand)}</style>`;

// The campaign on top: its logo (in dark mode the version for dark grounds,
// or the logo on a light chip) over its name. The name is said in words
// beside it, so the picture itself is silent.
export const campHtml = (brand, name) => {
  if (!name) return '';
  const logo = brand.publicLogo
    ? `<span class="camp-logo${brand.publicLogoDark ? '' : ' on-light'}"><picture>${brand.publicLogoDark ? `<source srcset="${esc(brand.publicLogoDark)}" media="(prefers-color-scheme: dark)">` : ''}<img src="${esc(brand.publicLogo)}" alt=""></picture></span>`
    : '';
  return `<div class="camp">${logo}<p class="camp-name">${esc(name)}</p></div>`;
};

// page(ws, title, inner, { wide, noindex, brand }): ws may be null (a link
// that names no campaign) — then brand is the one to wear (the campaign's,
// lib/brand.js campaignBrand), else the preset.
export const page = (ws, title, inner, { wide = false, noindex = false, brand = null } = {}) => {
  const settings = ws ? settingsOf(ws) : {};
  const b = ws ? brandFor(settings) : (brand || brandFor(null));
  const site = settings.website || null;
  return `<!doctype html><html lang="en"><head>${publicHead(b, `${title}${ws ? ` · ${ws.name}` : ''}`, { noindex })}
<style>${CSS}</style></head><body><main${wide ? ' class="wide"' : ''}>
${ws ? campHtml(b, ws.name) : ''}
${inner}
<footer>${site ? `<a href="${esc(site)}">← ${esc(String(site).replace(/^https?:\/\//, ''))}</a> · ` : ''}Powered by base.win</footer>
</main></body></html>`;
};
