CREATE TYPE "public"."admin_role" AS ENUM('owner', 'admin', 'organizer', 'editor');--> statement-breakpoint
CREATE TYPE "public"."campaign_kind" AS ENUM('petition', 'pledge');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'sending', 'sent', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('queued', 'sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."shift_status" AS ENUM('scheduled', 'confirmed', 'attended', 'no_show', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."subscriber_status" ADD VALUE 'pending';--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "admin_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" "admin_role" DEFAULT 'editor' NOT NULL,
	"password_hash" text,
	"active" boolean DEFAULT true NOT NULL,
	"invited_by_id" uuid,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"user_email" text,
	"action" text NOT NULL,
	"entity" text,
	"entity_id" text,
	"details" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "auth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"data" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"kind" "campaign_kind" NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"statement" text DEFAULT '' NOT NULL,
	"goal" integer,
	"question" text,
	"share_text" text DEFAULT '' NOT NULL,
	"target_emails" text[] DEFAULT '{}' NOT NULL,
	"image_url" text,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaigns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "email_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject" text NOT NULL,
	"preheader" text DEFAULT '' NOT NULL,
	"body" text NOT NULL,
	"audience" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"created_by_id" uuid,
	"sent_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_campaigns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "email_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"to" text NOT NULL,
	"person_id" uuid,
	"campaign_id" uuid,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"html" text,
	"text" text,
	"status" "message_status" DEFAULT 'queued' NOT NULL,
	"provider_id" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"success" boolean DEFAULT false NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "login_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"filename" text NOT NULL,
	"url" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"alt" text DEFAULT '' NOT NULL,
	"uploaded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "person_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"author_id" uuid,
	"author_name" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "person_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "promise_follows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"promise_id" uuid NOT NULL,
	"email" text NOT NULL,
	"person_id" uuid,
	"token" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "promise_follows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "shift_openings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" date NOT NULL,
	"slot" "shift_slot" NOT NULL,
	"task_id" uuid,
	"title" text NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"neighbourhood" text,
	"capacity" integer DEFAULT 6 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"published" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shift_openings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "site_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"body" text NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"show_in_footer" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site_pages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "site_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sms_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"to" text NOT NULL,
	"person_id" uuid,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"status" "message_status" DEFAULT 'queued' NOT NULL,
	"provider_id" text,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sms_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "campaign_signatures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contributions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "event_rsvps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "news_posts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "newsletter_subscribers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "people" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recurring_donations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shifts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stripe_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tracker_announcements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tracker_promises" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tracker_updates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "volunteer_tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "campaign_signatures" ADD COLUMN "neighbourhood" text;--> statement-breakpoint
ALTER TABLE "campaign_signatures" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "contributions" ADD COLUMN "refund_pending_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "event_rsvps" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "event_rsvps" ADD COLUMN "checked_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_rsvps" ADD COLUMN "reminder_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "image_url" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "capacity" integer;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "neighbourhood" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "member_name" text;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "member_address" text;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "member_city" text;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "member_postal_code" text;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "member_neighbourhood" text;--> statement-breakpoint
ALTER TABLE "news_posts" ADD COLUMN "image_url" text;--> statement-breakpoint
ALTER TABLE "news_posts" ADD COLUMN "image_alt" text;--> statement-breakpoint
ALTER TABLE "news_posts" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "newsletter_subscribers" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "sms_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "stripe_customer_mode" text;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "tags" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "locale" text;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "referral_code" text;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "referred_by_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "image_url" text;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "opening_id" uuid;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "status" "shift_status" DEFAULT 'scheduled' NOT NULL;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "reminder_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tracker_promises" ADD COLUMN "promised_on" date;--> statement-breakpoint
ALTER TABLE "tracker_promises" ADD COLUMN "target_date" date;--> statement-breakpoint
ALTER TABLE "tracker_promises" ADD COLUMN "neighbourhoods" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_user_id_admin_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_invited_by_id_admin_users_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_admin_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_campaigns" ADD CONSTRAINT "email_campaigns_created_by_id_admin_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_campaign_id_email_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."email_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_uploaded_by_id_admin_users_id_fk" FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_notes" ADD CONSTRAINT "person_notes_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_notes" ADD CONSTRAINT "person_notes_author_id_admin_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promise_follows" ADD CONSTRAINT "promise_follows_promise_id_tracker_promises_id_fk" FOREIGN KEY ("promise_id") REFERENCES "public"."tracker_promises"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promise_follows" ADD CONSTRAINT "promise_follows_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_openings" ADD CONSTRAINT "shift_openings_task_id_volunteer_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."volunteer_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_settings" ADD CONSTRAINT "site_settings_updated_by_id_admin_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_log" ADD CONSTRAINT "sms_log_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_sessions_user_idx" ON "admin_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_email_idx" ON "admin_users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_tokens_hash_idx" ON "auth_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_tokens_email_idx" ON "auth_tokens" USING btree ("email","purpose");--> statement-breakpoint
CREATE UNIQUE INDEX "campaigns_slug_idx" ON "campaigns" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "email_log_status_idx" ON "email_log" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "email_log_campaign_idx" ON "email_log" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "email_log_to_idx" ON "email_log" USING btree ("to");--> statement-breakpoint
CREATE INDEX "login_attempts_key_idx" ON "login_attempts" USING btree ("key","at");--> statement-breakpoint
CREATE INDEX "media_created_idx" ON "media" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "person_notes_person_idx" ON "person_notes" USING btree ("person_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "promise_follows_promise_email_idx" ON "promise_follows" USING btree ("promise_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "promise_follows_token_idx" ON "promise_follows" USING btree ("token");--> statement-breakpoint
CREATE INDEX "shift_openings_date_idx" ON "shift_openings" USING btree ("date");--> statement-breakpoint
CREATE UNIQUE INDEX "site_pages_slug_idx" ON "site_pages" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "sms_log_status_idx" ON "sms_log" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_referred_by_id_people_id_fk" FOREIGN KEY ("referred_by_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_opening_id_shift_openings_id_fk" FOREIGN KEY ("opening_id") REFERENCES "public"."shift_openings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signatures_campaign_idx" ON "campaign_signatures" USING btree ("campaign","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "people_referral_code_idx" ON "people" USING btree ("referral_code");--> statement-breakpoint
CREATE INDEX "people_referred_by_idx" ON "people" USING btree ("referred_by_id");--> statement-breakpoint
CREATE INDEX "shifts_opening_idx" ON "shifts" USING btree ("opening_id");--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_amount_positive" CHECK ("contributions"."amount_cents" > 0);--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_refund_bounds" CHECK ("contributions"."refunded_cents" >= 0 and "contributions"."refunded_cents" + "contributions"."refund_pending_cents" <= "contributions"."amount_cents");