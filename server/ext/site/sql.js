// The website's tables (SITE.md). Idempotent: run at every boot after the
// core schema (under test:pg every test file boots against its own database).
//
//   site_settings   one row per campaign: the theme, the menu and title bar,
//                   footer, announcement bar, search and sharing, the
//                   organization's details, social accounts and the domains
//                   the site answers on (shape.js says what each holds)
//   site_pages      a page: its address (slug), title and description, the
//                   draft being edited and what is live (published), each
//                   { title, description, modules: [{ id, kind, hidden,
//                   props }] }; version counts publishes (the page cache's
//                   key); show_in_nav / nav_order put it in the menu
//   site_posts      news posts (published_at orders them, newest first)
//   site_campaigns  petitions and pledges; their signatures are site_actions
//   site_actions    every form a visitor sent: who (person_id), what (kind,
//                   payload: what they typed), where (page, module, source),
//                   who sent them (referrer_id); client_key makes a retry the
//                   same action, never a second; answer is what they were told
//                   (a checkout address) so a retry gets it again; join and
//                   donate: checkout_id, their checkout (ext/payments) —
//                   answer stays empty until Stripe has made its page, so a
//                   retry after a failure asks again for the same checkout
//   consent_events  every yes or no to email or texts, with the words they
//                   saw and the address it was about — from the site's forms
//                   and pages, and from base.win's own (an unsubscribe link,
//                   a STOP text, the desk's Remove), so the record is whole
//   site_keys       the server's signing secret when SITE_SECRET isn't set
//                   (tokens.js) — one row, never exported
//   app_hosts       every address people used the app at, signed in (the
//                   API notes it, at most once an hour): never a website
//                   domain (store.js noteAppHost) — the server's, never exported
//
// shifts.public: a shift the public may see and sign up for on the site's
// events (the desk ticks "Show on the website"). persons.attrs.ref_code is a
// supporter's referral code (/r/:code).
export const sql = `
create table if not exists site_settings (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  theme jsonb not null default '{}',
  nav jsonb not null default '{}',
  footer jsonb not null default '{}',
  announcement jsonb not null default '{}',
  seo jsonb not null default '{}',
  org jsonb not null default '{}',
  social jsonb not null default '{}',
  domains jsonb not null default '[]',
  updated_at timestamptz not null default now()
);

create table if not exists site_pages (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  slug text not null,
  title text not null,
  description text not null default '',
  draft jsonb not null default '{}',
  published jsonb,
  version int not null default 0,
  status text not null default 'draft' check (status in ('draft', 'published')),
  show_in_nav boolean not null default false,
  nav_order int not null default 0,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists site_pages_slug_idx on site_pages (workspace_id, slug) where deleted_at is null;
create index if not exists site_pages_nav_idx on site_pages (workspace_id, nav_order) where deleted_at is null and status = 'published' and show_in_nav;

create table if not exists site_posts (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  slug text not null,
  title text not null,
  excerpt text not null default '',
  body text not null default '',
  image jsonb not null default '{}',
  status text not null default 'draft' check (status in ('draft', 'published')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists site_posts_slug_idx on site_posts (workspace_id, slug) where deleted_at is null;
create index if not exists site_posts_live_idx on site_posts (workspace_id, published_at desc) where deleted_at is null and status = 'published';

create table if not exists site_campaigns (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  slug text not null,
  kind text not null check (kind in ('petition', 'pledge')),
  title text not null,
  excerpt text not null default '',
  body text not null default '',
  statement text not null default '',
  goal int,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists site_campaigns_slug_idx on site_campaigns (workspace_id, slug) where deleted_at is null;

create table if not exists site_actions (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  person_id uuid references persons(id) on delete set null,
  kind text not null,
  campaign_id uuid,
  page_id uuid,
  module_id text,
  payload jsonb not null default '{}',
  source text,
  referrer_id uuid,
  client_key text,
  answer jsonb,
  created_at timestamptz not null default now()
);
alter table site_actions add column if not exists checkout_id uuid;
create unique index if not exists site_actions_key_idx on site_actions (workspace_id, client_key) where client_key is not null;
create index if not exists site_actions_campaign_idx on site_actions (workspace_id, campaign_id, person_id) where campaign_id is not null;
create index if not exists site_actions_person_idx on site_actions (workspace_id, person_id);
create index if not exists site_actions_time_idx on site_actions (workspace_id, created_at);
create index if not exists site_actions_referrer_idx on site_actions (workspace_id, referrer_id) where referrer_id is not null;

create table if not exists consent_events (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  person_id uuid references persons(id) on delete set null,
  channel text not null check (channel in ('email', 'sms')),
  granted boolean not null,
  source text,
  wording text,
  address text,
  created_at timestamptz not null default now()
);
create index if not exists consent_events_person_idx on consent_events (workspace_id, person_id, channel, created_at);
create index if not exists consent_events_address_idx on consent_events (workspace_id, address, channel, created_at);

create table if not exists site_keys (
  name text primary key,
  secret text not null,
  created_at timestamptz not null default now()
);

create table if not exists app_hosts (
  host text primary key,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

alter table shifts add column if not exists public boolean not null default false;
create index if not exists shifts_public_idx on shifts (workspace_id, starts_at) where deleted_at is null and public;
create index if not exists persons_ref_code_idx on persons (workspace_id, (attrs->>'ref_code')) where attrs ? 'ref_code';
`;
