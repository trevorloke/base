// A shift's link ("Turf map, sign-up doc, call script"), shared by the long
// form, a shift's page (pages/Shifts.jsx) and the week's add sheet.
//
// Only http(s) links become clickable; bare domains get https:// in front.
const BARE_DOMAIN = /^[\w-]+(\.[\w-]+)+([/?#]|$)/;
export const safeHref = (link) => {
  const v = String(link || '').trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (BARE_DOMAIN.test(v)) return `https://${v}`;
  return null;
};
// What gets saved: a pasted "bit.ly/turf" is stored as https://bit.ly/turf so
// the link in the email/text is tappable too. Anything else is kept as typed.
export const normalizeLink = (link) => {
  const v = String(link || '').trim();
  if (!v) return undefined;
  if (!/^[a-z][a-z\d+.-]*:/i.test(v) && BARE_DOMAIN.test(v)) return `https://${v}`;
  return v;
};
