// Google: Sign in with Google, and the one Google connection every Google
// feature (Gmail, Drive, Calendar) uses. The flow logic other features call
// is lib/google/ (config, seal, flow, tokens, purposes); this folder is its
// routes, tables, actions and Services row.
//
//   sql.js      google_flows, google_logins, google_grants (never exported,
//               never on the log)
//   routes.js   GET /api/auth/google/start and /back — the only OAuth
//               route pair (signin.js, connect.js finish each kind)
//   actions.js  google.unlink · unlinkMember · settings · disconnect · forget
//   api.js      GET /api/google, GET /api/google/members
//   hooks.js    connections follow role changes and leaving the team
//   jobs.js     google.revoke
//   service.js  the Services row "Google (sign-in and connections)"
export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';
export { publicRoutes } from './routes.js';
export { jobs } from './jobs.js';
import { events } from './hooks.js';

export const hooks = { events };
