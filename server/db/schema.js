// Core DDL. One place, executed idempotently at boot. Record-type tables are
// generated from the shared registry — the registry IS the migration source.
import { ddlFor, recordTypeKeys } from '@starbase/shared/registry';
import { FOLD_FROM, FOLD_TO } from '@starbase/shared/names';

const CORE = `
create table if not exists workspaces (
  id uuid primary key,
  name text not null,
  slug text unique,
  candidate text,
  jurisdiction text not null default 'bc-provincial',
  settings jsonb not null default '{}',
  event_seq bigint not null default 0,
  last_event_hash text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists users (
  id uuid primary key,
  email text not null unique,
  name text not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);

-- Tenancy is a membership, never a mutable column on users.
create table if not exists memberships (
  user_id uuid not null references users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  role text not null check (role in ('manager', 'treasurer', 'staff', 'volunteer')),
  created_at timestamptz not null default now(),
  primary key (user_id, workspace_id)
);

create table if not exists sessions (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- Invites: how volunteers and staff join a campaign. Only the token hash is
-- stored; the join link is shown once to the inviter (and emailed if possible).
create table if not exists invites (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  email text not null,
  role text not null check (role in ('manager', 'treasurer', 'staff', 'volunteer')),
  token_hash text not null unique,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz
);
create index if not exists invites_ws_idx on invites (workspace_id) where accepted_at is null;

-- The Person primitive: one canonical row per person/org, first-class.
create table if not exists persons (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null default 'person' check (kind in ('person', 'org')),
  name text not null,
  email text,
  phone text,
  address text,
  unit text,
  city text,
  postal text,
  lat double precision,
  lng double precision,
  tags jsonb not null default '[]',
  socials jsonb not null default '{}',
  rating text,
  rated_at timestamptz,
  attrs jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
-- The house number on its own (lib/address.js); address stays the whole civic line.
alter table persons add column if not exists house_number text;
create index if not exists persons_ws_name_idx on persons (workspace_id, lower(name)) where deleted_at is null;
create index if not exists persons_ws_email_idx on persons (workspace_id, lower(email)) where deleted_at is null;
create index if not exists persons_ws_addr_idx on persons (workspace_id, lower(address)) where deleted_at is null;
create index if not exists persons_ws_geo_idx on persons (workspace_id, lat, lng) where deleted_at is null and lat is not null;
-- The import's candidate lookups (routes/data.js), one per way a row matches:
-- name + phone digits, name + street, and a name with nothing else on file.
-- Names and streets with case, spaces and punctuation stripped — looser than
-- the import's matching, so a lookup never misses a match.
create index if not exists persons_ws_namephone_idx on persons (workspace_id,
  (regexp_replace(lower(name), '[^[:alnum:]]+', '', 'g') || '|' || regexp_replace(phone, '[^0-9]+', '', 'g')))
  where deleted_at is null;
create index if not exists persons_ws_nameaddr_idx on persons (workspace_id,
  (regexp_replace(lower(name), '[^[:alnum:]]+', '', 'g') || '|' || regexp_replace(lower(address), '[^[:alnum:]]+', '', 'g')))
  where deleted_at is null;
create index if not exists persons_ws_nameonly_idx on persons (workspace_id, (regexp_replace(lower(name), '[^[:alnum:]]+', '', 'g')))
  where deleted_at is null and coalesce(email, '') = '' and coalesce(phone, '') = '' and coalesce(address, '') = '';

-- Every door/phone/text touch, with the campaign's rating scale.
create table if not exists contacts (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  person_id uuid not null references persons(id) on delete cascade,
  channel text not null check (channel in ('door', 'phone', 'text')),
  outcome text not null check (outcome in ('contacted', 'no_answer', 'refused', 'moved', 'inaccessible')),
  rating text,
  note text,
  client_id uuid,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index if not exists contacts_ws_person_idx on contacts (workspace_id, person_id);
create index if not exists contacts_ws_time_idx on contacts (workspace_id, created_at);

-- Signs: billboard (4×8), large (4×4), lawn — at a person's door or a bare address.
create table if not exists signs (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  person_id uuid references persons(id) on delete set null,
  address text,
  lat double precision,
  lng double precision,
  kind text not null check (kind in ('billboard', 'large', 'lawn')),
  status text not null default 'requested' check (status in ('requested', 'installed', 'removed')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists signs_ws_idx on signs (workspace_id, status);

-- Volunteer roles (driver, scrutineer, …); detail carries language / community.
create table if not exists volunteer_roles (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  person_id uuid not null references persons(id) on delete cascade,
  role text not null,
  detail text,
  created_at timestamptz not null default now()
);
create index if not exists vroles_ws_person_idx on volunteer_roles (workspace_id, person_id);
create index if not exists vroles_ws_role_idx on volunteer_roles (workspace_id, role);

-- Volunteer shifts + assignments; notify sends email/text with instructions + link.
create table if not exists shifts (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  title text not null,
  role text,
  location text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  instructions text,
  link text,
  capacity int,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists shifts_ws_time_idx on shifts (workspace_id, starts_at) where deleted_at is null;

create table if not exists shift_assignments (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  shift_id uuid not null references shifts(id) on delete cascade,
  person_id uuid not null references persons(id) on delete cascade,
  status text not null default 'assigned' check (status in ('assigned', 'confirmed', 'declined', 'no_show', 'completed')),
  notified_at timestamptz,
  notify_email text,
  notify_text text,
  created_at timestamptz not null default now(),
  unique (shift_id, person_id)
);
create index if not exists sassign_ws_shift_idx on shift_assignments (workspace_id, shift_id);

-- Newsletter list (public signup at /n/:workspace; one-click unsubscribe /u/:id).
create table if not exists subscriptions (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  email text not null,
  name text,
  status text not null default 'subscribed' check (status in ('subscribed', 'unsubscribed')),
  source text,
  created_at timestamptz not null default now(),
  unique (workspace_id, email)
);

-- Email blasts: newsletters to the list, press releases to media-tagged people.
create table if not exists blasts (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null check (kind in ('newsletter', 'press')),
  subject text not null,
  body text not null,
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  provider_note text,
  audience_count int not null default 0,
  sent_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table if not exists blast_recipients (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  blast_id uuid not null references blasts(id) on delete cascade,
  email text not null,
  name text,
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  created_at timestamptz not null default now()
);
create index if not exists brecip_blast_idx on blast_recipients (workspace_id, blast_id);
-- Email blasts and text blasts to a list (ext/lists): the send keeps its
-- audience; a recipient is an address or a number, and the person it was.
alter table blasts drop constraint if exists blasts_kind_check;
alter table blasts add constraint blasts_kind_check check (kind in ('newsletter', 'press', 'eblast', 'text'));
alter table blasts add column if not exists audience jsonb;
alter table blasts add column if not exists list_id uuid;
alter table blast_recipients alter column email drop not null;
alter table blast_recipients add column if not exists phone text;
alter table blast_recipients add column if not exists person_id uuid;

-- The event log: append-only, per-workspace sequence, hash-chained.
-- This one table is the sync protocol, the audit trail, and the API.
create table if not exists events (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  seq bigint not null,
  action text not null,
  entity_type text not null,
  entity_id uuid not null,
  op text not null check (op in ('create', 'update', 'void', 'restore', 'merge')),
  payload jsonb not null,
  actor_id uuid references users(id),
  client_ts timestamptz,
  server_ts timestamptz not null default now(),
  payload_hash text not null,
  hash text not null,
  primary key (workspace_id, seq)
);
create index if not exists events_entity_idx on events (workspace_id, entity_type, entity_id);

-- Turfs: polygons drawn on the map, assigned to canvassers; walk lists are
-- the located doors inside.
create table if not exists turfs (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  polygon jsonb not null,
  color text,
  notes text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create table if not exists turf_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  turf_id uuid not null references turfs(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (turf_id, user_id)
);

-- Contribution-cap rules, per jurisdiction and year. Seeded with the BC
-- provincial annual individual limit; VERIFY the current indexed amount with
-- Elections BC before relying on it for a filing year. Workspaces may
-- override via settings.capCents.
create table if not exists cap_rules (
  jurisdiction text not null,
  year int not null,
  cap_cents integer not null,
  source_note text not null,
  primary key (jurisdiction, year)
);
`;

