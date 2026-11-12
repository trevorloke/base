// What scheduling adds to the database. Every column is nullable or
// defaulted and added in place: nothing here rewrites a row or touches the
// people's table.
//
// places            a place a shift happens at, saved once and picked by tap:
//                   its name as shown, a pin when it was picked on the map
//                   (lat, lng), the address the name came from, and how it
//                   came to be (source: 'map' a point tapped on the map,
//                   'typed' a name typed, 'used' made from the words
//                   already on shifts). Taken off the list with deleted_at;
//                   shifts that used it keep their words and their pin.
// shifts.kind       what the shift is (shared/shiftkinds.js); null on a
//                   shift made before kinds — nothing is filled in after.
// shifts.title_custom  true: its name was typed (and is kept); false: its
//                   name is made from kind and place (and follows them);
//                   null: made before kinds — typed, so kept.
// shifts.place_id   the saved place; shifts.location stays the words shown.
// shifts.series_id  the same id on every shift one repeating "Add" made.
// shifts.series_edited_at  when a shift in a series was changed on its own:
//                   "this and the following" leaves it as the desk set it.
// shifts.need       how many people it wants — a target on cards and on
//                   Today. Never a limit: nobody is refused for it.
// shift_assignments.reminded_at  when the evening-before reminder for this
//                   booking was claimed: set once, so it goes once.
// schedule_settings whether the campaign sends that reminder (off until a
//                   manager turns it on).
// shift_notices     one row per person per notice — "Tell everyone on this
//                   week's shifts" (kind 'week': batch_id is the tap, week
//                   its Monday) or the evening-before reminder ('reminder':
//                   batch_id is that evening's run). state: 'asked' (to be
//                   sent), 'sending' (claimed, with the provider now —
//                   never sent again by itself), 'done'. email / text: how
//                   each went, in shift.notify's words (sent, queued,
//                   failed, skipped, opted_out, quiet), and 'suppressed':
//                   the address bounced for good or reported spam.
export const sql = `
create table if not exists places (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  lat double precision,
  lng double precision,
  address text,
  source text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists places_ws_idx on places (workspace_id) where deleted_at is null;

alter table shifts add column if not exists kind text;
alter table shifts add column if not exists title_custom boolean;
alter table shifts add column if not exists place_id uuid references places(id) on delete set null;
alter table shifts add column if not exists series_id uuid;
alter table shifts add column if not exists series_edited_at timestamptz;
alter table shifts add column if not exists need int;
create index if not exists shifts_series_idx on shifts (workspace_id, series_id, starts_at) where series_id is not null and deleted_at is null;

alter table shift_assignments add column if not exists reminded_at timestamptz;

create table if not exists schedule_settings (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  remind boolean not null default false,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

create table if not exists shift_notices (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null check (kind in ('week', 'reminder')),
  batch_id uuid not null,
  week date,
  person_id uuid not null references persons(id) on delete cascade,
  assignment_ids jsonb not null default '[]',
  state text not null default 'asked' check (state in ('asked', 'sending', 'done')),
  email text,
  text text,
  text_note text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists shift_notices_batch_idx on shift_notices (workspace_id, batch_id, state);
create index if not exists shift_notices_week_idx on shift_notices (workspace_id, week) where kind = 'week';
`;
