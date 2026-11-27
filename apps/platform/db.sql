-- The control centre's own database (base-platform-db). Run at every start;
-- every statement is idempotent. It holds no people, no client database
-- address and no Render key. With a Render key set on the service, it keeps
-- Render's ids for each campaign's service and database and one row per
-- change asked for there: ids, names and states, never a setting's value
-- and never anything Render answered.

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
-- Every setup makes a new device epoch (as do a recovery-code sign-in and the
-- wrong-code lock): the known-browser marks are signed over it, so each of
-- those forgets every browser, whatever setup code comes back later.
alter table operators add column if not exists device_epoch text;
update operators set device_epoch = md5(random()::text || clock_timestamp()::text) where device_epoch is null;

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

-- via: 'server' is the Render address saved for it; 'public' is a client's
-- own address, https://<name>.base.win.
create table if not exists checks (
  id bigserial primary key,
  campaign text not null,
  env text not null,
  via text not null check (via in ('server', 'public')),
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
  problem text                           -- error name only, never a body
);
create index if not exists checks_recent on checks (campaign, env, via, at desc);
-- Whether the campaign's workspace exists (health campaignMade). setup_open
-- is false on any server holding the control centre's key, made or not.
alter table checks add column if not exists campaign_made boolean;
-- Where the campaign keeps its data (health store): 'postgres', or 'embedded'
-- for the built-in database, which is not a real one. Null from a server
-- too old to say.
alter table checks add column if not exists store text;
-- A database made when the second check was kept under via 'door' (first
-- through the door, later at the client's own address): via was
-- 'server' or 'door', and each check kept whether the door's key was set.
-- Those checks are kept and named 'public', the second check's name now;
-- this runs once (afterwards the rule already names 'public').
do $$
begin
  if exists (select 1 from pg_constraint
      where conrelid = 'checks'::regclass and conname = 'checks_via_check'
        and pg_get_constraintdef(oid) not like '%''public''%') then
    alter table checks drop constraint checks_via_check;
    update checks set via = 'public' where via = 'door';
    alter table checks add constraint checks_via_check check (via in ('server', 'public'));
  end if;
end $$;
alter table checks drop column if exists door_key;

create table if not exists checklist (
  campaign text not null references campaigns(name),
  item text not null,
  done_at timestamptz,
  done_by text check (done_by in ('auto', 'you')),
  primary key (campaign, item)
);
-- The tick for "its own address answers" was kept as 'address' by an
-- earlier control centre; it is 'public' now. Kept, under its new name.
update checklist c set item = 'public' where item = 'address'
  and not exists (select 1 from checklist d where d.campaign = c.campaign and d.item = 'public');

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

-- Render's ids for a campaign's service and database (ids only; cleared with the pin when the address changes).
alter table environments add column if not exists render_service text;
alter table environments add column if not exists render_db text;
create unique index if not exists environments_render_service_uq on environments (render_service) where render_service is not null;
create unique index if not exists environments_render_db_uq on environments (render_db) where render_db is not null;
-- One row per Render change asked for: the page shown, the one change at a
-- time per campaign, and the limits on how many (so they hold across a restart).
create table if not exists render_jobs (
  id text primary key,                   -- 128 random bits; the confirm page's hidden field
  campaign text not null references campaigns(name),
  env text not null,
  what text not null,                    -- link | deploy | restart | key | domain | close-db
  target text,                           -- Render's id for the service or database
  detail jsonb not null default '{}',    -- label, setting (a NAME) and which step has no answer; never a value
  state text not null check (state in ('asked', 'running', 'done', 'failed', 'unknown')),
  asked_in text not null,                -- sha256(session token hash + job id): compares only, opens nothing
  asked_at timestamptz not null default now(),
  began_at timestamptz, ended_at timestamptz,
  problem text                           -- a problem's word or a status; never a body
);
create unique index if not exists render_jobs_one_running on render_jobs (campaign) where state = 'running';
create index if not exists render_jobs_recent on render_jobs (campaign, asked_at desc);
