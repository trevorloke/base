// Which words on a translated page fell back to English (TR decision 22):
// the renderer notes each one while it draws (rc.t, rc.w), and the plain
// pieces that hold text — a heading, a paragraph — say lang="en" for them.
// Set only around one synchronous server render (render/index.js); in the
// browser it is never set, so islands draw exactly what their props say.
let shown = null;
export const withFallbacks = (set, fn) => {
  const was = shown;
  shown = set;
  try { return fn(); } finally { shown = was; }
};
export const enLang = (text) => (shown && typeof text === 'string' && text.trim() && shown.has(text.trim()) ? 'en' : undefined);
