CREATE TYPE "public"."shift_slot" AS ENUM('morning', 'afternoon', 'evening');--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"date" date NOT NULL,
	"slot" "shift_slot" NOT NULL,
	"task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "volunteer_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_task_id_volunteer_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."volunteer_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shifts_person_slot_idx" ON "shifts" USING btree ("person_id","date","slot");--> statement-breakpoint
CREATE INDEX "shifts_date_idx" ON "shifts" USING btree ("date");--> statement-breakpoint
CREATE UNIQUE INDEX "volunteer_tasks_name_idx" ON "volunteer_tasks" USING btree ("name");