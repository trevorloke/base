// Gift import tables. Idempotent; run at boot after the core schema.
//
//   gift_imports      one per file brought in: its name, who and when, and
//                     when it was taken back (undone_at) — an import can be
//                     taken back whole for a day.
//   gift_import_rows  the pile: a gift from a file whose donor could not be
//                     told for sure (nobody on file, or more than one it
//                     could be). It holds what the file said — the donor as
//                     written, the amount, the day — until a person picks
//                     the donor (settled: gift_id), or leaves it out.
//
// A gift that came from a file says so in gifts.attrs, as an online gift
// does (ext/payments): source 'import', import_id, import_key (what makes it
// the same gift when the file comes in again: shared/giftfile.js giftKey),
// import_ref (the other tool's own id) and import_receipt (its receipt
// number there, as text). The two indexes find a gift by its key and an
// import's gifts.
export const sql = `
create table if not exists gift_imports (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  file_name text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  undone_at timestamptz,
  undone_by uuid references users(id)
);
create index if not exists gift_imports_ws_idx on gift_imports (workspace_id, created_at desc);

create table if not exists gift_import_rows (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  import_id uuid not null references gift_imports(id) on delete cascade,
  row_no int,
  import_key text not null,
  donor jsonb not null default '{}',
  amount_cents integer not null check (amount_cents > 0),
  date date not null,
  method text,
  slate text,
  import_ref text,
  import_receipt text,
  status text not null default 'waiting' check (status in ('waiting', 'settled', 'left_out')),
  gift_id uuid,
  settled_by uuid references users(id),
  settled_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists gift_import_rows_ws_idx on gift_import_rows (workspace_id, status, created_at);
create index if not exists gift_import_rows_key_idx on gift_import_rows (workspace_id, import_key);

create index if not exists gifts_import_key_idx on gifts (workspace_id, (attrs->>'import_key')) where attrs ? 'import_key';
create index if not exists gifts_import_id_idx on gifts (workspace_id, (attrs->>'import_id')) where attrs ? 'import_id';
`;
