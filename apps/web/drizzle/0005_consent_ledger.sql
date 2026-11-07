CREATE TABLE "consent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid,
	"email" text NOT NULL,
	"channel" text NOT NULL,
	"purpose" text NOT NULL,
	"action" text NOT NULL,
	"basis" text DEFAULT 'express' NOT NULL,
	"wording" text,
	"source" text,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consent_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consent_events_person_idx" ON "consent_events" USING btree ("person_id","created_at");--> statement-breakpoint
CREATE INDEX "consent_events_email_idx" ON "consent_events" USING btree ("email","created_at");