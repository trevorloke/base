CREATE TABLE "contribution_limits" (
	"year" integer PRIMARY KEY NOT NULL,
	"cents" integer NOT NULL,
	"note" text,
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contribution_limits_positive" CHECK ("contribution_limits"."cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "contribution_limits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "page_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" date NOT NULL,
	"path" text NOT NULL,
	"referrer_host" text,
	"source" text,
	"ref" text,
	"visitor_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "page_views" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "visit_salts" (
	"day" date PRIMARY KEY NOT NULL,
	"salt" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "visit_salts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "totp_secret" text;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "totp_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "recovery_codes" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "youth" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "starbase_outbox" ADD COLUMN "endpoint" text DEFAULT '/in/v1/people' NOT NULL;--> statement-breakpoint
ALTER TABLE "contribution_limits" ADD CONSTRAINT "contribution_limits_updated_by_id_admin_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_views_day_idx" ON "page_views" USING btree ("day");--> statement-breakpoint
CREATE INDEX "page_views_visitor_idx" ON "page_views" USING btree ("day","visitor_hash");