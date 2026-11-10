// Email that hears back: what the sender said about each email, each of its
// events once, and the addresses the campaign must not email.
//
// blast_recipients gains the sender's side of each email:
//   provider, provider_id   which sender took it, and its own id for it
//   delivered_at            the sender says it reached the mailbox
//   bounced_at              it didn't: bounced for good, or the sender
//                           refused it (its own suppression list);
//                           bounce_detail has the sender's words — also for a
//                           delay or a failure, which set no bounced_at
//   complained_at           the reader marked it as spam
// The row's status stays 'sent' (the sender took it); a row left 'sending'
// (not sure it went) becomes 'sent' when an event for it arrives.
//
// mail_events: each of the sender's events once (provider, its id), with the
// campaign it was about when there is one, kept 30 days (webhook.js).
//
// email_suppressions is about an ADDRESS, not a person and not a consent: a
// bounce is not someone saying no, and a person who gets a new address is
// reachable again. A complaint is both: the address goes on the list and
// the consent is ended (ext/site/consent.js emailOff). lifted_at: the desk
// put it back (a typo fixed, a full mailbox emptied).
// All new columns are nullable; safe on a database of any size.
export const sql = `
alter table blast_recipients add column if not exists provider text;
alter table blast_recipients add column if not exists provider_id text;
alter table blast_recipients add column if not exists delivered_at timestamptz;
alter table blast_recipients add column if not exists bounced_at timestamptz;
alter table blast_recipients add column if not exists bounce_detail text;
alter table blast_recipients add column if not exists complained_at timestamptz;
create index if not exists brecip_provider_idx on blast_recipients (provider_id) where provider_id is not null;

create table if not exists mail_events (
  provider text not null,
  id text not null,
  workspace_id uuid references workspaces(id) on delete cascade,
  kind text not null,
  received_at timestamptz not null default now(),
  primary key (provider, id)
);
create index if not exists mail_events_ws_at_idx on mail_events (workspace_id, provider, received_at);

create table if not exists email_suppressions (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  email text not null,
  reason text not null check (reason in ('bounce', 'complaint')),
  source text not null,
  detail text,
  created_at timestamptz not null default now(),
  lifted_at timestamptz,
  unique (workspace_id, email)
);
`;
