// Email templates: a campaign's own words to start an email from, and the
// ready-made ones every campaign has (shared/email/starters.js, in code).
//
//   email_templates   one row per template the campaign saved: use (email —
//                     Outreach → Email, newsletter or a list; press — Media's
//                     releases), name, subject and body stored with codes
//                     ({{first_name}}, as a send stores them), version (+1 on
//                     every save: the stale-edit check), soft-deleted (Undo).
//                     No From, no To, no files: those are chosen at send.
//   actions.js        template.save · copy · remove · restore · starters
//   api.js            GET /templates · /templates/:ref · /blasts/:id/message
// The area (Outreach for email, Media for press) is checked here, not in
// lib/perms.js: one action prefix can't carry two areas.
export const sql = `
create table if not exists email_templates (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  use text not null check (use in ('email', 'press')),
  name text not null,
  subject text not null default '',
  body text not null,
  made_from text,
  version int not null default 1,
  created_by uuid references users(id),
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists email_templates_ws_idx on email_templates (workspace_id, use, updated_at desc) where deleted_at is null;
create unique index if not exists email_templates_name_idx on email_templates (workspace_id, use, lower(name)) where deleted_at is null;
`;

export { actions } from './actions.js';
export { api } from './api.js';
// "Use again": a past send's words. /api/blasts… is Outreach (lib/perms.js).
export const deskOnlyReads = ['/blasts/:id/message'];
export const exportTables = ['email_templates'];
