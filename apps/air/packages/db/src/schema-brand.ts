import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { workspaces, type ActorJson } from "./schema.ts";

/** The look a workspace chose on the Brand page (migration 0014_workspace_brand.sql). */
export const workspaceBrand = pgTable("workspace_brand", {
  workspaceId: text("workspace_id").primaryKey().references(() => workspaces.id),
  preset: text("preset").notNull(),
  /** A Brand from @base-air/look, minus `preset`; validated before it is written. */
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull(),
  updatedBy: jsonb("updated_by").$type<ActorJson>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});
