CREATE TYPE "public"."promise_status" AS ENUM('not_started', 'in_progress', 'kept', 'partly_kept', 'broken');--> statement-breakpoint
CREATE TABLE "tracker_announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" date NOT NULL,
	"date_label" text NOT NULL,
	"title" text NOT NULL,
	"commitments" text NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracker_promises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"specifics" text DEFAULT '' NOT NULL,
	"area" text NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "promise_status" DEFAULT 'not_started' NOT NULL,
	"test_kept" text,
	"test_partly" text,
	"test_broken" text,
	"test_record" text,
	"status_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracker_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"promise_id" uuid NOT NULL,
	"date" date NOT NULL,
	"status" "promise_status",
	"note" text NOT NULL,
	"url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tracker_updates" ADD CONSTRAINT "tracker_updates_promise_id_tracker_promises_id_fk" FOREIGN KEY ("promise_id") REFERENCES "public"."tracker_promises"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tracker_announcements_date_title_idx" ON "tracker_announcements" USING btree ("date","title");--> statement-breakpoint
CREATE UNIQUE INDEX "tracker_promises_number_idx" ON "tracker_promises" USING btree ("number");--> statement-breakpoint
CREATE INDEX "tracker_updates_promise_idx" ON "tracker_updates" USING btree ("promise_id","date");