-- The campaign's database app, Starbase, is now base ground (part of base).
-- Rename what was named after it, keeping every row.
ALTER TYPE "public"."starbase_outbox_status" RENAME TO "base_ground_outbox_status";--> statement-breakpoint
ALTER TABLE "starbase_outbox" RENAME TO "base_ground_outbox";--> statement-breakpoint
ALTER TABLE "base_ground_outbox" RENAME COLUMN "starbase_person_id" TO "base_ground_person_id";--> statement-breakpoint
ALTER TABLE "people" RENAME COLUMN "starbase_person_id" TO "base_ground_person_id";--> statement-breakpoint
ALTER TABLE "base_ground_outbox" RENAME CONSTRAINT "starbase_outbox_pkey" TO "base_ground_outbox_pkey";--> statement-breakpoint
ALTER TABLE "base_ground_outbox" RENAME CONSTRAINT "starbase_outbox_person_id_people_id_fk" TO "base_ground_outbox_person_id_people_id_fk";--> statement-breakpoint
ALTER INDEX "starbase_outbox_due_idx" RENAME TO "base_ground_outbox_due_idx";--> statement-breakpoint
ALTER INDEX "starbase_outbox_person_idx" RENAME TO "base_ground_outbox_person_idx";--> statement-breakpoint
ALTER INDEX "starbase_outbox_created_idx" RENAME TO "base_ground_outbox_created_idx";--> statement-breakpoint
ALTER TABLE "base_ground_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Stored names: consent withdrawals received from it, and the audit entries
-- (the inbound endpoint's idempotency keys live under the entity name).
UPDATE "consent_events" SET "source" = 'base-ground' WHERE "source" = 'starbase';--> statement-breakpoint
UPDATE "audit_log" SET "entity" = 'base-ground-consent' WHERE "entity" = 'starbase-consent';--> statement-breakpoint
UPDATE "audit_log" SET "action" = replace("action", 'starbase-', 'base-ground-') WHERE "action" IN ('integrations.starbase-test', 'integrations.starbase-send', 'integrations.starbase-retry', 'integrations.starbase-skip', 'consent.starbase-withdraw', 'consent.starbase-grant-ignored');
