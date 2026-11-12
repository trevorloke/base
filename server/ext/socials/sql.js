// Social media followers, typed in by the desk (person.followers.set).
//
//   persons.social_reach  { <platform>: { n, at: 'YYYY-MM-DD', by: 'typed',
//                           h: the handle on file when it was typed } } — an
//                           entry whose handle has changed or gone is dropped
//                           (index.js, the events hook)
//   persons.followers     the largest n still on file: the People filter
//                           (?followers=1000) and its index
//
// Nullable, no default: instant on a 300,000-person list.
export const sql = `
alter table persons add column if not exists social_reach jsonb;
alter table persons add column if not exists followers integer;
create index if not exists persons_followers_idx on persons (workspace_id, followers) where followers is not null;
`;

// Share kits (share.js): a post the campaign writes once; everyone shares it
// with their own link, /r/<code>?k=<kit code>. Sign-ups through one carry
// site_actions.source = 'kit-<kit code>' (counted through the index below,
// made once the website's tables are there).
export const shareSql = `
create table if not exists share_kits (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  code text not null,
  title text not null,
  body text not null,
  path text not null default '/',
  media_id uuid,
  authorized boolean not null default true,
  open boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists share_kits_code_idx on share_kits (workspace_id, code);
create index if not exists share_kits_ws_idx on share_kits (workspace_id, created_at desc) where deleted_at is null;
do $$ begin
  if to_regclass('site_actions') is not null then
    create index if not exists site_actions_source_idx on site_actions (workspace_id, source) where source is not null;
  end if;
end $$;
`;
