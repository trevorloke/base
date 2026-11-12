// From addresses: the campaign's choice of From on newsletters, emails to a
// list and press releases (Settings → Services → Email → From addresses).
//
//   rules.js    where they live (workspace settings) and resolveFrom, the
//               From a send goes from (blast.send / blast.test, media.send)
//   actions.js  sender.save · sender.remove · sender.default (managers)
//   api.js      GET /api/senders
// System mail (invites, shift notices, receipts, two-step, ladders) stays
// on MAIL_FROM.
export { actions } from './actions.js';
export { api } from './api.js';

// The From a send went from, as typed — null: MAIL_FROM. Kept for life, so
// Try again and an A/B winner go from the same address.
export const sql = `alter table blasts add column if not exists from_addr text;`;
