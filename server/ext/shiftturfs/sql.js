// A shift's turfs, and who each shift put on a turf.
//
// shift_turfs: the walk lists a shift carries ("Saturday canvass" →
// Newton block, 72 Ave east). Whoever is on the shift gets them.
//
// shift_crew: the crew board's picks — the one turf the desk put someone on
// for this shift (or no walk list), and a job (team lead, driver).
//
// shift_turf_walkers: one row per (assignment, turf) for a turf membership a
// shift holds — the membership it made, or one it shares with another shift
// that made it. A membership with no row here was given by hand (Map → turf
// sheet) and no shift ever takes it back. No foreign key from assignment_id
// to shift_assignments: shift.unassign deletes the assignment row first and
// then emits its void, and this table must still name it then.
export const sql = `
create table if not exists shift_turfs (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  shift_id uuid not null references shifts(id) on delete cascade,
  turf_id uuid not null references turfs(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (shift_id, turf_id)
);
create index if not exists shift_turfs_turf_idx on shift_turfs (turf_id);

-- Who THIS shift put on a turf, by assignment: leaving the shift takes back only these rows.
create table if not exists shift_turf_walkers (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  assignment_id uuid not null,
  shift_id uuid not null references shifts(id) on delete cascade,
  turf_id uuid not null references turfs(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (assignment_id, turf_id)
);
create index if not exists shift_turf_walkers_shift_idx on shift_turf_walkers (workspace_id, shift_id);
create index if not exists shift_turf_walkers_member_idx on shift_turf_walkers (turf_id, user_id);

-- The crew board (Shifts → a shift): where the desk put each person on the
-- shift. placed: null = not placed yet (they walk every turf the shift
-- carries, as before the board); 'turf' = only turf_id; 'none' = no walk
-- list from this shift (a driver, the office). job: team lead or driver.
-- One row per assignment; no foreign key to shift_assignments for the same
-- reason as the walkers (shift.unassign deletes the row before its void).
create table if not exists shift_crew (
  assignment_id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  shift_id uuid not null references shifts(id) on delete cascade,
  placed text check (placed in ('turf', 'none')),
  turf_id uuid references turfs(id) on delete set null,
  job text check (job in ('lead', 'driver')),
  updated_at timestamptz not null default now()
);
create index if not exists shift_crew_shift_idx on shift_crew (workspace_id, shift_id);
`;
