// base.win support: the control centre (ops.base.win) opens this campaign's
// desk, already signed in, as the member "base.win support".
//
//   sql.js       its tables (platform_identity, operator_entries,
//                operator_links; users.support, sessions.entry)
//   identity.js  this server's instance id, which every token must name
//   enter.js     an entry: the switch, the account, a two-hour sign-in
//   actions.js   workspace.operatorEntry: the switch (Settings → Members)
//   api.js       GET /operator: the switch and the support accounts here
//   brief.js     a manager's Today: support's visits this week
//
// The token is checked in lib/entry.js; the route is POST
// /api/auth/operator (routes/auth.js).
import { briefSupport } from './brief.js';
import { demoEmail } from '../../lib/demo.js';

export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';
export const hooks = { brief: briefSupport };

// What a visit as base.win support may not do (routes/api.js checks it
// after scopeAllows): its own sign-in methods and the campaign's two-step
// rule, the campaign's consent (the switch), and password links. Google
// link and connect are refused in ext/google/routes.js. twostep.reset stays
// allowed: someone who lost their phone still needs their own password.
export const OPERATOR_DENIED = [
  /^POST \/api\/actions\/twostep\.(start|confirm|off|codes|require)$/,
  /^POST \/api\/actions\/workspace\.operatorEntry$/,
  /^POST \/api\/actions\/member\.passwordLink$/,
];
export const NOT_AS_SUPPORT = 'Not while signed in as base.win support.';
export const deniedForEntry = (ctx, method, path) =>
  Boolean(ctx?.entry) && OPERATOR_DENIED.some((re) => re.test(`${method} ${path}`));

// Every read that lists the team selects SUPPORT_SQL as support and shows
// each email through emailShown. The demo's visitors are strangers: base.win
// support's email is shown only to support itself.
export const SUPPORT_SQL = 'exists(select 1 from operator_links l where l.user_id = u.id)';
export const emailShown = (m, viewerId) => (demoEmail() && m.support && m.id !== viewerId ? null : m.email);
