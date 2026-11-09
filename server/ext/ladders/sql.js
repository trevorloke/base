// Ladders tables. Idempotent; run at boot after the core schema.
//
//   ladders           a trigger (what starts it) + an ordered list of steps
//   ladder_runs       one person on one ladder: the step they're on, whether
//                     they're waiting (a Wait step, email not connected, a
//                     retry, or 'sending': an email handed to the provider —
//                     committed before the call, so a retry never sends it
//                     twice), and a short log of what each step did
//   ladder_followups  "Call Ana to say thanks" — staff tasks a step created —
//                     and, since speed to lead (ext/followups), the people to
//                     reach within a day: a new volunteer, a website message,
//                     a new RSVP (kind), what they did (detail), the named
//                     organizer who has it (assigned_to, routed: why them),
//                     the clock (due_at) and the contact that closed it
//   ladder_tag_changes  tags a person just got, noted by a trigger on persons
//                     so the events hook can tell "got a tag" from "already
//                     had it" (the event only carries the new list). Rows
//                     live for one transaction: the hook deletes its own.
export const sql = `
create table if not exists ladders (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  trigger_kind text not null,
  trigger_ref text,
  steps jsonb not null default '[]',
  active boolean not null default false,
  reentry boolean not null default false,
  public_url text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists ladders_ws_idx on ladders (workspace_id) where deleted_at is null;

create table if not exists ladder_runs (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  ladder_id uuid not null references ladders(id) on delete cascade,
  person_id uuid not null references persons(id) on delete cascade,
  step int not null default 0,
  status text not null default 'active' check (status in ('active', 'paused', 'done')),
  wait text check (wait in ('time', 'email', 'retry', 'sending', 'text', 'quiet')),
  next_at timestamptz,
  token uuid,
  trigger_note text,
  log jsonb not null default '[]',
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
-- The waits a run may be in: a Wait step ('time'), an email or text step
-- waiting for its provider ('email', 'text'), a retry, a send in flight
-- ('sending'), or a text held until the hours texts may go ('quiet').
-- Databases from before 'sending' (ladder_runs_wait_check) or before texts
-- (lruns_wait_ok) carry an older check: it is swapped once.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'lruns_wait_ok2') then
    alter table ladder_runs drop constraint if exists lruns_wait_ok;
    alter table ladder_runs drop constraint if exists ladder_runs_wait_check;
    alter table ladder_runs add constraint lruns_wait_ok2 check (wait in ('time', 'email', 'retry', 'sending', 'text', 'quiet'));
  end if;
end $$;
-- A goal: the person comes off the ladder as soon as they do it
-- (shape.js GOALS: came to a shift, gave, became a member, voted).
alter table ladders add column if not exists goal text;
create index if not exists lruns_ladder_idx on ladder_runs (workspace_id, ladder_id, status);
create index if not exists lruns_person_idx on ladder_runs (workspace_id, person_id);

create table if not exists ladder_followups (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  ladder_id uuid references ladders(id) on delete cascade,
  run_id uuid references ladder_runs(id) on delete set null,
  person_id uuid not null references persons(id) on delete cascade,
  text text not null,
  status text not null default 'open' check (status in ('open', 'done')),
  created_at timestamptz not null default now(),
  done_at timestamptz,
  done_by uuid references users(id) on delete set null
);
create index if not exists lfollow_ws_idx on ladder_followups (workspace_id, status);
-- Speed to lead (ext/followups). kind: what the person did ('volunteer',
-- 'message', 'rsvp'; null for a ladder's step). detail: { did: [...] }, the
-- card's words and the rows it came from (a door request, a site action).
-- routed: why this organizer — 'brought_in', 'knows', 'turf', 'office', or
-- 'desk' (handed over by hand). contact_id / contacted_at / contacted_by:
-- the contact that closed it (time to first contact).
alter table ladder_followups add column if not exists kind text;
alter table ladder_followups add column if not exists detail jsonb;
alter table ladder_followups add column if not exists assigned_to uuid references users(id) on delete set null;
alter table ladder_followups add column if not exists routed text;
alter table ladder_followups add column if not exists due_at timestamptz;
alter table ladder_followups add column if not exists contact_id uuid;
alter table ladder_followups add column if not exists contacted_at timestamptz;
alter table ladder_followups add column if not exists contacted_by uuid references users(id) on delete set null;
create index if not exists lfollow_mine_idx on ladder_followups (workspace_id, assigned_to) where status = 'open';
create index if not exists lfollow_person_idx on ladder_followups (workspace_id, person_id) where status = 'open';

create table if not exists ladder_tag_changes (
  workspace_id uuid not null,
  person_id uuid not null,
  added jsonb not null,
  tx bigint not null default txid_current(),
  created_at timestamptz not null default now()
);
create index if not exists ltagch_ws_idx on ladder_tag_changes (workspace_id);

-- Only while the campaign has a "got a tag" ladder on; never fails the write
-- (anything that isn't a list of tags counts as no tags).
create or replace function ladders_note_tags() returns trigger language plpgsql as $$
declare
  was jsonb := case when jsonb_typeof(old.tags) = 'array' then old.tags else '[]'::jsonb end;
  now_tags jsonb := case when jsonb_typeof(new.tags) = 'array' then new.tags else '[]'::jsonb end;
begin
  if now_tags is distinct from was and exists (
    select 1 from ladders l
    where l.workspace_id = new.workspace_id and l.active and l.deleted_at is null and l.trigger_kind = 'tag'
  ) then
    insert into ladder_tag_changes (workspace_id, person_id, added)
    select new.workspace_id, new.id, jsonb_agg(t.v)
    from jsonb_array_elements_text(now_tags) as t(v)
    where not (was ? t.v)
    having count(*) > 0;
  end if;
  return null;
end $$;
create or replace trigger ladders_note_tags after update of tags on persons
  for each row execute function ladders_note_tags();
`;
