// Two apps from one build, told apart by the address (SUITE.md), both under
// the app's prefix, if any (paths.js):
//   /field/…    the field app — what a volunteer sees and uses (Today ·
//               Map · Calls · Shifts · ImagineU). Anyone may open it; a
//               manager or staffer gets the same screens a volunteer does.
//   /ground/…   the desk (was /admin) — everything, for managers, staff and
//               treasurers (and a volunteer given an area under Permissions).
// main.jsx picks the router's base from the address; links across the two
// are plain hrefs (a full load), inside each they are router links. The mode
// is still called 'admin' for the desk inside the code.
import { BASE, withBase } from './paths.js';

export const FIELD_BASE = '/field';
export const DESK_BASE = '/ground';
// The router's base for each face: the prefix and the face.
export const routerBase = (mode) => `${BASE}${mode === 'admin' ? DESK_BASE : FIELD_BASE}`;
const under = (p, face) => p === `${BASE}${face}` || p.startsWith(`${BASE}${face}/`);
export const appMode = () => {
  if (typeof window === 'undefined') return 'field';
  return under(window.location.pathname, DESK_BASE) ? 'admin' : 'field';
};
// An address outside both faces (Vite's dev server answers every path with
// the app): where it belongs — / and old field addresses to /field, the old
// /admin to /ground. null when it's already in a face. (The server sends
// these on itself; this is for dev and an old cached copy.)
export const faceFor = (pathname) => {
  if (under(pathname, FIELD_BASE) || under(pathname, DESK_BASE)) return null;
  const rest = pathname.startsWith(BASE) ? pathname.slice(BASE.length) || '/' : pathname;
  if (rest === '/admin' || rest.startsWith('/admin/')) return withBase(`${DESK_BASE}${rest.slice('/admin'.length) || '/'}`);
  return withBase(`${FIELD_BASE}${rest === '/' ? '/' : rest}`);
};
export const adminHref = (path = '/') => withBase(`${DESK_BASE}${path}`);
export const fieldHref = (path = '/') => withBase(`${FIELD_BASE}${path}`);
const DESK = ['manager', 'staff', 'treasurer'];
export const isDeskRole = (me) => DESK.includes(me?.role);
// Who may open the admin: a desk role, or a volunteer given an area.
export const mayAdmin = (me) => isDeskRole(me) || (Array.isArray(me?.areas) && me.areas.length > 0);
// Where someone lands after signing in, from either app.
export const landing = (me, mode) => {
  if (mode === 'field' && isDeskRole(me)) return { href: adminHref('/') };
  if (mode === 'admin' && !mayAdmin(me)) return { href: fieldHref('/') };
  return { to: '/' };
};
// The field app shows every role the volunteer's screens: the same person,
// seen as a volunteer. admin_role keeps who they really are, for the
// "Admin ↗" link; the server still answers as them.
export const fieldView = (me) => (me && me.role !== 'volunteer' ? { ...me, role: 'volunteer', areas: [], admin_role: me.role, admin_areas: me.areas } : me);
