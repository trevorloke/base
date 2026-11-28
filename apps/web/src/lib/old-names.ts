// The website's older names. Kept only so what is already saved keeps working:
// its settings on the host, its database, and values stored in rows. Nothing
// new is ever written under them. This file holds names only and imports nothing.

// new name -> older name: the website's three settings for base.win (the desk).
export const OLD_ENV = { BASE_WIN_URL: "STARBASE_URL", BASE_WIN_KEY: "STARBASE_KEY", BASE_WIN_INBOUND_KEY: "STARBASE_INBOUND_KEY" } as const;

// The website's database names: unchanged, because the live website runs on the same database.
export const DB = {
  outbox: "starbase_outbox",
  outboxStatus: "starbase_outbox_status",
  personId: "starbase_person_id",
  outboxIdx: { due: "starbase_outbox_due_idx", person: "starbase_outbox_person_idx", created: "starbase_outbox_created_idx" },
} as const;

// Values stored in rows: still matched, never rewritten.
export const OLD_INBOUND_ENTITY = "starbase-consent"; // replay lookups match both this and "desk-consent"; the lock key keeps it
export const OLD_LEDGER_SOURCE = "starbase"; // filters accept both; labels show "base.win"
export const OLD_AUDIT_ACTIONS = [
  "consent.starbase-withdraw",
  "consent.starbase-grant-ignored",
  "integrations.starbase-test",
  "integrations.starbase-send",
  "integrations.starbase-retry",
  "integrations.starbase-skip",
] as const;
// Older words in stored text (an outbox row's last error, a ledger row's wording): shown as "base.win".
export const OLD_WORD = "starbase";

export const OLD_ADMIN_PATH = "/admin/integrations/starbase"; // redirects to /admin/integrations/desk
