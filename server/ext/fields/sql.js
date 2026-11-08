// Profile field tables. Idempotent: run at every boot after the core schema
// (under test:pg every test file boots against the same database).
//
//   person_fields        one per field the campaign tracks: its name, kind
//                        (kinds.js), choices (Pick one), the order on the
//                        profile, whether volunteers see it (off unless a
//                        manager turns it on), and retired_at — a field taken
//                        off stops showing but keeps every value
//   person_field_values  one row per person per field: the value as stored
//                        (kinds.js), who set it and when. Its history is the
//                        event log (every change carries what it was).
//
// Why a table of values and not a jsonb column on persons: a value is a row
// of its own with who and when; "filled in for 12 people" and "Language at
// home: Punjabi" are indexed lookups; a field taken off or changed to Text
// touches its own rows only, never every person; and a person's core row
// (and its events) stays exactly as it was.
//
// sample marks what the sample campaign made, so clearing it removes exactly
// that (a value you change stops being sample).
export const sql = `
create table if not exists person_fields (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('text', 'note', 'yesno', 'choice', 'choices', 'number', 'date')),
  choices jsonb not null default '[]',
  volunteers boolean not null default false,
  position int not null default 0,
  retired_at timestamptz,
  sample boolean not null default false,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists person_fields_ws_idx on person_fields (workspace_id, position);

create table if not exists person_field_values (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  field_id uuid not null references person_fields(id) on delete cascade,
  person_id uuid not null references persons(id) on delete cascade,
  value jsonb not null,
  sample boolean not null default false,
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (field_id, person_id)
);
create index if not exists person_field_values_find_idx on person_field_values (workspace_id, field_id, value);
create index if not exists person_field_values_person_idx on person_field_values (workspace_id, person_id);

-- Long text and Pick several (kinds.js): the kind check widened on a
-- database made before them.
do $$
declare c record;
begin
  for c in select conname, pg_get_constraintdef(oid) as def from pg_constraint
            where conrelid = 'person_fields'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%kind%' loop
    if c.def not like '%choices%' then
      execute format('alter table person_fields drop constraint %I', c.conname);
      alter table person_fields add constraint person_fields_kind_check
        check (kind in ('text', 'note', 'yesno', 'choice', 'choices', 'number', 'date'));
    end if;
  end loop;
end $$;

-- Voter eligibility, Language and Notes (people.js STANDARD_FIELDS) for
-- campaigns set up before they were standard: added once each, at the end
-- of the list. fields_seeded remembers, so a campaign that renames or takes
-- one off never has it put back.
create table if not exists fields_seeded (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  primary key (workspace_id, name)
);
insert into person_fields (id, workspace_id, name, kind, choices, volunteers, position)
select gen_random_uuid(), w.id, s.name, s.kind, s.choices::jsonb, s.vol,
       coalesce((select max(f.position) from person_fields f where f.workspace_id = w.id and f.retired_at is null), -1) + s.ord
  from workspaces w
 cross join (values
   ('Voter eligibility', 'choice', '["Eligible","Ineligible"]', true, 1),
   ('Language', 'choices', '["English","Punjabi","Hindi","Urdu","Mandarin","Cantonese","Filipino","Korean","Vietnamese","Arabic","Farsi","Gujarati","Spanish","French","Other"]', true, 2),
   ('Notes', 'note', '[]', false, 3)
 ) as s(name, kind, choices, vol, ord)
 where not exists (select 1 from person_fields f where f.workspace_id = w.id and lower(f.name) = lower(s.name))
   and not exists (select 1 from fields_seeded x where x.workspace_id = w.id and x.name = s.name)
   and (select count(*) from person_fields f where f.workspace_id = w.id and f.retired_at is null) < 38;
insert into fields_seeded (workspace_id, name)
select w.id, s.name from workspaces w cross join (values ('Voter eligibility'), ('Language'), ('Notes')) as s(name)
on conflict do nothing;

-- The membership form's fields (people.js STANDARD_FIELDS), the same way:
-- once each, at the end of the list, never put back after a rename.
insert into person_fields (id, workspace_id, name, kind, choices, volunteers, position)
select gen_random_uuid(), w.id, s.name, s.kind, s.choices::jsonb, s.vol,
       coalesce((select max(f.position) from person_fields f where f.workspace_id = w.id and f.retired_at is null), -1) + s.ord
  from workspaces w
 cross join (values
   ('Gender', 'text', '[]', false, 1),
   ('Birth date', 'date', '[]', false, 2),
   ('Citizenship', 'choice', '["Canadian citizen", "Permanent resident"]', false, 3),
   ('Union member', 'yesno', '[]', false, 4),
   ('Union local', 'text', '[]', false, 5),
   ('Campus', 'text', '[]', false, 6),
   ('Other language', 'text', '[]', true, 7),
   ('Interests', 'choices', '["Safer streets", "Faster commutes", "Smarter investments", "Lower costs", "Stronger services", "Homes I can afford", "Support for small business", "Healthier communities", "Better schools / school board issues", "Climate / parks", "Metro Vancouver / regional issues"]', false, 8),
   ('Interested in being a candidate', 'yesno', '[]', false, 9)
 ) as s(name, kind, choices, vol, ord)
 where not exists (select 1 from person_fields f where f.workspace_id = w.id and lower(f.name) = lower(s.name))
   and not exists (select 1 from fields_seeded x where x.workspace_id = w.id and x.name = s.name)
   and (select count(*) from person_fields f where f.workspace_id = w.id and f.retired_at is null) < 38;
insert into fields_seeded (workspace_id, name)
select w.id, s.name from workspaces w cross join (values ('Gender'), ('Birth date'), ('Citizenship'), ('Union member'), ('Union local'), ('Campus'), ('Other language'), ('Interests'), ('Interested in being a candidate')) as s(name)
on conflict do nothing;

-- Language as first added (a starting list) → the membership form's list,
-- in its order: Tagalog is Filipino there; Farsi, French and Other join.
-- Only where the desk hasn't changed the list; what people have is kept.
update person_field_values v set value = (
         select coalesce(jsonb_agg(case when e = 'Tagalog' then 'Filipino' else e end), '[]'::jsonb)
           from jsonb_array_elements_text(v.value) as e)
  from person_fields f
 where f.id = v.field_id and f.name = 'Language' and f.kind = 'choices'
   and f.choices = '["English", "Punjabi", "Hindi", "Mandarin", "Tagalog", "Cantonese", "Urdu", "Arabic", "Korean", "Spanish", "Gujarati", "Vietnamese"]'::jsonb and jsonb_typeof(v.value) = 'array';
update person_fields set choices = '["English", "Punjabi", "Hindi", "Urdu", "Mandarin", "Cantonese", "Filipino", "Korean", "Vietnamese", "Arabic", "Farsi", "Gujarati", "Spanish", "French", "Other"]'::jsonb, updated_at = now()
 where name = 'Language' and kind = 'choices' and choices = '["English", "Punjabi", "Hindi", "Mandarin", "Tagalog", "Cantonese", "Urdu", "Arabic", "Korean", "Spanish", "Gujarati", "Vietnamese"]'::jsonb;
`;
