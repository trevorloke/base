// Media: press releases to reporters and influencers (the Media tab).
//
// A contact is a person tagged media or influencer (any capitals), so
// People, lists, exports, History and socials all keep working; this
// feature adds what a person has no place for — outlet, beat, a note — and
// when and how they left the list.
//
//   rules.js    onMedia (SQL) and its JS twin: who is on the list
//   leave.js    off the list, by a release's own link (/bu) or the desk
//   actions.js  media.contact.*, media.send / test / resend / attach / picture
//   api.js      GET /api/media/contacts, /releases, /releases/:id, /outlets
//
// Outlets (LTE): a paper, station or show, with its letters and op-ed
// address or form, its length limits and what it asks a writer for — the
// rules a letter's writer sees (ext/letters). Contacts link to one by name
// (media_contacts.outlet, free text, any capitals); renaming an outlet
// carries its contacts along. A contact may be on any of three lists:
// Op-ed editors, Letters editors, Show hosts (rules.js LISTS).
// A release itself is a blast of kind press (actions/field.js, ext/abtests).
export { actions } from './actions.js';
export { api } from './api.js';

// One row per person ever on the list: outlet, beat and note survive a
// removal, so adding them back brings them back. left_how: 'link' (their
// own unsubscribe — the desk can't add them back) or 'desk'. No index
// beyond the key: the contacts read is rare and capped.
export const sql = `
create table if not exists media_contacts (
  workspace_id uuid not null,
  person_id uuid not null,
  outlet text check (outlet is null or length(outlet) <= 160),
  beat text check (beat is null or length(beat) <= 160),
  note text check (note is null or length(note) <= 500),
  left_at timestamptz,
  left_how text check (left_how is null or left_how in ('link', 'desk')),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, person_id)
);
-- The three lists (rules.js LISTS): a set, [] for everyone before them.
alter table media_contacts add column if not exists lists jsonb not null default '[]'::jsonb;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'media_contacts'::regclass and conname = 'media_contacts_lists_check') then
    alter table media_contacts add constraint media_contacts_lists_check
      check (jsonb_typeof(lists) = 'array' and lists <@ '["op_ed","letters","show"]'::jsonb);
  end if;
end $$;
-- Outlets: public facts only (no one's details). It takes letters with a
-- letters email or form, op-eds with an op-ed email or form. Starts empty.
create table if not exists media_outlets (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null check (length(name) between 1 and 160),
  kind text not null check (kind in ('paper','online','radio','tv','podcast','other')),
  newsroom text check (newsroom is null or length(newsroom) <= 160),
  language text check (language is null or length(language) <= 40),
  website text check (website is null or length(website) <= 300),
  letters_email text check (letters_email is null or length(letters_email) <= 320),
  letters_form text check (letters_form is null or length(letters_form) <= 300),
  letters_limit int check (letters_limit is null or letters_limit between 50 and 3000),
  oped_email text check (oped_email is null or length(oped_email) <= 320),
  oped_form text check (oped_form is null or length(oped_form) <= 300),
  oped_limit int check (oped_limit is null or oped_limit between 100 and 6000),
  limit_unit text not null default 'words' check (limit_unit in ('words','characters')),
  subject_hint text check (subject_hint is null or length(subject_hint) <= 80),
  asks_address boolean not null default false,
  asks_phone boolean not null default true,
  exclusive boolean not null default true,
  local_only boolean not null default false,
  no_candidates boolean not null default false,
  disclose boolean not null default false,
  rules text check (rules is null or length(rules) <= 500),
  confirmed_on date,
  confirmed_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists media_outlets_name_idx on media_outlets (workspace_id, lower(name)) where deleted_at is null;`;

export const exportTables = ['media_contacts', 'media_outlets'];

// Two records made one: if drop left by a release's link, keep has left
// too (the merge drops drop's row when keep has one), so the reach rule
// (lib/reach.js left_media) still holds. Keep's outlet, beat and note stand;
// keep's lists become both people's (the merge drops drop's row).
const personMerging = async (tx, ctx, { keep, drop }) => {
  await tx.query(
    `update media_contacts k set lists = (
       select coalesce(jsonb_agg(l order by array_position(array['op_ed','letters','show'], l)), '[]'::jsonb)
       from (select distinct jsonb_array_elements_text(k.lists || d.lists) as l) u)
     from media_contacts d
     where k.workspace_id = $1 and k.person_id = $2 and d.workspace_id = $1 and d.person_id = $3`,
    [ctx.workspaceId, keep.id, drop.id],
  );
  await tx.query(
    `insert into media_contacts (workspace_id, person_id, left_at, left_how, updated_at)
     select $1, $2, d.left_at, 'link', now() from media_contacts d where d.workspace_id = $1 and d.person_id = $3 and d.left_how = 'link'
     on conflict (workspace_id, person_id) do update set left_at = excluded.left_at, left_how = 'link', updated_at = now()`,
    [ctx.workspaceId, keep.id, drop.id],
  );
};
export const hooks = { personMerging };
