// The demo on the base.win website frames this app (server/lib/demo.js).
// Framed, the app tells that page how many times the visitor has clicked:
// a count and nothing else, and only to base.win, so the page can offer the
// visitor an account of their own. Not framed, it does nothing.
export const DEMO_PARENT = 'https://base.win';

export const reportDemoClicks = (win = window) => {
  if (!win || win.parent === win) return false;
  let clicks = 0;
  win.document.addEventListener('click', () => {
    clicks += 1;
    try { win.parent.postMessage({ source: 'base.win-demo', clicks }, DEMO_PARENT); } catch { /* the page went away */ }
  }, true);
  return true;
};
