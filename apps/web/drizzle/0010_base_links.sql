CREATE TABLE "base_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client" text NOT NULL,
	"sub" text NOT NULL,
	"user_id" uuid NOT NULL,
	"ground_email" text,
	"linked_via" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "base_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "base_links" ADD CONSTRAINT "base_links_user_id_admin_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "base_links_client_sub_idx" ON "base_links" USING btree ("client","sub");--> statement-breakpoint
CREATE UNIQUE INDEX "base_links_user_idx" ON "base_links" USING btree ("user_id");