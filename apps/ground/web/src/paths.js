// Where this base ground lives on its address (SUITE.md, "BASE_PATH"). The
// server writes window.__BASE_PATH__ into index.html ('/imaginesurrey' on
// base.win, '' on a laptop and under Vite's dev server). Every absolute path
// the browser builds — fetch, links, router bases, the service worker — goes
// through withBase, so nothing ever leaves the client's prefix.
//
//   BASE           '/imaginesurrey' or ''
//   withBase(p)    '/api/x' → '/imaginesurrey/api/x'; anything that isn't a
//                  root path (https://…, tel:, a relative one) comes back as is
//   safeNext(n)    the sign-in page's ?next=, or null when it isn't one of
//                  this app's own addresses (shared/paths.js)
import { cleanBase, safeNext as safeNextUnder } from '@base-ground/shared/paths';

export const BASE = (typeof window !== 'undefined' && cleanBase(window.__BASE_PATH__)) || '';

export const withBase = (path) => (typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') ? `${BASE}${path}` : path);

export const safeNext = (next) => safeNextUnder(next, BASE);
