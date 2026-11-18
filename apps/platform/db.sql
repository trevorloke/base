-- The control centre's own database (base-platform-db). Run at every start;
-- every statement is idempotent. It holds no people, no client database
-- address, no door key and no Render key.

-- The one operator. Password: scrypt (server/lib/auth.js hashPassword).
-- Authenticator key: AES-256-GCM, key = HKDF(OPS_SECRET, info 'base.win/ops-totp/v1').
-- setup_code_hash: HMAC-SHA256(HKDF(OPS_SECRET, 'base.win/ops-setup/v1'), OPS_SETUP_CODE) at setup.
create table if not exists operators (
  id uuid primary key,
  email text not null,
  name text not null,
  password_hash text not null,
  totp_sealed text not null,
  totp_last_step bigint,
  recovery jsonb not null default '[]',
  recovery_salt text not null,
  setup_code_hash text not null,
  fails int not null default 0,          -- wrong codes after a right password
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists operators_one on operators ((true));

-- Setup in progress: a ticket per browser, ten minutes, its hash in a cookie.
create table if not exists operator_setup (
  token_hash text primary key,
  email text, name text, password_hash text,
  totp_sealed text, recovery jsonb, recovery_salt text,
  setup_code_hash text not null,         -- the code current when the ticket was made
  expires_at timestamptz not null
);

-- Tries per setup code (30 in all, then a new code is needed).
create table if not exists setup_tries (
  code_hash text primary key,            -- the same HMAC as setup_code_hash
  n int not null default 0
);

create table if not exists ops_sessions (
  token_hash text primary key,
  operator_id uuid not null references operators(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  code_at timestamptz not null,          -- the last right code (sign-in or step-up)
  expires_at timestamptz not null        -- created_at + 12 h
);

create table if not exists campaigns (
  name text primary key check (name ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  display text not null,
  kind text not null default 'client' check (kind in ('client', 'sample')),
  values jsonb not null default '{}',    -- the wizard's campaign values (city, province, rules, tz, races); no secrets
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

-- A client has 'production'; the sample has 'staging'. Pinned identity.
create table if not exists environments (
  campaign text not null references campaigns(name),
  env text not null check (env in ('production', 'staging')),
  server_url text,                       -- the Render address the owner pasted, normalized origin
  instance text,                         -- pinned from the first health that matched server_url
  instance_at timestamptz,
  primary key (campaign, env)
);
create unique index if not exists environments_server_uq on environments (server_url) where server_url is not null;
create unique index if not exists environments_instance_uq on environments (instance) where instance is not null;

-- base.win's one shared sample (staging), listed at the top.
insert into campaigns (name, display, kind) values ('sample', 'Sample (staging)', 'sample') on conflict (name) do nothing;
insert into environments (campaign, env) values ('sample', 'staging') on conflict (campaign, env) do nothing;

create table if not exists checks (
  id bigserial primary key,
  campaign text not null,
  env text not null,
  via text not null check (via in ('server', 'door')),
  at timestamptz not null default now(),
  answering boolean not null,
  status int, ms int,
  database text, commit text, build text,
  tz_current boolean,
  env_reported text,
  own_origin text,
  instance text,
  address text,
  entry text,
  platform_kids jsonb,
  setup_open boolean,
  door_key boolean,
  problem text                           -- error name only, never a body
);
create index if not exists checks_recent on checks (campaign, env, via, at desc);

create table if not exists checklist (
  campaign text not null references campaigns(name),
  item text not null,
  done_at timestamptz,
  done_by text check (done_by in ('auto', 'you')),
  primary key (campaign, item)
);

-- The operator log: append-only, chained with server/lib/events.js canonical()
-- and chainHash(prev, seq, action, 'campaign', campaign || '', 'create',
-- operator_id, sha256(canonical(payload))).
create table if not exists ops_chain (id int primary key check (id = 1), seq bigint not null, last_hash text not null);
insert into ops_chain (id, seq, last_hash) values (1, 0, '') on conflict (id) do nothing;
create table if not exists ops_log (
  seq bigint primary key,
  at timestamptz not null default now(),
  operator_id uuid,
  action text not null,
  campaign text,
  payload jsonb not null,
  payload_hash text not null,
  hash text not null
);
