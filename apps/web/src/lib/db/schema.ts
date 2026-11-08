import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// ── People ────────────────────────────────────────────────────────────────
// One row per email address. Members, donors, petition signers, newsletter
// subscribers and shoppers all resolve to a person so the organization has a
// single view of each supporter.
export const people = pgTable(
  "people",
  {
    id: id(),
    email: text("email").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    phone: text("phone"),
    address: text("address"),
    city: text("city"),
    province: text("province"),
    postalCode: text("postal_code"),
    neighbourhood: text("neighbourhood"),
    birthdate: date("birthdate"),
    citizenshipStatus: text("citizenship_status"),
    gender: text("gender"),
    languages: text("languages").array(),
    student: boolean("student").notNull().default(false),
    campus: text("campus"),
    issue: text("issue"),
    interestVolunteer: boolean("interest_volunteer").notNull().default(false),
    interestLawnSign: boolean("interest_lawn_sign").notNull().default(false),
    contactConsentAt: timestamp("contact_consent_at", { withTimezone: true }),
    // Express consent to text messages (CASL): set only by the person's own tick.
    smsConsentAt: timestamp("sms_consent_at", { withTimezone: true }),
    stripeCustomerId: text("stripe_customer_id"),
    // "test" or "live": a customer id from the other Stripe mode is never reused.
    stripeCustomerMode: text("stripe_customer_mode"),
    // Where this person first came from: membership, donation, petition:…, event:…
    source: text("source"),
    tags: text("tags").array().notNull().default([]),
    // Preferred language for emails and texts (en, pa, hi, zh-Hans, zh-Hant, tl).
    locale: text("locale"),
    // Relational organizing: the share code this person hands out, and who brought them in.
    referralCode: text("referral_code"),
    referredById: uuid("referred_by_id").references((): AnyPgColumn => people.id, { onDelete: "set null" }),
    // The id the campaign's database (Base Ground, "the desk") answered for this
    // person, so staff can find the same supporter there.
    baseGroundPersonId: text("base_ground_person_id"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("people_email_idx").on(t.email), uniqueIndex("people_referral_code_idx").on(t.referralCode), index("people_referred_by_idx").on(t.referredById)],
).enableRLS();

// ── Memberships ───────────────────────────────────────────────────────────
export const membershipStatus = pgEnum("membership_status", [
  "pending_payment",
  "active",
  "expired",
  "cancelled",
]);

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    status: membershipStatus("status").notNull().default("pending_payment"),
    feeCents: integer("fee_cents").notNull(),
    // Membership is by donation; youth members (14 to 30 on the day they join) have a lower minimum.
    youth: boolean("youth").notNull().default(false),
    // Outside-Surrey members can join but don't vote at member meetings.
    votingEligible: boolean("voting_eligible").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // The member's details as given when they joined. Public forms never
    // overwrite these; the voting roll is built from them.
    memberName: text("member_name"),
    memberAddress: text("member_address"),
    memberCity: text("member_city"),
    memberPostalCode: text("member_postal_code"),
    memberNeighbourhood: text("member_neighbourhood"),
    memberPhone: text("member_phone"),
    // The form's own ticks, kept with the membership so what is forwarded to
    // the desk when it becomes active is what was asked on this form.
    interestVolunteer: boolean("interest_volunteer").notNull().default(false),
    interestLawnSign: boolean("interest_lawn_sign").notNull().default(false),
    // True only when the email-updates tick was recorded in the consent ledger.
    updatesConsent: boolean("updates_consent").notNull().default(false),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("memberships_person_idx").on(t.personId),
    uniqueIndex("memberships_checkout_idx").on(t.stripeCheckoutSessionId),
  ],
).enableRLS();

// ── Contributions ─────────────────────────────────────────────────────────
// Every dollar received, including membership fees, which count as
// contributions under BC's Local Elections Campaign Financing Act. Each row
// snapshots the contributor's name and address as given at the time, which is
// what disclosure reports need.
export const contributionKind = pgEnum("contribution_kind", ["donation", "membership_fee"]);
export const contributionFrequency = pgEnum("contribution_frequency", ["one_time", "monthly"]);
// Council and school board slates are separate campaigns with separate limits.
export const contributionSlate = pgEnum("contribution_slate", ["council", "school_board"]);
export const contributionStatus = pgEnum("contribution_status", [
  "pending",
  "succeeded",
  "failed",
  "refunded",
  "refunded_over_limit",
]);

