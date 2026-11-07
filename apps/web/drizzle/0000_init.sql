CREATE TYPE "public"."contribution_frequency" AS ENUM('one_time', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."contribution_kind" AS ENUM('donation', 'membership_fee');--> statement-breakpoint
CREATE TYPE "public"."contribution_slate" AS ENUM('council', 'school_board');--> statement-breakpoint
CREATE TYPE "public"."contribution_status" AS ENUM('pending', 'succeeded', 'failed', 'refunded', 'refunded_over_limit');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('pending_payment', 'active', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending_payment', 'paid', 'fulfilled', 'cancelled', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."recurring_status" AS ENUM('pending', 'active', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."subscriber_status" AS ENUM('subscribed', 'unsubscribed');--> statement-breakpoint
CREATE TABLE "campaign_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign" text NOT NULL,
	"person_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text NOT NULL,
	"postal_code" text NOT NULL,
	"address" text,
	"phone" text,
	"answer" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" "contribution_kind" NOT NULL,
	"frequency" "contribution_frequency" NOT NULL,
	"slate" "contribution_slate" DEFAULT 'council' NOT NULL,
	"amount_cents" integer NOT NULL,
	"refunded_cents" integer DEFAULT 0 NOT NULL,
	"status" "contribution_status" DEFAULT 'pending' NOT NULL,
	"contributor_name" text NOT NULL,
	"contributor_address" text NOT NULL,
	"contributor_city" text NOT NULL,
	"contributor_postal_code" text NOT NULL,
	"eligibility_attested_at" timestamp with time zone NOT NULL,
	"fund" text DEFAULT 'general' NOT NULL,
	"stripe_checkout_session_id" text,
	"stripe_payment_intent_id" text,
	"stripe_invoice_id" text,
	"stripe_subscription_id" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_rsvps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"guests" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"location" text NOT NULL,
	"summary" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"published" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"status" "membership_status" DEFAULT 'pending_payment' NOT NULL,
	"fee_cents" integer NOT NULL,
	"voting_eligible" boolean NOT NULL,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"stripe_checkout_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "news_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"body" text NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "newsletter_subscribers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"person_id" uuid,
	"status" "subscriber_status" DEFAULT 'subscribed' NOT NULL,
	"source" text NOT NULL,
	"unsubscribe_token" text NOT NULL,
	"subscribed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unsubscribed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"name" text NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"quantity" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid,
	"email" text,
	"status" "order_status" DEFAULT 'pending_payment' NOT NULL,
	"total_cents" integer NOT NULL,
	"shipping" jsonb,
	"stripe_checkout_session_id" text,
	"stripe_payment_intent_id" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"phone" text,
	"address" text,
	"city" text,
	"province" text,
	"postal_code" text,
	"neighbourhood" text,
	"birthdate" date,
	"citizenship_status" text,
	"gender" text,
	"languages" text[],
	"student" boolean DEFAULT false NOT NULL,
	"campus" text,
	"issue" text,
	"interest_volunteer" boolean DEFAULT false NOT NULL,
	"interest_lawn_sign" boolean DEFAULT false NOT NULL,
	"contact_consent_at" timestamp with time zone,
	"stripe_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"price_cents" integer NOT NULL,
	"tile_label" text NOT NULL,
	"tile_background" text NOT NULL,
	"tile_foreground" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_donations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"slate_amounts" jsonb NOT NULL,
	"status" "recurring_status" DEFAULT 'pending' NOT NULL,
	"contributor_name" text NOT NULL,
	"contributor_address" text NOT NULL,
	"contributor_city" text NOT NULL,
	"contributor_postal_code" text NOT NULL,
	"eligibility_attested_at" timestamp with time zone NOT NULL,
	"stripe_checkout_session_id" text,
	"stripe_subscription_id" text,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_signatures" ADD CONSTRAINT "campaign_signatures_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_rsvps" ADD CONSTRAINT "event_rsvps_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_rsvps" ADD CONSTRAINT "event_rsvps_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_subscribers" ADD CONSTRAINT "newsletter_subscribers_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_donations" ADD CONSTRAINT "recurring_donations_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "signatures_campaign_email_idx" ON "campaign_signatures" USING btree ("campaign","email");--> statement-breakpoint
CREATE INDEX "contributions_person_idx" ON "contributions" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "contributions_checkout_idx" ON "contributions" USING btree ("stripe_checkout_session_id");--> statement-breakpoint
CREATE INDEX "contributions_payment_intent_idx" ON "contributions" USING btree ("stripe_payment_intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contributions_invoice_slate_idx" ON "contributions" USING btree ("stripe_invoice_id","slate");--> statement-breakpoint
CREATE UNIQUE INDEX "rsvps_event_email_idx" ON "event_rsvps" USING btree ("event_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "events_slug_idx" ON "events" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "events_starts_idx" ON "events" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "memberships_person_idx" ON "memberships" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_checkout_idx" ON "memberships" USING btree ("stripe_checkout_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "news_slug_idx" ON "news_posts" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "newsletter_email_idx" ON "newsletter_subscribers" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "newsletter_token_idx" ON "newsletter_subscribers" USING btree ("unsubscribe_token");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_checkout_idx" ON "orders" USING btree ("stripe_checkout_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "people_email_idx" ON "people" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "products_slug_idx" ON "products" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_checkout_idx" ON "recurring_donations" USING btree ("stripe_checkout_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_subscription_idx" ON "recurring_donations" USING btree ("stripe_subscription_id");