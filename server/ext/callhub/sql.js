// CallHub's tables. Nothing secret is kept: no key, no address.
//   callhub_pushes    one list or phone bank sent to a CallHub phonebook:
//                     how far it is, what CallHub said when it stopped, the
//                     numbers it would not take (refused, with its words for
//                     the last), and how its results are read (outcomes: the
//                     desk's corrections to the pattern table; rating_map:
//                     the survey question and which answer is which rating)
//   callhub_contacts  who went into which phonebook, under which number —
//                     the only numbers a result can ever land on. Everyone
//                     on the list with the number is remembered (sent_at:
//                     when the number went); the first by name is the one
//                     whose name went and the one results are filed on
//   callhub_dnc       the numbers sent to CallHub's do-not-call list, so
//                     none is sent twice (category: 1 calls, 2 texts, 3 both;
//                     entry: CallHub's own id for it, when it said — how a
//                     number told for texts only is changed to calls too)
//   callhub_results   every result as it came (raw), once: filed on a person
//                     (contact_id) or kept unfiled for the desk
export const sql = `
create table if not exists callhub_pushes (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  source_kind text not null check (source_kind in ('list', 'bank')),
  source_id uuid not null,
  name text not null,
  phonebook_id text,
  campaign_id text,
  dnc_list text,
  outcomes jsonb not null default '{}',
  rating_map jsonb,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed')),
  total int not null default 0,
  sent int not null default 0,
  skipped int not null default 0,
  refused int not null default 0,
  refused_note text,
  note text,
  resume_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists callhub_pushes_source_idx on callhub_pushes (workspace_id, source_kind, source_id, created_at desc);

create table if not exists callhub_contacts (
  push_id uuid not null references callhub_pushes(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  person_id uuid not null references persons(id) on delete cascade,
  phone text not null,
  first_on_number boolean not null default true,
  position int not null default 0,
  sent_at timestamptz,
  primary key (push_id, person_id)
);
create index if not exists callhub_contacts_phone_idx on callhub_contacts (phone);
create index if not exists callhub_contacts_sent_idx on callhub_contacts (sent_at) where sent_at is not null;

create table if not exists callhub_dnc (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  phone text not null,
  category int not null,
  entry text,
  sent_at timestamptz not null default now(),
  primary key (workspace_id, phone)
);

create table if not exists callhub_results (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  key text not null,
  via text not null check (via in ('webhook', 'export')),
  push_id uuid,
  person_id uuid,
  contact_id uuid,
  phone text,
  disposition text,
  raw jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists callhub_results_key_idx on callhub_results (workspace_id, key, created_at desc);
create index if not exists callhub_results_push_idx on callhub_results (push_id) where push_id is not null;
`;
