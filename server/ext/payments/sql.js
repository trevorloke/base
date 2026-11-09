// Online payments' tables. Idempotent; run at boot after the core schema
// (and after ext/membership, whose gift_pledges a monthly gift keeps).
//
//   stripe_checkouts  one per Checkout opened (checkoutFor): who, what (a
//                     gift once or monthly, or membership dues), how much,
//                     which slate, the declaration as made, and — once
//                     Stripe answers — its session; a monthly one also its
//                     subscription and the pledge it keeps. status: open ·
//                     paid · active (a monthly gift running) · cancelled ·
//                     expired · failed.
//   stripe_payments   one per payment that landed (a one-time checkout, or
//                     one month's invoice) and the gift it became. status:
//                     paid · over_limit (it would have gone over the
//                     contribution limit: no gift, the refund is on its way)
//                     · refunded · partly_refunded · refund_failed ·
//                     disputed · dispute_lost · no_donor. acknowledged_at:
//                     a treasurer's "Got it" on one that needed them.
//   stripe_events     each Stripe event id, recorded in the same transaction
//                     as what it did — a delivery Stripe repeats does nothing.
//   stripe_held       a refund or a dispute that came before its payment was
//                     recorded (Stripe sends events in no set order): which
//                     checkout, the payment intent / charge / invoice it
//                     names, what to do, and when Stripe says it happened.
//                     Done — and gone from here — in the same write that
//                     records the payment.
//
// No card numbers, ever: Stripe's hosted page takes the card; we keep its
// ids (session, payment intent, invoice, charge, subscription).
export const sql = `
create table if not exists stripe_checkouts (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  person_id uuid references persons(id) on delete set null,
  kind text not null check (kind in ('donation', 'membership')),
  cadence text not null check (cadence in ('once', 'monthly')),
  amount_cents int not null check (amount_cents > 0),
  slate text,
  term_years smallint check (term_years in (1, 4)),
  birth_date date,
  citizenship text check (citizenship in ('citizen', 'pr')),
  declaration jsonb not null,
  metadata jsonb not null default '{}',
  mode text not null check (mode in ('live', 'test')),
  session_id text unique,
  subscription_id text,
  customer_id text,
  pledge_id uuid,
  membership_id uuid,
  status text not null default 'open' check (status in ('open', 'paid', 'active', 'cancelled', 'expired', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists stripe_checkouts_ws_idx on stripe_checkouts (workspace_id, created_at desc);
create index if not exists stripe_checkouts_sub_idx on stripe_checkouts (subscription_id) where subscription_id is not null;
create index if not exists stripe_checkouts_pledge_idx on stripe_checkouts (workspace_id, pledge_id) where pledge_id is not null;

create table if not exists stripe_payments (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  checkout_id uuid references stripe_checkouts(id) on delete set null,
  person_id uuid references persons(id) on delete set null,
  gift_id uuid,
  kind text not null check (kind in ('donation', 'membership')),
  cadence text not null check (cadence in ('once', 'monthly')),
  slate text,
  amount_cents int not null check (amount_cents >= 0),
  currency text not null default 'cad',
  paid_at timestamptz not null,
  paid_on date not null,
  session_id text,
  invoice_id text,
  subscription_id text,
  payment_intent text,
  charge_id text,
  email text,
  status text not null check (status in ('paid', 'over_limit', 'refunded', 'partly_refunded', 'refund_failed', 'disputed', 'dispute_lost', 'no_donor')),
  over_limit boolean not null default false,
  refunded_cents int not null default 0,
  refund_id text,
  refund_error text,
  dispute_id text,
  dispute_reason text,
  dispute_due_by timestamptz,
  donor_emailed_at timestamptz,
  donor_email_note text,
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists stripe_payments_session_idx on stripe_payments (workspace_id, session_id) where session_id is not null and invoice_id is null;
create unique index if not exists stripe_payments_invoice_idx on stripe_payments (workspace_id, invoice_id) where invoice_id is not null;
create index if not exists stripe_payments_ws_idx on stripe_payments (workspace_id, paid_at desc);
create index if not exists stripe_payments_pi_idx on stripe_payments (payment_intent) where payment_intent is not null;
create index if not exists stripe_payments_charge_idx on stripe_payments (charge_id) where charge_id is not null;
create index if not exists stripe_payments_gift_idx on stripe_payments (workspace_id, gift_id) where gift_id is not null;

create table if not exists stripe_events (
  id text primary key,
  workspace_id uuid references workspaces(id) on delete cascade,
  type text not null,
  received_at timestamptz not null default now()
);

create table if not exists stripe_held (
  event_id text primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  checkout_id uuid not null references stripe_checkouts(id) on delete cascade,
  kind text not null check (kind in ('refund', 'dispute')),
  payment_intent text,
  charge_id text,
  invoice_id text,
  plan jsonb not null,
  happened_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists stripe_held_ws_idx on stripe_held (workspace_id);
`;
