// Where this Base Ground lives on its address (SUITE.md, "BASE_PATH"). The
// server writes window.__BASE_PATH__ into index.html ('' at the root — on
// base.win, where each client has its own subdomain, on a laptop and under
// Vite's dev server; '/ground', say, for a deployment under a path). Every
// absolute path the browser builds — fetch, links, router bases, the service
// worker — goes through withBase, so nothing ever leaves the app's prefix.
//
//   BASE           '' or '/ground'
//   withBase(p)    '/api/x' → '/ground/api/x' under a path; anything that isn't a
//                  root path (https://…, tel:, a relative one) comes back as is
//   safeNext(n)    the sign-in page's ?next=, or null when it isn't one of
//                  this app's own addresses (shared/paths.js)
import { cleanBase, safeNext as safeNextUnder } from '@base-ground/shared/paths';

export const BASE = (typeof window !== 'undefined' && cleanBase(window.__BASE_PATH__)) || '';

export const withBase = (path) => (typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') ? `${BASE}${path}` : path);

export const safeNext = (next) => safeNextUnder(next, BASE);