// A name folded for finding and A–Z (shared/names.js foldName says the same
// in the browser): accents off, ' ’ ʼ and full stops dropped, ASCII lower
// case only (collate "C", so it's the same on every database), spaces
// squeezed. person_fold_tail is a surname's last word ("Van Der Berg" →
// berg, "Sandhu-Gill" → gill); it names public.person_fold because
// Postgres 17 builds indexes with only pg_catalog on the search path. No
// SET search_path on either: they must stay inlinable, or the indexes on
// them (ext/search) stop matching the queries. Never change these bodies —
// a different fold is a new function with new indexes. A name of plain
// printable ASCII with no apostrophe or full stop (most of them) skips the
// translate, which is the slow part and changes nothing there; one with
// nothing past U+00FF (most of the rest) translates by the Latin-1 part
// of the strings only, which gives the same.
const sqlText = (s) => `'${s.replace(/'/g, "''")}'`;
const LATIN1 = [...FOLD_FROM].map((ch, i) => [ch, FOLD_TO[i] ?? '']).filter(([ch]) => ch.charCodeAt(0) <= 0xff);
const FOLD = `
create or replace function person_fold(t text) returns text language sql immutable parallel safe as $fold$
  select btrim(regexp_replace(lower((case when t !~ '[^\\x20-\\x26\\x28-\\x2d\\x2f-\\x7e]' then t
    when t !~ '[^\\x01-\\xff]' then translate(t, ${sqlText(LATIN1.map(([ch]) => ch).join(''))}, ${sqlText(LATIN1.map(([, to]) => to).join(''))})
    else translate(t, ${sqlText(FOLD_FROM)}, ${sqlText(FOLD_TO)}) end) collate "C"), '[ \\t\\n\\r]+', ' ', 'g'))
$fold$;
create or replace function person_fold_tail(t text) returns text language sql immutable parallel safe as $fold$
  select regexp_replace(public.person_fold(t), '^.*[ -]', '')
$fold$;
`;

