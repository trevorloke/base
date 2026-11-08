CREATE TABLE "site_brand" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_brand_one_row" CHECK ("site_brand"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "site_brand" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "site_brand" ADD CONSTRAINT "site_brand_updated_by_id_admin_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;