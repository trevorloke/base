// A shift's turfs, and who each shift put on a turf.
//
// shift_turfs: the walk lists a shift carries ("Saturday canvass" →
// Newton block, 72 Ave east). Whoever is on the shift gets them.
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
`;