const SEED = `
insert into cap_rules (jurisdiction, year, cap_cents, source_note) values
  ('bc-provincial', 2024, 145082, 'Elections BC 2024 indexed annual limit — verify before filing'),
  ('bc-provincial', 2025, 149565, 'Elections BC 2025 indexed annual limit — verify before filing'),
  ('bc-municipal',  2022, 125000, 'LECFA 2022 per-campaign contribution limit — verify the indexed amount for the current election year'),
  ('bc-municipal',  2026, 142970, 'Elections BC 2026 local elections limit — one limit for an elector organization and its endorsed candidates together; verify before filing')
on conflict do nothing;
`;

// Columns added after the first release — bring pre-existing dev databases up
// to the current shape. All idempotent.
const ALTERS = `
alter table workspaces add column if not exists slug text unique;
alter table persons add column if not exists unit text;
alter table persons add column if not exists city text;
alter table persons add column if not exists postal text;
alter table persons add column if not exists lat double precision;
alter table persons add column if not exists lng double precision;
alter table persons add column if not exists tags jsonb not null default '[]';
alter table persons add column if not exists socials jsonb not null default '{}';
alter table persons add column if not exists rating text;
alter table persons add column if not exists rated_at timestamptz;
alter table gifts add column if not exists cadence text;
alter table contacts add column if not exists client_id uuid;
create unique index if not exists contacts_client_idx on contacts (workspace_id, client_id) where client_id is not null;
-- Later taps of the same visit that finished this contact instead of logging
-- a second one (contact.log visit_of: "Save answers", then the rating): their
-- outbox ids, so a replay of one is recognised.
alter table contacts add column if not exists merged_client_ids jsonb not null default '[]';
-- A contribution is to one slate (shared/canvass.js SLATES; null = the first);
-- the annual limit is per contributor per slate.
alter table gifts add column if not exists slate text;
-- When an address left the newsletter list (its own link, or the desk's
-- Remove). Once off, only the person can rejoin — the desk's Add says so.
alter table subscriptions add column if not exists unsubscribed_at timestamptz;
-- Background jobs (lib/jobs.js): ladder steps, A/B winners, retries.
create table if not exists jobs (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null,
  run_at timestamptz not null default now(),
  payload jsonb not null default '{}',
  key text,
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed', 'cancelled')),
  attempts int not null default 0,
  last_error text,
  started_at timestamptz,
  done_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists jobs_due_idx on jobs (status, run_at);
create unique index if not exists jobs_key_idx on jobs (workspace_id, key) where key is not null;
`;

export const bootstrap = async (db) => {
  // Several instances may boot against one Postgres at once; serialize DDL.
  const lock = db.kind === 'postgres';
  if (lock) await db.query('select pg_advisory_lock(7271989)');
  try {
    await db.exec(CORE);
    await db.exec(FOLD);
    for (const key of recordTypeKeys()) await db.exec(ddlFor(key));
    await db.exec(ALTERS);
    // Feature modules' tables (server/ext/*). Imported here, not at the top,
    // because feature modules may import the db client, which imports this.
    const { EXTENSIONS } = await import('../ext.js');
    for (const e of EXTENSIONS) if (e.sql) await db.exec(e.sql);
    await db.exec(SEED);
  } finally {
    if (lock) await db.query('select pg_advisory_unlock(7271989)');
  }
};
