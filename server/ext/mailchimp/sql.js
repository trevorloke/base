// Mailchimp: what was sent where, and how far consent is in step.
//
// mailchimp_syncs — one per list sent to an audience. The list becomes a tag
// there (a static segment): `tag` is its name, segment_id Mailchimp's id for
// it once made. consent: 'subscribed' sends only addresses on base.win's
// newsletter list (the default), 'all' everyone on the list who can be
// emailed. The numbers are the last sync's: total (addresses the list
// sends), added (new to the audience), tagged (put in the tag), removed
// (taken out of the tag), skipped (addresses Mailchimp would not take, with
// its own words about the first of them in skipped_why), and what the sync's
// own pull turned off here before it sent anyone: pulled_unsubscribed,
// pulled_cleaned. While one is on its way: todo (still to go) and cursor
// (how far it got, so a retry or the next part carries on from there and no
// address is offered twice in one sync).
//
// mailchimp_state — one per campaign, nothing secret: which audience the
// pulls were about, when the last one started (pulled_through: the next
// daily pull asks only for what changed since, less an hour), when
// everything was last read (full_at), and what the last pull said.
// The first pull from an audience turns email off here for everyone on file
// who left there, and nobody here can turn it back on, so it waits for a
// person's yes: agreed_for is the audience someone said yes to, and
// agreed_unsubscribed, agreed_cleaned the numbers they were shown — kept
// until the first pull after it is done (it counts again, and asks again
// when it would turn off more), then null: later pulls run as built. Until
// then a pull only counts: ask_for, ask_name, ask_unsubscribed, ask_cleaned
// — the question's words — and asked_at, when it was counted.
export const sql = `
create table if not exists mailchimp_syncs (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  list_id uuid not null references lists(id) on delete cascade,
  audience_id text not null,
  tag text not null,
  segment_id text,
  consent text not null default 'subscribed' check (consent in ('subscribed', 'all')),
  status text not null default 'queued' check (status in ('queued', 'syncing', 'synced', 'failed')),
  total int not null default 0,
  added int not null default 0,
  tagged int not null default 0,
  removed int not null default 0,
  skipped int not null default 0,
  todo int not null default 0,
  cursor jsonb,
  note text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  synced_at timestamptz,
  unique (workspace_id, list_id, audience_id)
);
alter table mailchimp_syncs add column if not exists skipped_why text;
alter table mailchimp_syncs add column if not exists pulled_unsubscribed int not null default 0;
alter table mailchimp_syncs add column if not exists pulled_cleaned int not null default 0;

create table if not exists mailchimp_state (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  audience_id text,
  pulled_through timestamptz,
  full_at timestamptz,
  pulled_at timestamptz,
  pull_ok boolean,
  pull_note text
);
alter table mailchimp_state add column if not exists agreed_for text;
alter table mailchimp_state add column if not exists ask_for text;
alter table mailchimp_state add column if not exists ask_name text;
alter table mailchimp_state add column if not exists ask_unsubscribed int;
alter table mailchimp_state add column if not exists ask_cleaned int;
alter table mailchimp_state add column if not exists asked_at timestamptz;
alter table mailchimp_state add column if not exists agreed_unsubscribed int;
alter table mailchimp_state add column if not exists agreed_cleaned int;
`;
