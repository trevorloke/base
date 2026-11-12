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
