// Voted — the election-day mark.
//   persons.voted_at   THE fact every screen reads: when this person was
//                      last marked as having voted (null: not marked, or
//                      marked and then taken back).
//   voted_marks        the append-only history: every mark and un-mark, who
//                      set it and from where (the door, a call, the desk, a
//                      file from the campaign's website). client_id is the
//                      phone's own id for a mark saved with no signal, so a
//                      replay after a lost answer is the same mark.
//   voted_settings     whether Election day is on (the screens offer the
//                      button only then) and the date.
export const sql = `
alter table persons add column if not exists voted_at timestamptz;
create table if not exists voted_marks (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  person_id uuid not null references persons(id) on delete cascade,
  voted boolean not null default true,
  source text not null check (source in ('door','phone','desk','file')),
  marked_by uuid references users(id),
  client_id uuid,
  created_at timestamptz not null default now()
);
create unique index if not exists voted_marks_client_idx on voted_marks (workspace_id, client_id) where client_id is not null;
create index if not exists voted_marks_person_idx on voted_marks (workspace_id, person_id);
create table if not exists voted_settings (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  on_day boolean not null default false,
  election_day date,
  updated_at timestamptz not null default now()
);
-- GOTV mode: the advance-voting days (dates, in the campaign's day) and
-- whether the mode turns itself on for them and for election day.
alter table voted_settings add column if not exists advance_days jsonb not null default '[]';
alter table voted_settings add column if not exists auto boolean not null default true;

-- Live GOTV (scrutineers, the live feed, practice). voted_marks is small
-- (only past marks), so these run quickly even on a big campaign.
--   created_at   when it happened (the tap, or when a name was written)
--   inserted_at  when the server saved it (undo windows, "the last hour")
--   feed_id      the live feed's order. Every insert (and every feed bump on
--                a merge) happens inside runAction, under the campaign's row
--                lock held until commit, so within one campaign a higher
--                feed_id always commits later: commit order, with no seq
--                from events needed.
alter table voted_marks drop constraint if exists voted_marks_source_check;
alter table voted_marks add constraint voted_marks_source_check
  check (source in ('door','phone','desk','file','scrutineer'));
alter table voted_marks add column if not exists place_id uuid references places(id) on delete set null;
alter table voted_marks add column if not exists undoes uuid;
alter table voted_marks add column if not exists inserted_at timestamptz not null default now();
create sequence if not exists voted_feed_seq;
alter table voted_marks add column if not exists feed_id bigint default nextval('voted_feed_seq');
create index if not exists voted_marks_feed_idx on voted_marks (workspace_id, feed_id);
create index if not exists voted_marks_place_idx on voted_marks (workspace_id, place_id, created_at) where place_id is not null;
-- countsOf on the day: who has voted, without reading every person.
create index if not exists persons_ws_voted_idx on persons (workspace_id) where voted_at is not null and deleted_at is null;

-- The switch's three states, the sending rule (the law first), and the
-- Ready list. All defaulted: an old row reads as today.
alter table voted_settings add column if not exists practice boolean not null default false;
alter table voted_settings add column if not exists practice_users uuid[] not null default '{}';
alter table voted_settings add column if not exists send text not null default 'after_close';
alter table voted_settings drop constraint if exists voted_settings_send_check;
alter table voted_settings add constraint voted_settings_send_check check (send in ('after_close','live'));
alter table voted_settings add column if not exists close_override jsonb not null default '{}';
alter table voted_settings add column if not exists released jsonb not null default '[]';
alter table voted_settings add column if not exists ceo_answer jsonb;
alter table voted_settings add column if not exists scope text not null default 'turfs';
alter table voted_settings drop constraint if exists voted_settings_scope_check;
alter table voted_settings add constraint voted_settings_scope_check check (scope in ('turfs','campaign'));
alter table voted_settings add column if not exists ready jsonb not null default '{}';

-- Who works where on voting days: a scrutineer at one voting place, or a
-- runner carrying any place's sheets. One open post per person.
create table if not exists gotv_posts (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('scrutineer','runner')),
  place_id uuid references places(id) on delete set null,
  days jsonb not null default '[]',
  appointed boolean not null default false,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  ended_at timestamptz
);
create unique index if not exists gotv_posts_open_idx on gotv_posts (workspace_id, user_id) where ended_at is null;

-- The office's "To check": names a scrutineer could not match.
create table if not exists gotv_checks (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  typed text not null check (length(typed) <= 120),
  place_id uuid references places(id) on delete set null,
  by uuid references users(id),
  written_at timestamptz not null,
  practice boolean not null default false,
  resolved_at timestamptz,
  resolved_by uuid,
  person_id uuid,
  outcome text check (outcome in ('marked','not_ours')),
  client_id uuid,
  created_at timestamptz not null default now()
);
create unique index if not exists gotv_checks_client_idx on gotv_checks (workspace_id, client_id) where client_id is not null;
create index if not exists gotv_checks_open_idx on gotv_checks (workspace_id, created_at) where resolved_at is null;

-- Practice marks, apart from the real record; wiped when practice ends.
create table if not exists gotv_practice (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  person_id uuid references persons(id) on delete cascade,
  voted boolean not null default true,
  undoes uuid,
  source text not null,
  place_id uuid references places(id) on delete set null,
  marked_by uuid,
  client_id uuid,
  created_at timestamptz not null,
  inserted_at timestamptz not null default now(),
  feed_id bigint default nextval('voted_feed_seq')
);
create unique index if not exists gotv_practice_client_idx on gotv_practice (workspace_id, client_id) where client_id is not null;
create index if not exists gotv_practice_person_idx on gotv_practice (workspace_id, person_id);
create index if not exists gotv_practice_feed_idx on gotv_practice (workspace_id, feed_id);

-- Election-day sign-in codes: only the token's hash; one use, 15 minutes.
-- The session a code makes is limited to Who voted (sessions.scope 'gotv').
alter table sessions add column if not exists scope text;
alter table sessions add column if not exists via uuid;
create table if not exists gotv_signin (
  token_hash text primary key,
  id uuid not null,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  created_by uuid references users(id),
  expires_at timestamptz not null,
  used_at timestamptz
);
`;
