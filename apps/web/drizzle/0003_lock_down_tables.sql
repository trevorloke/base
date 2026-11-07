-- Turn on row-level security for every table the website owns.
--
-- On Supabase, any table in the public schema without row-level security can
-- be read and written through the project's public API key. With it on and no
-- policies, only the table owner (the role the website connects as) can reach
-- these rows. To let a staff app read them, add policies; see SETUP.md.
--
-- Only the website's own tables are listed, so tables belonging to another
-- app in the same database are left exactly as they are.
ALTER TABLE "people" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contributions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recurring_donations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "newsletter_subscribers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "campaign_signatures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "news_posts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "event_rsvps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stripe_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "volunteer_tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shifts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tracker_promises" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tracker_updates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tracker_announcements" ENABLE ROW LEVEL SECURITY;
