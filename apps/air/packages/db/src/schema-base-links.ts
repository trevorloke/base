import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./schema.ts";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/**
 * Who a Base Ground person is in Base Air (migration 0015_base_links.sql). One link per (client, sub) and one per
 * user. Made once, with the account's own password; the email Base Ground sends is never matched on afterwards.
 */
export const baseLinks = pgTable(
  "base_links",
  {
    id: text("id").primaryKey(),
    client: text("client").notNull(),
    sub: text("sub").notNull(),
    userId: text("user_id").notNull().references(() => users.id),
    groundEmail: text("ground_email"),
    linkedAt: ts("linked_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("base_links_client_sub").on(t.client, t.sub), uniqueIndex("base_links_user").on(t.userId)],
);

/** A verified hand-off waiting for the account's password: ten minutes, single use, only the token's sha256 stored. */
export const baseLinkPending = pgTable(
  "base_link_pending",
  {
    id: text("id").primaryKey(),
    client: text("client").notNull(),
    sub: text("sub").notNull(),
    groundEmail: text("ground_email").notNull(),
    userId: text("user_id").notNull().references(() => users.id),
    next: text("next").notNull(),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("base_link_pending_expires").on(t.expiresAt)],
);