export const contributions = pgTable(
  "contributions",
  {
    id: id(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    kind: contributionKind("kind").notNull(),
    frequency: contributionFrequency("frequency").notNull(),
    slate: contributionSlate("slate").notNull().default("council"),
    amountCents: integer("amount_cents").notNull(),
    // Returned to the contributor, e.g. the part of a payment over the annual limit.
    refundedCents: integer("refunded_cents").notNull().default(0),
    // Decided inside the webhook transaction, issued to Stripe after it commits.
    refundPendingCents: integer("refund_pending_cents").notNull().default(0),
    status: contributionStatus("status").notNull().default("pending"),
    contributorName: text("contributor_name").notNull(),
    contributorAddress: text("contributor_address").notNull(),
    contributorCity: text("contributor_city").notNull(),
    contributorPostalCode: text("contributor_postal_code").notNull(),
    eligibilityAttestedAt: timestamp("eligibility_attested_at", { withTimezone: true }).notNull(),
    // Monthly gifts support the Imagine Victory Fund.
    fund: text("fund").notNull().default("general"),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    stripeInvoiceId: text("stripe_invoice_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    // When the treasurer logged this gift at the desk (Base Ground → Donations →
    // Log a gift), where the contribution limits are checked. Online gifts are
    // never sent to Base Ground automatically.
    deskLoggedAt: timestamp("desk_logged_at", { withTimezone: true }),
    deskLoggedById: uuid("desk_logged_by").references((): AnyPgColumn => adminUsers.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("contributions_person_idx").on(t.personId),
    index("contributions_checkout_idx").on(t.stripeCheckoutSessionId),
    index("contributions_payment_intent_idx").on(t.stripePaymentIntentId),
    // One row per slate per invoice: a Superstar monthly payment is two rows.
    uniqueIndex("contributions_invoice_slate_idx").on(t.stripeInvoiceId, t.slate),
    check("contributions_amount_positive", sql`${t.amountCents} > 0`),
    check("contributions_refund_bounds", sql`${t.refundedCents} >= 0 and ${t.refundedCents} + ${t.refundPendingCents} <= ${t.amountCents}`),
  ],
).enableRLS();

// ── Recurring donations ───────────────────────────────────────────────────
export const recurringStatus = pgEnum("recurring_status", ["pending", "active", "cancelled"]);

export const recurringDonations = pgTable(
  "recurring_donations",
  {
    id: id(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    // Per month, per slate, keyed by slate name: {"council": 11900}.
    slateAmounts: jsonb("slate_amounts").$type<Partial<Record<"council" | "school_board", number>>>().notNull(),
    status: recurringStatus("status").notNull().default("pending"),
    contributorName: text("contributor_name").notNull(),
    contributorAddress: text("contributor_address").notNull(),
    contributorCity: text("contributor_city").notNull(),
    contributorPostalCode: text("contributor_postal_code").notNull(),
    eligibilityAttestedAt: timestamp("eligibility_attested_at", { withTimezone: true }).notNull(),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("recurring_checkout_idx").on(t.stripeCheckoutSessionId),
    uniqueIndex("recurring_subscription_idx").on(t.stripeSubscriptionId),
  ],
).enableRLS();

// ── Newsletter ────────────────────────────────────────────────────────────
// "pending" is a double opt-in waiting for the confirmation click.
export const subscriberStatus = pgEnum("subscriber_status", ["subscribed", "unsubscribed", "pending"]);

export const newsletterSubscribers = pgTable(
  "newsletter_subscribers",
  {
    id: id(),
    email: text("email").notNull(),
    personId: uuid("person_id").references(() => people.id),
    status: subscriberStatus("status").notNull().default("subscribed"),
    source: text("source").notNull(),
    unsubscribeToken: text("unsubscribe_token").notNull(),
    subscribedAt: timestamp("subscribed_at", { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("newsletter_email_idx").on(t.email),
    uniqueIndex("newsletter_token_idx").on(t.unsubscribeToken),
  ],
).enableRLS();

// ── Petitions and pledges ─────────────────────────────────────────────────
export const campaignSignatures = pgTable(
  "campaign_signatures",
  {
    id: id(),
    campaign: text("campaign").notNull(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    email: text("email").notNull(),
    postalCode: text("postal_code").notNull(),
    address: text("address"),
    phone: text("phone"),
    answer: text("answer"),
    // Town centre derived from the postal code, for counters by neighbourhood.
    neighbourhood: text("neighbourhood"),
    source: text("source"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("signatures_campaign_email_idx").on(t.campaign, t.email), index("signatures_campaign_idx").on(t.campaign, t.createdAt)],
).enableRLS();

// Petitions and pledges are defined here, so organizers can launch a new one
// from the admin. `slug` is what campaign_signatures.campaign stores.
export const campaignKind = pgEnum("campaign_kind", ["petition", "pledge"]);

export const campaigns = pgTable(
  "campaigns",
  {
    id: id(),
    slug: text("slug").notNull(),
    kind: campaignKind("kind").notNull(),
    title: text("title").notNull(),
    // Shown above the form; the pledge wording or the petition ask. Markdown.
    body: text("body").notNull().default(""),
    // The text people are asked to sign.
    statement: text("statement").notNull().default(""),
    goal: integer("goal"),
    // The optional free-text question on the form, e.g. "Where should the line end?"
    question: text("question"),
    shareText: text("share_text").notNull().default(""),
    // Who the "email council" action goes to, when set.
    targetEmails: text("target_emails").array().notNull().default([]),
    imageUrl: text("image_url"),
    active: boolean("active").notNull().default(true),
    // Seeded campaigns are wired into the home page; others get their own page at /act/<slug>.
    sortOrder: integer("sort_order").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("campaigns_slug_idx").on(t.slug)],
).enableRLS();

// ── News and events ───────────────────────────────────────────────────────
export const newsPosts = pgTable(
  "news_posts",
  {
    id: id(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    // Markdown.
    body: text("body").notNull(),
    imageUrl: text("image_url"),
    imageAlt: text("image_alt"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("news_slug_idx").on(t.slug)],
).enableRLS();

export const events = pgTable(
  "events",
  {
    id: id(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    location: text("location").notNull(),
    // A street address for maps and calendar files; location is the venue name.
    address: text("address"),
    summary: text("summary").notNull(),
    // Markdown.
    description: text("description").notNull().default(""),
    imageUrl: text("image_url"),
    capacity: integer("capacity"),
    // Which town centre it is in, for "near you" pages; null for city-wide.
    neighbourhood: text("neighbourhood"),
    published: boolean("published").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("events_slug_idx").on(t.slug), index("events_starts_idx").on(t.startsAt)],
).enableRLS();

export const eventRsvps = pgTable(
  "event_rsvps",
  {
    id: id(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    name: text("name").notNull(),
    email: text("email").notNull(),
    guests: integer("guests").notNull().default(0),
    // Where the sign-up came from (?source=, a referral, an email campaign).
    source: text("source"),
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
    reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("rsvps_event_email_idx").on(t.eventId, t.email)],
).enableRLS();

// ── Shop ──────────────────────────────────────────────────────────────────
export const products = pgTable(
  "products",
  {
    id: id(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    priceCents: integer("price_cents").notNull(),
    // The text and colours of the product tile.
    tileLabel: text("tile_label").notNull(),
    tileBackground: text("tile_background").notNull(),
    tileForeground: text("tile_foreground").notNull(),
    // A photo replaces the coloured tile when set.
    imageUrl: text("image_url"),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [uniqueIndex("products_slug_idx").on(t.slug)],
).enableRLS();

export const orderStatus = pgEnum("order_status", ["pending_payment", "paid", "fulfilled", "cancelled", "refunded"]);

export const orders = pgTable(
  "orders",
  {
    id: id(),
    personId: uuid("person_id").references(() => people.id),
    email: text("email"),
    status: orderStatus("status").notNull().default("pending_payment"),
    totalCents: integer("total_cents").notNull(),
    shipping: jsonb("shipping"),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("orders_checkout_idx").on(t.stripeCheckoutSessionId)],
).enableRLS();

export const orderItems = pgTable("order_items", {
  id: id(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id),
  name: text("name").notNull(),
  unitPriceCents: integer("unit_price_cents").notNull(),
  quantity: integer("quantity").notNull(),
}).enableRLS();

// ── Stripe webhook idempotency ────────────────────────────────────────────
export const stripeEvents = pgTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

// ── Volunteer shifts ──────────────────────────────────────────────────────
// What a volunteer is doing on a shift. The colour codes it on the calendar.
export const volunteerTasks = pgTable(
  "volunteer_tasks",
  {
    id: id(),
    name: text("name").notNull(),
    color: text("color").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("volunteer_tasks_name_idx").on(t.name)],
).enableRLS();

export const shiftSlot = pgEnum("shift_slot", ["morning", "afternoon", "evening"]);
export const shiftStatus = pgEnum("shift_status", ["scheduled", "confirmed", "attended", "no_show", "cancelled"]);

// A published slot volunteers can sign themselves up for: "Door-knocking in
// Newton, Saturday morning, 6 spots".
export const shiftOpenings = pgTable(
  "shift_openings",
  {
    id: id(),
    date: date("date").notNull(),
    slot: shiftSlot("slot").notNull(),
    taskId: uuid("task_id").references(() => volunteerTasks.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    location: text("location").notNull().default(""),
    neighbourhood: text("neighbourhood"),
    capacity: integer("capacity").notNull().default(6),
    notes: text("notes").notNull().default(""),
    published: boolean("published").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("shift_openings_date_idx").on(t.date)],
).enableRLS();

export const shifts = pgTable(
  "shifts",
  {
    id: id(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    slot: shiftSlot("slot").notNull(),
    // Deleting a task leaves its shifts in place, uncoloured.
    taskId: uuid("task_id").references(() => volunteerTasks.id, { onDelete: "set null" }),
    // Set when the volunteer signed up through a public opening.
    openingId: uuid("opening_id").references(() => shiftOpenings.id, { onDelete: "set null" }),
    status: shiftStatus("status").notNull().default("scheduled"),
    reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("shifts_person_slot_idx").on(t.personId, t.date, t.slot), index("shifts_date_idx").on(t.date), index("shifts_opening_idx").on(t.openingId)],
).enableRLS();

// ── Promise tracker ───────────────────────────────────────────────────────
// Safe Surrey Coalition's 2026 promises, scored against delivery in public.
export const promiseStatus = pgEnum("promise_status", ["not_started", "in_progress", "kept", "partly_kept", "broken"]);

export type TrackerSource = { label: string; url?: string };

export const trackerPromises = pgTable(
  "tracker_promises",
  {
    id: id(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    specifics: text("specifics").notNull().default(""),
    area: text("area").notNull(),
    sources: jsonb("sources").$type<TrackerSource[]>().notNull().default([]),
    status: promiseStatus("status").notNull().default("not_started"),
    // The delivery test: what counts as kept, partly kept or broken.
    testKept: text("test_kept"),
    testPartly: text("test_partly"),
    testBroken: text("test_broken"),
    testRecord: text("test_record"),
    // When the promise was made and when the party said it would be done.
    promisedOn: date("promised_on"),
    targetDate: date("target_date"),
    // Town centres the promise affects, for neighbourhood pages.
    neighbourhoods: text("neighbourhoods").array().notNull().default([]),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("tracker_promises_number_idx").on(t.number)],
).enableRLS();

// People who asked to be told when a promise's status changes.
export const promiseFollows = pgTable(
  "promise_follows",
  {
    id: id(),
    promiseId: uuid("promise_id")
      .notNull()
      .references(() => trackerPromises.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    personId: uuid("person_id").references(() => people.id, { onDelete: "set null" }),
    // Unsubscribe link token.
    token: text("token").notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("promise_follows_promise_email_idx").on(t.promiseId, t.email), uniqueIndex("promise_follows_token_idx").on(t.token)],
).enableRLS();

// The record behind each score: what happened, when, and where to check it.
export const trackerUpdates = pgTable(
  "tracker_updates",
  {
    id: id(),
    promiseId: uuid("promise_id")
      .notNull()
      .references(() => trackerPromises.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    // The status this update set, if it changed it.
    status: promiseStatus("status"),
    note: text("note").notNull(),
    url: text("url"),
    createdAt: createdAt(),
  },
  (t) => [index("tracker_updates_promise_idx").on(t.promiseId, t.date)],
).enableRLS();

export const trackerAnnouncements = pgTable(
  "tracker_announcements",
  {
    id: id(),
    date: date("date").notNull(),
    // How the date reads, e.g. "July 28 to 29, 2026".
    dateLabel: text("date_label").notNull(),
    title: text("title").notNull(),
    commitments: text("commitments").notNull(),
    sources: jsonb("sources").$type<TrackerSource[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("tracker_announcements_date_title_idx").on(t.date, t.title)],
).enableRLS();

// ── Admin accounts ────────────────────────────────────────────────────────
// Each staff member has their own account and role. Sessions live in the
// database so signing out, or deactivating an account, takes effect at once.
export const adminRole = pgEnum("admin_role", ["owner", "admin", "organizer", "editor"]);

export const adminUsers = pgTable(
  "admin_users",
  {
    id: id(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    role: adminRole("role").notNull().default("editor"),
    // scrypt hash; null until the person sets a password (they can sign in by email link).
    passwordHash: text("password_hash"),
    active: boolean("active").notNull().default(true),
    invitedById: uuid("invited_by_id").references((): AnyPgColumn => adminUsers.id, { onDelete: "set null" }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    // Two-factor sign-in (authenticator app). The secret is encrypted with a
    // key derived from ADMIN_SESSION_SECRET; recovery codes are stored hashed.
    totpSecret: text("totp_secret"),
    totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true }),
    recoveryCodes: text("recovery_codes").array().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("admin_users_email_idx").on(t.email)],
).enableRLS();

export const adminSessions = pgTable(
  "admin_sessions",
  {
    // A random 256-bit id; the cookie carries it with a signature.
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("admin_sessions_user_idx").on(t.userId)],
).enableRLS();

// Failed sign-ins, keyed by IP address and by email, so lockouts hold across
// every server instance.
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: id(),
    key: text("key").notNull(),
    success: boolean("success").notNull().default(false),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("login_attempts_key_idx").on(t.key, t.at)],
).enableRLS();

// "Sign in with Base" links (SUITE.md, "The hand-off", step 6): a Base Ground
// login (the client's slug + Base Ground's stable `sub`) tied to one staff
// account here. Made once, after the person proves the account is theirs
// with its password or an emailed link; the email Base Ground sends is never
// enough by itself. One link per Base Ground login and one per staff account.
export const baseLinks = pgTable(
  "base_links",
  {
    id: id(),
    client: text("client").notNull(),
    sub: text("sub").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    // The Base Ground email at the time of linking, for the Staff page only;
    // sign-in never looks at it.
    groundEmail: text("ground_email"),
    // How the person proved the account was theirs: "password" or "email-link".
    linkedVia: text("linked_via").notNull(),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("base_links_client_sub_idx").on(t.client, t.sub), uniqueIndex("base_links_user_idx").on(t.userId)],
).enableRLS();

// Who changed what in the admin.
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    userId: uuid("user_id").references(() => adminUsers.id, { onDelete: "set null" }),
    userEmail: text("user_email"),
    action: text("action").notNull(),
    entity: text("entity"),
    entityId: text("entity_id"),
    details: jsonb("details"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_at_idx").on(t.at), index("audit_log_entity_idx").on(t.entity, t.entityId)],
).enableRLS();

// ── One-time links ────────────────────────────────────────────────────────
// Sign-in links for staff and members, newsletter confirmations, membership
// confirmations. Only a hash of the token is stored.
export const authTokens = pgTable(
  "auth_tokens",
  {
    id: id(),
    purpose: text("purpose").notNull(),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull(),
    data: jsonb("data"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("auth_tokens_hash_idx").on(t.tokenHash), index("auth_tokens_email_idx").on(t.email, t.purpose)],
).enableRLS();

// ── Site content ──────────────────────────────────────────────────────────
// Editable copy and structured content for the public site, one row per
// section (hero, pillars, board, …), validated by the schemas in
// src/lib/settings.ts. The code ships defaults; this table holds overrides.
export const siteSettings = pgTable("site_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedById: uuid("updated_by_id").references(() => adminUsers.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

// The site's look (Admin → Brand): one row, the brand as src/lib/brand.ts
// defines it. With no row, the preset from BASE_WEB_BRAND_PRESET or the
// client's seed applies.
export const siteBrand = pgTable(
  "site_brand",
  {
    id: integer("id").primaryKey().default(1),
    value: jsonb("value").notNull(),
    updatedById: uuid("updated_by_id").references(() => adminUsers.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("site_brand_one_row", sql`${t.id} = 1`)],
).enableRLS();

// Free-form pages such as the privacy policy, served at /<slug>.
export const sitePages = pgTable(
  "site_pages",
  {
    id: id(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    // Markdown.
    body: text("body").notNull(),
    published: boolean("published").notNull().default(false),
    showInFooter: boolean("show_in_footer").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("site_pages_slug_idx").on(t.slug)],
).enableRLS();

// Uploaded images and files.
export const media = pgTable(
  "media",
  {
    id: id(),
    filename: text("filename").notNull(),
    url: text("url").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    width: integer("width"),
    height: integer("height"),
    alt: text("alt").notNull().default(""),
    uploadedById: uuid("uploaded_by_id").references(() => adminUsers.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("media_created_idx").on(t.createdAt)],
).enableRLS();

// Staff notes on a supporter.
export const personNotes = pgTable(
  "person_notes",
  {
    id: id(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    authorId: uuid("author_id").references(() => adminUsers.id, { onDelete: "set null" }),
    authorName: text("author_name"),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("person_notes_person_idx").on(t.personId, t.createdAt)],
).enableRLS();

// ── Email and SMS ─────────────────────────────────────────────────────────
export const messageStatus = pgEnum("message_status", ["queued", "sent", "failed", "skipped"]);
export const campaignStatus = pgEnum("campaign_status", ["draft", "sending", "sent", "cancelled"]);

// A newsletter or broadcast, written in the admin and sent to an audience.
export const emailCampaigns = pgTable("email_campaigns", {
  id: id(),
  subject: text("subject").notNull(),
  preheader: text("preheader").notNull().default(""),
  // Markdown.
  body: text("body").notNull(),
  // Who receives it, e.g. {"list":"newsletter"} or {"list":"members","neighbourhood":"Newton"}.
  audience: jsonb("audience").$type<Record<string, unknown>>().notNull().default({}),
  status: campaignStatus("status").notNull().default("draft"),
  recipientCount: integer("recipient_count").notNull().default(0),
  sentCount: integer("sent_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  createdById: uuid("created_by_id").references(() => adminUsers.id, { onDelete: "set null" }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
}).enableRLS();

// Every email the site sends: transactional (kind = "welcome", "rsvp", …) and
// campaign (campaignId set). Queued rows are sent by the cron job in batches.
export const emailLog = pgTable(
  "email_log",
  {
    id: id(),
    to: text("to").notNull(),
    personId: uuid("person_id").references(() => people.id, { onDelete: "set null" }),
    campaignId: uuid("campaign_id").references(() => emailCampaigns.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    subject: text("subject").notNull(),
    html: text("html"),
    text: text("text"),
    status: messageStatus("status").notNull().default("queued"),
    providerId: text("provider_id"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("email_log_status_idx").on(t.status, t.createdAt), index("email_log_campaign_idx").on(t.campaignId), index("email_log_to_idx").on(t.to)],
).enableRLS();

export const smsLog = pgTable(
  "sms_log",
  {
    id: id(),
    to: text("to").notNull(),
    personId: uuid("person_id").references(() => people.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    body: text("body").notNull(),
    status: messageStatus("status").notNull().default("queued"),
    providerId: text("provider_id"),
    error: text("error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("sms_log_status_idx").on(t.status, t.createdAt)],
).enableRLS();

// ── Consent ledger ────────────────────────────────────────────────────────
// Append-only proof of consent for CASL and BC PIPA: one row every time a
// person grants or withdraws permission for a channel and purpose, with the
// wording they saw. people.contactConsentAt and people.smsConsentAt stay as
// the current state; this table is the evidence behind them.
export const consentEvents = pgTable(
  "consent_events",
  {
    id: id(),
    personId: uuid("person_id").references(() => people.id, { onDelete: "set null" }),
    email: text("email").notNull(),
    // email | sms
    channel: text("channel").notNull(),
    // newsletter | updates | sms | fundraising | volunteer
    purpose: text("purpose").notNull(),
    // grant | withdraw
    action: text("action").notNull(),
    // express | implied-member | implied-donor | implied-volunteer
    basis: text("basis").notNull().default("express"),
    // The exact checkbox or confirmation wording the person saw.
    wording: text("wording"),
    // Which form or process recorded it: membership-form, petition:<slug>, preferences, sms-stop, …
    source: text("source"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("consent_events_person_idx").on(t.personId, t.createdAt), index("consent_events_email_idx").on(t.email, t.createdAt)],
).enableRLS();

// ── Base Ground ("the desk") ─────────────────────────────────────────────────
// Sign-ups the website forwards to the campaign's database. Public routes
// only write a row here; delivery happens after the response (and from the
// daily job), so Base Ground being slow or down never touches a visitor's form.
// The row id is the Idempotency-Key, so a retry never makes a second person.
// Money, RSVPs, orders and follows are never written here.
export const baseGroundOutboxStatus = pgEnum("base_ground_outbox_status", ["pending", "sent", "failed", "skipped"]);

export const baseGroundOutbox = pgTable(
  "base_ground_outbox",
  {
    id: id(),
    // petition | pledge | newsletter | volunteer-shift | membership | deletion-request
    kind: text("kind").notNull(),
    personId: uuid("person_id").references(() => people.id, { onDelete: "set null" }),
    // Which Base Ground endpoint the row goes to, and the exact body sent there.
    endpoint: text("endpoint").notNull().default("/in/v1/people"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: baseGroundOutboxStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    baseGroundPersonId: text("base_ground_person_id"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow(),
    createdAt: createdAt(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    index("base_ground_outbox_due_idx").on(t.status, t.nextAttemptAt),
    index("base_ground_outbox_person_idx").on(t.personId),
    index("base_ground_outbox_created_idx").on(t.createdAt),
  ],
).enableRLS();

// ── Contribution limits by year ─────────────────────────────────────────────
// Elections BC indexes the annual limit every January. A row per year means
// the new figure can be entered as soon as it is published and takes effect
// on January 1 (Pacific) by itself. CONTRIBUTION_LIMIT_CENTS is the fallback
// for a year with no row.
export const contributionLimits = pgTable("contribution_limits", {
  year: integer("year").primaryKey(),
  cents: integer("cents").notNull(),
  note: text("note"),
  updatedById: uuid("updated_by_id").references(() => adminUsers.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check("contribution_limits_positive", sql`${t.cents} > 0`)]).enableRLS();

// ── Website visits (first-party, cookieless) ────────────────────────────────
// One row per page view: the path, the referring site, the ?source / ?ref
// the site already tracks, and a visitor hash that changes every day. No IP
// address, user agent or cookie is stored, so it needs no consent banner.
export const pageViews = pgTable(
  "page_views",
  {
    id: id(),
    day: date("day").notNull(),
    path: text("path").notNull(),
    referrerHost: text("referrer_host"),
    source: text("source"),
    ref: text("ref"),
    visitorHash: text("visitor_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("page_views_day_idx").on(t.day), index("page_views_visitor_idx").on(t.day, t.visitorHash)],
).enableRLS();

// The random salt for each day's visitor hash; old salts are deleted, so a
// past day's hashes can never be recomputed from an IP address.
export const visitSalts = pgTable("visit_salts", {
  day: date("day").primaryKey(),
  salt: text("salt").notNull(),
}).enableRLS();

