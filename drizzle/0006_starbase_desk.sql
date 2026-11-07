CREATE TYPE "public"."starbase_outbox_status" AS ENUM('pending', 'sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "starbase_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"person_id" uuid,
	"payload" jsonb NOT NULL,
	"status" "starbase_outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_attempt_at" timestamp with time zone,
	"starbase_person_id" text,
	"next_attempt_at" timestamp with time zone DEFAULT now(),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "starbase_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contributions" ADD COLUMN "desk_logged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contributions" ADD COLUMN "desk_logged_by" uuid;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "member_phone" text;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "interest_volunteer" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "interest_lawn_sign" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "updates_consent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "starbase_person_id" text;--> statement-breakpoint
ALTER TABLE "starbase_outbox" ADD CONSTRAINT "starbase_outbox_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "starbase_outbox_due_idx" ON "starbase_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "starbase_outbox_person_idx" ON "starbase_outbox" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "starbase_outbox_created_idx" ON "starbase_outbox" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_desk_logged_by_admin_users_id_fk" FOREIGN KEY ("desk_logged_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;