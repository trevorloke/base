// Line icons for the website: 24×24, drawn in the current text colour,
// hidden from screen readers (the words next to them say what they mean).
// The five pillar icons come from imaginesurrey.ca (apps/web Icons.tsx).
import { html } from './h.js';

const PATHS = {
  // What we stand for
  shield: html`<g><path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-3z" /><path d="M9 12l2 2 4-4" /></g>`,
  bus: html`<g><rect x="4" y="3" width="16" height="14" rx="2" /><path d="M4 10h16" /><path d="M8 17v2M16 17v2" /><path d="M8 14h.01M16 14h.01" /></g>`,
  trend: html`<g><path d="M4 19l6-6 4 4 6-7" /><path d="M15 10h5v5" /></g>`,
  tag: html`<g><path d="M3 12l9-9h8v8l-9 9-8-8z" /><circle cx="16" cy="7" r="1.5" /></g>`,
  civic: html`<g><path d="M3 21h18" /><path d="M5 21V10h14v11" /><path d="M12 3l8 6H4l8-6z" /><path d="M10 21v-5h4v5" /></g>`,
  home: html`<g><path d="M3 11l9-7 9 7" /><path d="M5 10v10h14V10" /><path d="M10 20v-6h4v6" /></g>`,
  leaf: html`<g><path d="M5 19c0-8 5-13 15-14-1 10-6 15-14 15" /><path d="M5 19l7-7" /></g>`,
  heart: html`<g><path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z" /></g>`,
  people: html`<g><circle cx="9" cy="8" r="3.2" /><path d="M3 20a6 6 0 0 1 12 0" /><circle cx="17" cy="9" r="2.6" /><path d="M16.5 14.2A5 5 0 0 1 21 19" /></g>`,
  school: html`<g><path d="M2 9l10-5 10 5-10 5-10-5z" /><path d="M6 11v5c3 2.5 9 2.5 12 0v-5" /><path d="M22 9v6" /></g>`,
  // Controls and labels
  menu: html`<g><path d="M4 7h16M4 12h16M4 17h16" /></g>`,
  close: html`<g><path d="M6 6l12 12M18 6L6 18" /></g>`,
  pause: html`<g><path d="M7 5v14M17 5v14" /></g>`,
  play: html`<g><path d="M7 4.5v15l12-7.5z" /></g>`,
  whatsapp: html`<g><path d="M12 3a9 9 0 0 0-7.8 13.5L3 21l4.6-1.2A9 9 0 1 0 12 3z" /><path d="M9 8.5c0 3.5 3 6.5 6.5 6.5l1-1.5-2-1-1 1a4.5 4.5 0 0 1-2.5-2.5l1-1-1-2-1.5 1z" /></g>`,
  sms: html`<g><path d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-5 4v-4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" /><path d="M8 9h8M8 12h5" /></g>`,
  facebook: html`<g><path d="M15 4h-2a4 4 0 0 0-4 4v3H7v3h2v6h3v-6h3l1-3h-4V8a1 1 0 0 1 1-1h2z" /></g>`,
  x: html`<g><path d="M4 4l16 16M20 4L4 20" /></g>`,
  email: html`<g><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></g>`,
  phone: html`<g><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" /></g>`,
  copy: html`<g><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a1 1 0 0 1 1-1h10" /></g>`,
  pin: html`<g><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" /></g>`,
  hand: html`<g><path d="M7 11V7a2 2 0 0 1 4 0v4M11 10V5a2 2 0 0 1 4 0v6M15 10V7a2 2 0 0 1 4 0v6a7 7 0 0 1-7 7h-1a6 6 0 0 1-5.2-3L4 14a2 2 0 0 1 3.4-2" /></g>`,
  check: html`<g><path d="M5 12.5l4.5 4.5L19 7.5" /></g>`,
  plus: html`<g><path d="M12 5v14M5 12h14" /></g>`,
  arrow: html`<g><path d="M5 12h14M13 6l6 6-6 6" /></g>`,
  chevron: html`<g><path d="M6 9l6 6 6-6" /></g>`,
  // Promise tracker statuses: a shape for each, never colour alone.
  pending: html`<g><circle cx="12" cy="12" r="7" /></g>`,
  progress: html`<g><circle cx="12" cy="12" r="7" /><path d="M12 8v4l3 2" /></g>`,
  stalled: html`<g><circle cx="12" cy="12" r="7" /><path d="M9 12h6" /></g>`,
  kept: html`<g><path d="M5 12.5l4.5 4.5L19 7.5" /></g>`,
  broken: html`<g><path d="M7 7l10 10M17 7L7 17" /></g>`,
};
export const ICON_NAMES = Object.keys(PATHS);

export function Icon({ name, size = 20, stroke = 2.2, className }) {
  const body = PATHS[name];
  if (!body) return null;
  return html`<svg className=${className || 'icon'} aria-hidden="true" focusable="false" width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth=${stroke} strokeLinecap="round" strokeLinejoin="round">${body}</svg>`;
}
