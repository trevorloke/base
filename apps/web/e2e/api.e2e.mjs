// Every public form, every Stripe webhook path, and the admin API, against a
// real database and the fake Stripe server. Run with `npm run e2e` or
// `npm run e2e -- api`.
import Stripe from "stripe";
import {
  BASE,
  STRIPE_BASE,
  WEBHOOK_SECRET,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  sql,
  ok,
  finish,
  post,
  fakeSession,
  stripeLog,
  stripeObject,
  stripeEvent as webhook,
  sessionIdFromUrl as sid,
  ensureAdmin,
} from "./helpers.mjs";

const stripe = new Stripe("sk_test_x");
const LIMIT = 142970;
const OVER_LIMIT = (slate) =>
  `That would take you over this year's $1,429.70 contribution limit for our ${slate}. Try a smaller amount, or email hello@imaginesurrey.ca if you think this is a mistake.`;
const seconds = (d) => Math.floor(new Date(d).getTime() / 1000);
const pacificMonthIndex = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", month: "numeric" }).format(new Date())) - 1;
const pacificYear = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric" }).format(new Date()));
/** A birthdate that makes someone `age` today, whatever today is. */
const birthdateForAge = (age) => `${pacificYear - age}-01-01`;

const completed = async (id, extra = {}, opts = {}) => {
  const s = await fakeSession(id);
  return webhook(
    "checkout.session.completed",
    {
      id,
      object: "checkout.session",
      mode: s.mode,
      metadata: s.metadata,
      payment_status: "paid",
      payment_intent: `pi_${id}`,
      customer: "cus_123",
      amount_total: s.amount_total,
      ...extra,
    },
    opts,
  );
};

// ── Newsletter ────────────────────────────────────────────────────────────
let r = await post("/api/newsletter", { email: "News@Example.com", source: "home" });
ok(r.status === 200, "newsletter subscribe");
r = await post("/api/newsletter", { email: "news@example.com" });
ok(r.status === 200 && (await sql`select count(*)::int c from newsletter_subscribers where email='news@example.com'`)[0].c === 1, "newsletter re-subscribe is idempotent");
r = await post("/api/newsletter", { email: "bot@example.com", website: "spam.com" });
ok(r.status === 200 && (await sql`select count(*)::int c from newsletter_subscribers where email='bot@example.com'`)[0].c === 0, "honeypot submission dropped silently");
r = await post("/api/newsletter", { email: "not-an-email" });
ok(r.status === 422 && r.body.fields?.email, "invalid email rejected with field error");

// ── Membership ────────────────────────────────────────────────────────────
const member = {
  firstName: "Asha",
  lastName: "Singh",
  email: "asha@example.com",
  phone: "",
  address: "13450 104 Ave",
  city: "Surrey",
  postalCode: "v3t1v8",
  neighbourhood: "Whalley",
  birthdate: "1990-04-12",
  citizenshipStatus: "Citizen",
  gender: "",
  languages: ["English", "Punjabi"],
  student: false,
  campus: "",
  issue: "Safer streets",
  interestVolunteer: true,
  interestLawnSign: false,
  consent: true,
  website: "",
};
r = await post("/api/membership", { ...member, birthdate: "2015-01-01" });
ok(r.status === 422 && r.body.fields?.birthdate, "under-14 membership refused");
r = await post("/api/membership", { ...member, email: "visitor@example.com", citizenshipStatus: "Other" });
ok(r.status === 422 && r.body.fields?.citizenshipStatus, "non-citizen can't pay membership fee");

// A supporter with a share code sent Asha here.
await sql`update people set referral_code='ABCDEF23' where email='news@example.com'`;
r = await post("/api/membership", { ...member, source: "flyer", ref: "abcdef23" });
ok(r.status === 200 && r.body.status === "checkout", "membership creates Stripe checkout (optional source and ref accepted)");
const memSession = sid(r.body.url);
const memParams = (await fakeSession(memSession)).params;
ok(
  memParams.line_items["0"].price_data.unit_amount === "1000" && memParams.customer_email === "asha@example.com" && memParams.customer_creation === "always",
  "membership checkout with no amount chosen charges the $10 minimum to the member's email and asks Stripe to create a customer",
);
ok(Number(memParams.expires_at) - Math.floor(Date.now() / 1000) > 31 * 60, "checkout expiry leaves Stripe's 30-minute minimum some margin");
let p = (await sql`select source, referred_by_id = (select id from people where email='news@example.com') as referred from people where email='asha@example.com'`)[0];
ok(p.source === "flyer" && p.referred === true, "source and referral recorded on the person");

// Consent to email or texts comes only from the form's own unticked boxes, recorded with the wording shown.
const UPDATES_WORDING = "Yes, Imagine Surrey can email me news and ways to help. I can unsubscribe at any time.";
const SMS_WORDING = "Yes, Imagine Surrey can text me about events and volunteering. Reply STOP at any time. Message and data rates may apply.";
const consentFor = (email) => sql`select channel, purpose, action, wording, source, ip from consent_events where email=${email} order by channel`;
const consentCols = async (email) => (await sql`select contact_consent_at, sms_consent_at from people where email=${email}`)[0];
const subscribed = async (email) => (await sql`select count(*)::int c from newsletter_subscribers where email=${email}`)[0].c;
let cc = await consentCols("asha@example.com");
ok((await consentFor("asha@example.com")).length === 0 && cc.contact_consent_at === null && cc.sms_consent_at === null && (await subscribed("asha@example.com")) === 0, "joining without the ticks records no consent and subscribes no one");
const postWith = async (path, body, headers) => {
  const res = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
r = await postWith("/api/membership", { ...member, email: "ticks@example.com", phone: "604-555-0123", updatesConsent: true, smsConsent: true, locale: "pa" }, { "x-forwarded-for": "10.77.0.1", cookie: "is_track=ref%3DABCDEF23%26source%3Dwhatsapp" });
let ev = await consentFor("ticks@example.com");
cc = await consentCols("ticks@example.com");
ok(
  r.status === 200 && r.body.status === "checkout" &&
    ev.length === 2 &&
    ev[0].channel === "email" && ev[0].purpose === "updates" && ev[0].action === "grant" && ev[0].wording === UPDATES_WORDING && ev[0].source === "membership-form" && ev[0].ip === "10.77.0.1" &&
    ev[1].channel === "sms" && ev[1].purpose === "sms" && ev[1].wording === SMS_WORDING && ev[1].source === "membership-form" &&
    cc.contact_consent_at !== null && cc.sms_consent_at !== null && (await subscribed("ticks@example.com")) === 1,
  "the ticks are recorded in the consent ledger with their wording and request details, and the email tick subscribes",
);
p = (await sql`select source, referred_by_id = (select id from people where email='news@example.com') as referred from people where email='ticks@example.com'`)[0];
ok(p.source === "whatsapp" && p.referred === true, "without ref or source in the body, the tracking cookie credits the referrer and the source");
await sql`insert into people (email, first_name, phone) values ('stored-phone@example.com', 'Sid', '604-555-0199')`;
r = await post("/api/membership", { ...member, email: "stored-phone@example.com", phone: "", smsConsent: true });
ev = await consentFor("stored-phone@example.com");
ok(r.status === 200 && ev.length === 0 && (await consentCols("stored-phone@example.com")).sms_consent_at === null, "a text tick without a phone typed on the form records nothing, even with a phone on file");
let pendingMembership = (await sql`select status, member_name, member_address, member_city, member_postal_code, member_neighbourhood from memberships where stripe_checkout_session_id=${memSession}`)[0];
ok(
  pendingMembership.status === "pending_payment" && pendingMembership.member_name === "Asha Singh" && pendingMembership.member_postal_code === "V3T 1V8" && pendingMembership.member_neighbourhood === "Whalley" && pendingMembership.member_city === "Surrey",
  "member details snapshotted on the membership row",
);
const memPaidAt = Math.floor(Date.now() / 1000) - 600;
let w = await completed(memSession, {}, { created: memPaidAt });
ok(w.status === 200 && w.body.result === "processed", "membership webhook processed");
let m = (await sql`select m.status, m.voting_eligible, m.expires_at > now() + interval '364 days' as year from memberships m join people p on p.id=m.person_id where p.email='asha@example.com'`)[0];
ok(m.status === "active" && m.voting_eligible && m.year, "membership active for a year, voting eligible");
let c = (await sql`select status, kind, amount_cents, contributor_postal_code, paid_at from contributions where stripe_checkout_session_id=${memSession}`)[0];
ok(c.status === "succeeded" && c.kind === "membership_fee" && c.contributor_postal_code === "V3T 1V8", "membership fee recorded as a contribution");
ok(seconds(c.paid_at) === memPaidAt, "paid_at is the Stripe event's time, not when the webhook ran");
p = (await sql`select stripe_customer_id, stripe_customer_mode from people where email='asha@example.com'`)[0];
ok(p.stripe_customer_id === "cus_123" && p.stripe_customer_mode === "test", "Stripe customer remembered along with its mode");
const resend = await fetch(BASE + "/api/stripe/webhook", {
  method: "POST",
  headers: { "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload: w.payload, secret: WEBHOOK_SECRET }) },
  body: w.payload,
});
ok((await resend.json()).result === "duplicate", "replayed webhook is ignored");
const bad = await fetch(BASE + "/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": "t=1,v1=deadbeef" }, body: w.payload });
ok(bad.status === 400, "webhook with bad signature rejected");

// ── Membership by donation ────────────────────────────────────────────────
// Pay what you can from $10 a year; $5 for youth members (14 to 30 on the day they join).
const MIN_MESSAGE = "The smallest membership is $10 a year ($5 for members aged 14 to 30).";
const YOUTH_MIN_MESSAGE = "The smallest youth membership (ages 14 to 30) is $5 a year.";
// Not volunteers: the shifts suite's roster stays the size it expects.
const joiner = { ...member, interestVolunteer: false };
r = await post("/api/membership", { ...joiner, email: "pwyc@example.com", amountCents: 2550 });
ok(r.status === 200 && r.body.status === "checkout" && Object.keys(r.body).sort().join() === "status,url", "a pay-what-you-can membership gets the usual checkout answer");
const pwycSession = sid(r.body.url);
ok((await fakeSession(pwycSession)).params.line_items["0"].price_data.unit_amount === "2550", "the checkout charges the amount chosen ($25.50)");
w = await completed(pwycSession);
const pwyc = (await sql`select m.status, m.fee_cents, m.youth, c.amount_cents, c.status as fee_status, c.kind from memberships m join contributions c on c.stripe_checkout_session_id = m.stripe_checkout_session_id where m.stripe_checkout_session_id=${pwycSession}`)[0];
ok(
  w.body.result === "processed" && pwyc.status === "active" && pwyc.fee_cents === 2550 && pwyc.youth === false && pwyc.amount_cents === 2550 && pwyc.fee_status === "succeeded" && pwyc.kind === "membership_fee",
  "the whole amount chosen is the membership contribution, and the member isn't marked youth",
);
const pwycForward = await sql`select payload from base_ground_outbox where kind='membership' and person_id=(select id from people where email='pwyc@example.com')`;
ok(
  pwycForward.length === 1 && !JSON.stringify(pwycForward[0].payload).includes("2550") && !JSON.stringify(pwycForward[0].payload).includes("25.50") && !/amount|cents|fee/i.test(Object.keys(pwycForward[0].payload).join()),
  "the membership forwarded to Base Ground carries no money",
);
const pwycWelcome = await (await fetch(`${BASE}/join/welcome?session_id=${pwycSession}`)).text();
ok(pwycWelcome.includes("your $25.50 membership") && pwycWelcome.includes("runs until"), "the welcome page thanks the member for the amount they chose");

r = await post("/api/membership", { ...joiner, email: "under-min@example.com", amountCents: 900 });
ok(r.status === 422 && r.body.error === MIN_MESSAGE && r.body.fields?.amountCents === MIN_MESSAGE, "an amount under the $10 minimum is refused, naming the youth minimum");
ok((await sql`select count(*)::int c from people where email='under-min@example.com'`)[0].c === 0, "and nothing is recorded for it");
r = await post("/api/membership", { ...joiner, email: "under-min@example.com", amountCents: 500 });
ok(r.status === 422 && r.body.fields?.amountCents === MIN_MESSAGE, "$5 is refused for someone over 30");
r = await post("/api/membership", { ...joiner, email: "under-min@example.com", amountCents: LIMIT + 1 });
ok(r.status === 422 && r.body.fields?.amountCents === "The most you can give is $1,429.70 a year under BC law.", "more than the year's limit is refused");
r = await post("/api/membership", { ...joiner, email: "under-min@example.com", amountCents: 1000.5 });
ok(r.status === 422 && r.body.fields?.amountCents, "fractions of a cent are refused");

r = await post("/api/membership", { ...joiner, email: "youth@example.com", birthdate: birthdateForAge(20), amountCents: 400 });
ok(r.status === 422 && r.body.fields?.amountCents === YOUTH_MIN_MESSAGE, "under the youth minimum is refused with the youth minimum named");
r = await post("/api/membership", { ...joiner, email: "youth@example.com", birthdate: birthdateForAge(20), amountCents: 500 });
ok(r.status === 200 && r.body.status === "checkout", "a youth member can join for $5");
const youthSession = sid(r.body.url);
ok((await fakeSession(youthSession)).params.line_items["0"].price_data.unit_amount === "500", "the youth checkout charges $5");
w = await completed(youthSession);
const youthRow = (await sql`select status, fee_cents, youth from memberships where stripe_checkout_session_id=${youthSession}`)[0];
ok(youthRow.status === "active" && youthRow.fee_cents === 500 && youthRow.youth === true, "the youth membership is active, $5, and marked youth");
r = await post("/api/membership", { ...joiner, email: "youth-default@example.com", birthdate: birthdateForAge(14) });
ok(r.status === 200 && (await fakeSession(sid(r.body.url))).params.line_items["0"].price_data.unit_amount === "500", "with no amount chosen, a 14-year-old is charged the $5 youth minimum");
ok((await sql`select youth from memberships where stripe_checkout_session_id=${sid(r.body.url)}`)[0].youth === true, "and is marked youth");
r = await post("/api/membership", { ...joiner, email: "thirty-one@example.com", birthdate: birthdateForAge(31), amountCents: 500 });
ok(r.status === 422 && r.body.fields?.amountCents === MIN_MESSAGE, "at 31 the youth minimum no longer applies");

// Joining again never reveals the existing membership; it extends it.
r = await post("/api/membership", member);
ok(r.status === 200 && r.body.status === "checkout" && Object.keys(r.body).sort().join() === "status,url", "joining again gets a checkout and nothing that says the email is a member's");
const memSession2 = sid(r.body.url);
ok((await fakeSession(memSession2)).params.customer === "cus_123", "the remembered Stripe customer is reused");
w = await completed(memSession2);
const terms = await sql`select m.status, m.starts_at, m.expires_at from memberships m join people p on p.id=m.person_id where p.email='asha@example.com' order by m.created_at`;
ok(
  terms.length === 2 && terms[1].status === "active" && seconds(terms[1].starts_at) === seconds(terms[0].expires_at) && seconds(terms[1].expires_at) > seconds(terms[0].expires_at),
  "second membership starts when the first ends",
);
const welcome = await (await fetch(`${BASE}/join/welcome?session_id=${memSession2}`)).text();
ok(welcome.includes("runs until"), "welcome page shows when the membership runs to");
const welcomeUnknown = await (await fetch(`${BASE}/join/welcome?session_id=cs_test_nope`)).text();
ok(!welcomeUnknown.includes("runs until") && welcomeUnknown.includes("Thanks for joining"), "welcome page is generic without a known session");

// ── Donations ─────────────────────────────────────────────────────────────
const donor = {
  firstName: "Asha",
  lastName: "Singh",
  email: "asha@example.com",
  address: "13450 104 Ave",
  city: "Surrey",
  postalCode: "V3T 1V8",
  attestCitizenOrPR: true,
  attestBcResident: true,
  attestOwnFunds: true,
  newsletter: true,
};
r = await post("/api/donations/checkout", { ...donor, frequency: "one_time", tier: "standard", amountCents: 5000, postalCode: "M5V 2T6" });
ok(r.status === 422 && r.body.fields?.postalCode, "out-of-province donor refused");
r = await post("/api/donations/checkout", { ...donor, frequency: "one_time", tier: "standard", amountCents: 5000, source: "share-link" });
ok(r.status === 200, "one-time donation checkout");
const donSession = sid(r.body.url);
let rq = await post("/api/donations/checkout", { ...donor, email: "quiet-donor@example.com", newsletter: false, frequency: "one_time", tier: "standard", amountCents: 2500, ref: "ABCDEF23" });
cc = await consentCols("quiet-donor@example.com");
p = (await sql`select referred_by_id = (select id from people where email='news@example.com') as referred from people where email='quiet-donor@example.com'`)[0];
ok(rq.status === 200 && cc.contact_consent_at === null && (await consentFor("quiet-donor@example.com")).length === 0 && (await subscribed("quiet-donor@example.com")) === 0 && p.referred === true, "a donation without the newsletter tick records no consent; its ref is credited");
rq = await post("/api/donations/checkout", { ...donor, email: "keen-donor@example.com", newsletter: true, frequency: "monthly", tier: "standard", amountCents: 1000 });
ev = await consentFor("keen-donor@example.com");
ok(
  rq.status === 200 && ev.length === 1 && ev[0].channel === "email" && ev[0].purpose === "newsletter" && ev[0].wording === "Send me the Imagine Surrey newsletter. I can unsubscribe at any time." && ev[0].source === "donation-form" && (await consentCols("keen-donor@example.com")).contact_consent_at !== null && (await subscribed("keen-donor@example.com")) === 1,
  "the newsletter tick on a donation is recorded with its wording and subscribes",
);
const donPaidAt = Math.floor(Date.now() / 1000) - 3600;
w = await completed(donSession, {}, { created: donPaidAt });
c = (await sql`select status, paid_at from contributions where stripe_checkout_session_id=${donSession}`)[0];
ok(c.status === "succeeded" && seconds(c.paid_at) === donPaidAt, "donation recorded as succeeded at the event's time");
ok((await sql`select source from people where email='asha@example.com'`)[0].source === "flyer", "a later form never overwrites where the person first came from");
r = await post("/api/donations/checkout", { ...donor, frequency: "one_time", tier: "star", amountCents: 0 });
ok(r.status === 422 && r.body.error === OVER_LIMIT("city council slate"), "Star Club refused after $70 given, with a message that reveals no amounts");

// The membership form answers the same whether or not the fee can be taken: a stranger typing a
// near-limit donor's email learns nothing. A fee that is over the limit goes back once paid, and
// only the payer is told why.
r = await post("/api/donations/checkout", { ...donor, email: "full@example.com", frequency: "one_time", tier: "standard", amountCents: LIMIT });
await completed(sid(r.body.url));
r = await post("/api/membership", { ...member, email: "full@example.com" });
const strangerView = await post("/api/membership", { ...member, email: "never-gave@example.com" });
const shape = (res) => `${res.status} ${Object.keys(res.body).sort().join()} ${res.body.status} ${new URL(res.body.url ?? "http://x").origin}`;
ok(r.status === 200 && r.body.status === "checkout" && shape(r) === shape(strangerView), "a member whose fee would go over the limit gets the same answer as anyone else");
const fullSession = sid(r.body.url);
const feeMailFor = async (email) => sql`select subject, html, text from email_log where "to"=${email} and kind='membership-fee-limit'`;
ok((await feeMailFor("full@example.com")).length === 0, "nothing is sent before a fee is paid");
w = await completed(fullSession);
const fullFee = (await sql`select status, refunded_cents, refund_pending_cents from contributions where stripe_checkout_session_id=${fullSession}`)[0];
const fullMembership = (await sql`select status from memberships where stripe_checkout_session_id=${fullSession}`)[0];
const fullRefund = (await stripeLog()).find((l) => l.method === "POST" && l.path === "/v1/refunds" && l.params.payment_intent === `pi_${fullSession}`);
ok(
  w.body.result === "processed" && fullFee.status === "refunded_over_limit" && fullFee.refunded_cents === 1000 && fullFee.refund_pending_cents === 0 && fullRefund?.params.amount === "1000" && fullMembership.status === "cancelled",
  "once paid, an over-limit fee is refunded in full and the membership cancelled",
);
const feeMail = await feeMailFor("full@example.com");
ok(
  feeMail.length === 1 && feeMail[0].subject === "About your Imagine Surrey membership" && feeMail[0].html.includes("refunded your fee in full") && feeMail[0].html.includes("hello@imaginesurrey.ca") && !/\$\d/.test(feeMail[0].html) && !/\$\d/.test(feeMail[0].text ?? ""),
  "the payer alone is emailed why, how to sort it out, and no amounts",
);
const welcomeFull = await (await fetch(`${BASE}/join/welcome?session_id=${fullSession}`)).text();
ok(!welcomeFull.includes("payment is in") && !welcomeFull.includes("runs until") && !welcomeFull.includes("part of your neighbourhood committee") && welcomeFull.includes("Thanks for joining"), "the welcome page doesn't call a returned fee paid or the payer a member");
r = await post("/api/donations/checkout", { ...donor, email: "star@example.com", frequency: "one_time", tier: "superstar", amountCents: 0 });
const ss = await fakeSession(sid(r.body.url));
ok(r.status === 200 && Object.keys(ss.params.line_items).length === 2 && ss.amount_total === 285940, "Superstar one-time is two line items totalling $2,859.40");
const ssRows = await sql`select slate, amount_cents from contributions where stripe_checkout_session_id=${ss.id} order by slate`;
ok(ssRows.length === 2 && ssRows[0].slate === "council" && ssRows[1].slate === "school_board", "Superstar recorded per slate");

// Two tabs: an open checkout never blocks another; the webhook returns any excess.
r = await post("/api/donations/checkout", { ...donor, email: "star@example.com", frequency: "one_time", tier: "standard", amountCents: 1000 });
ok(r.status === 200, "an open checkout doesn't count against a second one");
const smallSession = sid(r.body.url);
await completed(ss.id);
w = await completed(smallSession);
const backstop = (await sql`select id, status, refunded_cents, refund_pending_cents from contributions where stripe_checkout_session_id=${smallSession}`)[0];
let refund = (await stripeLog()).find((l) => l.method === "POST" && l.path === "/v1/refunds" && l.idem === `over-limit-${backstop.id}-1000`);
ok(
  w.body.result === "processed" && backstop.status === "refunded_over_limit" && backstop.refunded_cents === 1000 && backstop.refund_pending_cents === 0,
  "the second payment is returned in full once the webhook has responded (nothing left pending)",
);
ok(refund?.params.amount === "1000" && refund.params.payment_intent === `pi_${smallSession}`, "over-limit refund issued against the payment intent, keyed by contribution and amount");

// Partial refunds from the Stripe dashboard are reconciled, council first.
const ssCharge = { id: "ch_ss", object: "charge", payment_intent: `pi_${ss.id}`, amount: 285940 };
await webhook("charge.refunded", { ...ssCharge, amount_refunded: 50000 });
let ssRefunds = await sql`select slate, status, refunded_cents from contributions where stripe_checkout_session_id=${ss.id} order by slate`;
ok(ssRefunds[0].refunded_cents === 50000 && ssRefunds[0].status === "succeeded" && ssRefunds[1].refunded_cents === 0, "partial dashboard refund comes off the council row first");
await webhook("charge.refunded", { ...ssCharge, amount_refunded: 200000 });
ssRefunds = await sql`select slate, status, refunded_cents from contributions where stripe_checkout_session_id=${ss.id} order by slate`;
ok(
  ssRefunds[0].refunded_cents === 142970 && ssRefunds[0].status === "refunded" && ssRefunds[1].refunded_cents === 57030 && ssRefunds[1].status === "succeeded",
  "a larger refund fills council and spills into school board; only the full row is marked refunded",
);
await webhook("charge.refunded", { ...ssCharge, amount_refunded: 285940 });
ssRefunds = await sql`select slate, status, refunded_cents from contributions where stripe_checkout_session_id=${ss.id} order by slate`;
ok(ssRefunds.every((x) => x.status === "refunded" && x.refunded_cents === 142970), "full refund marks both rows refunded");

// Stripe customers are only reused in the mode that created them.
await sql`update people set stripe_customer_id='cus_live_1', stripe_customer_mode='live' where email='star@example.com'`;
r = await post("/api/donations/checkout", { ...donor, email: "star@example.com", frequency: "one_time", tier: "standard", amountCents: 1000 });
let params = (await fakeSession(sid(r.body.url))).params;
ok(r.status === 200 && params.customer === undefined && params.customer_email === "star@example.com", "a customer id from the other Stripe mode is not reused");
await sql`update people set stripe_customer_id='cus_missing', stripe_customer_mode='test' where email='star@example.com'`;
r = await post("/api/donations/checkout", { ...donor, email: "star@example.com", frequency: "one_time", tier: "standard", amountCents: 1000 });
params = (await fakeSession(sid(r.body.url))).params;
ok(
  r.status === 200 && params.customer === undefined && params.customer_email === "star@example.com" && (await sql`select stripe_customer_id from people where email='star@example.com'`)[0].stripe_customer_id === null,
  "a customer Stripe no longer knows is forgotten and the checkout retried without it",
);

// A session delivered without its metadata is re-read from Stripe.
r = await post("/api/donations/checkout", { ...donor, email: "bare@example.com", frequency: "one_time", tier: "standard", amountCents: 2500 });
const bareSession = sid(r.body.url);
w = await completed(bareSession, { metadata: undefined });
ok(w.body.result === "processed" && (await sql`select status from contributions where stripe_checkout_session_id=${bareSession}`)[0].status === "succeeded", "a checkout event missing its metadata is re-read and still recorded");

// Two tabs: a fee paid after the limit was reached goes back, the membership is cancelled, and the welcome page claims nothing.
r = await post("/api/membership", { ...member, email: "race@example.com" });
const raceSession = sid(r.body.url);
r = await post("/api/donations/checkout", { ...donor, email: "race@example.com", frequency: "one_time", tier: "star", amountCents: 0 });
await completed(sid(r.body.url));
w = await completed(raceSession);
const raceFee = (await sql`select status, refunded_cents, refund_pending_cents from contributions where stripe_checkout_session_id=${raceSession}`)[0];
const raceMembership = (await sql`select status from memberships where stripe_checkout_session_id=${raceSession}`)[0];
ok(
  w.body.result === "processed" && raceFee.status === "refunded_over_limit" && raceFee.refunded_cents === 1000 && raceFee.refund_pending_cents === 0 && raceMembership.status === "cancelled",
  "a fee paid once the limit is reached is returned and the membership cancelled",
);
const welcomeRace = await (await fetch(`${BASE}/join/welcome?session_id=${raceSession}`)).text();
ok(!welcomeRace.includes("payment is in") && !welcomeRace.includes("runs until") && welcomeRace.includes("Thanks for joining"), "the welcome page doesn't call a returned fee paid");
ok((await feeMailFor("race@example.com")).length === 1, "and the payer is emailed why");

// ── Over-limit refunds Stripe could not take at the time ──────────────────
// They stay pending and are retried on later webhooks; whatever Stripe has
// returned meanwhile, by us or from the dashboard, is counted first.
const refundsFail = (fail) => fetch(`${STRIPE_BASE}/__refunds`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fail }) });
// Two tabs again: both checkouts open while nothing is paid, then the second payment is $70.30 over.
const stuckPayment = async (email) => {
  const first = sid((await post("/api/donations/checkout", { ...donor, email, frequency: "one_time", tier: "standard", amountCents: 100000 })).body.url);
  const second = sid((await post("/api/donations/checkout", { ...donor, email, frequency: "one_time", tier: "standard", amountCents: 50000 })).body.url);
  await completed(first);
  await refundsFail(true);
  await completed(second);
  await refundsFail(false);
  const row = (await sql`select id, status, refunded_cents, refund_pending_cents from contributions where stripe_checkout_session_id=${second}`)[0];
  return { ...row, pi: `pi_${second}` };
};
const refundPosts = async (id) => (await stripeLog()).filter((l) => l.method === "POST" && l.path === "/v1/refunds" && l.idem?.startsWith(`over-limit-${id}-`)).length;
const rowNow = async (id) => (await sql`select status, refunded_cents, refund_pending_cents from contributions where id=${id}`)[0];
// Any webhook at all retries what is pending.
const nudge = () => webhook("customer.subscription.updated", { id: "sub_none", object: "subscription", status: "active", cancel_at_period_end: false });

let stuck = await stuckPayment("stuck1@example.com");
ok(stuck.status === "succeeded" && stuck.refund_pending_cents === 7030 && stuck.refunded_cents === 0 && (await refundPosts(stuck.id)) === 1, "a refund Stripe could not take stays pending");
await webhook("charge.refunded", { id: "ch_stuck1", object: "charge", payment_intent: stuck.pi, amount: 50000, amount_refunded: 7030 });
let after = await rowNow(stuck.id);
ok(after.refunded_cents === 7030 && after.refund_pending_cents === 0 && after.status === "succeeded", "an operator refunding the pending amount from the dashboard settles it");
await nudge();
ok((await refundPosts(stuck.id)) === 1, "nothing more is sent to Stripe for it");

stuck = await stuckPayment("stuck2@example.com");
await stripeObject({ id: "re_dash_2", object: "refund", payment_intent: stuck.pi, amount: 50000 });
await nudge();
after = await rowNow(stuck.id);
ok(after.refunded_cents === 50000 && after.refund_pending_cents === 0 && after.status === "refunded" && (await refundPosts(stuck.id)) === 1, "a retry finds the whole payment already refunded and records it rather than asking again");
await webhook("charge.refunded", { id: "ch_stuck2", object: "charge", payment_intent: stuck.pi, amount: 50000, amount_refunded: 50000 });
const late = await rowNow(stuck.id);
ok(late.refunded_cents === 50000 && late.refund_pending_cents === 0 && late.status === "refunded", "the late charge.refunded event changes nothing");

stuck = await stuckPayment("stuck3@example.com");
await stripeObject({ id: "re_dash_3", object: "refund", payment_intent: stuck.pi, amount: 45000 });
await nudge();
after = await rowNow(stuck.id);
ok(after.refunded_cents === 45000 && after.refund_pending_cents === 0 && after.status === "succeeded" && (await refundPosts(stuck.id)) === 1, "a larger dashboard refund covers the pending amount and the rest is recorded as returned");

stuck = await stuckPayment("stuck4@example.com");
await stripeObject({ id: "re_ours_4", object: "refund", payment_intent: stuck.pi, amount: 7030, metadata: { contributionId: stuck.id } });
await nudge();
after = await rowNow(stuck.id);
ok(after.refunded_cents === 7030 && after.refund_pending_cents === 0 && after.status === "succeeded" && (await refundPosts(stuck.id)) === 1, "a refund of ours that went through unrecorded is recorded, not sent twice");

// ── Monthly ───────────────────────────────────────────────────────────────
r = await post("/api/donations/checkout", { ...donor, email: "monthly@example.com", frequency: "monthly", tier: "superstar", amountCents: 0 });
const monSession = await fakeSession(sid(r.body.url));
ok(r.status === 200 && monSession.mode === "subscription" && monSession.params.subscription_data.metadata.recurringDonationId, "monthly gift creates a subscription checkout");
w = await completed(monSession.id, { subscription: "sub_1", payment_intent: null });
ok((await sql`select status, stripe_subscription_id from recurring_donations where stripe_checkout_session_id=${monSession.id}`)[0].stripe_subscription_id === "sub_1", "subscription activated");
const invoice = (id) => ({
  id,
  object: "invoice",
  status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
  parent: { type: "subscription_details", subscription_details: { subscription: "sub_1", metadata: monSession.params.subscription_data.metadata } },
});
w = await webhook("invoice.paid", invoice("in_1"));
let inv = await sql`select slate, amount_cents, frequency, fund, stripe_payment_intent_id from contributions where stripe_invoice_id='in_1' order by slate`;
ok(inv.length === 2 && inv.every((x) => x.amount_cents === 11900 && x.fund === "imagine_victory_fund" && x.stripe_payment_intent_id === "pi_for_in_1"), "monthly Superstar payment recorded as two $119 contributions");
await webhook("invoice.paid", invoice("in_1"));
ok((await sql`select count(*)::int c from contributions where stripe_invoice_id='in_1'`)[0].c === 2, "same invoice never double-counted");

// Over-limit backstop: pretend this donor already gave $1,400 to council this year.
const mp = (await sql`select id from people where email='monthly@example.com'`)[0];
await sql`insert into contributions (person_id, kind, frequency, slate, amount_cents, status, contributor_name, contributor_address, contributor_city, contributor_postal_code, eligibility_attested_at, paid_at)
  values (${mp.id}, 'donation', 'one_time', 'council', 140000, 'succeeded', 'x', 'x', 'x', 'x', now(), now())`;
await webhook("invoice.paid", invoice("in_2"));
const over = (await sql`select id, refunded_cents, refund_pending_cents, status from contributions where stripe_invoice_id='in_2' and slate='council'`)[0];
refund = (await stripeLog()).find((l) => l.method === "POST" && l.path === "/v1/refunds" && l.idem === `over-limit-${over.id}-11900`);
ok(
  over.refunded_cents === 11900 && over.refund_pending_cents === 0 && over.status === "refunded_over_limit" && refund?.params.amount === "11900" && refund.params.payment_intent === "pi_for_in_2",
  `over-limit monthly payment of ${over.refunded_cents}¢ refunded automatically`,
);
ok((await sql`select refunded_cents from contributions where stripe_invoice_id='in_2' and slate='school_board'`)[0].refunded_cents === 0, "other slate untouched");
await webhook("customer.subscription.deleted", { id: "sub_1", object: "subscription" });
ok((await sql`select status from recurring_donations where stripe_subscription_id='sub_1'`)[0].status === "cancelled", "cancelled subscription recorded");

// A coupon or credit applied in the dashboard: only what the invoice collected is recorded, council first for rounding.
r = await post("/api/donations/checkout", { ...donor, email: "coupon@example.com", frequency: "monthly", tier: "superstar", amountCents: 0 });
const couponSession = await fakeSession(sid(r.body.url));
await completed(couponSession.id, { subscription: "sub_coupon", payment_intent: null });
const couponInvoice = (id, amount_paid) => ({
  id,
  object: "invoice",
  amount_paid,
  status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
  parent: { type: "subscription_details", subscription_details: { subscription: "sub_coupon", metadata: couponSession.params.subscription_data.metadata } },
});
await webhook("invoice.paid", couponInvoice("in_coupon_full", 23800));
await webhook("invoice.paid", couponInvoice("in_coupon_part", 11901));
w = await webhook("invoice.paid", couponInvoice("in_coupon_free", 0));
const couponRows = await sql`select stripe_invoice_id, slate, amount_cents from contributions where stripe_invoice_id like 'in_coupon_%' order by stripe_invoice_id, slate`;
const couponOf = (id) => Object.fromEntries(couponRows.filter((x) => x.stripe_invoice_id === id).map((x) => [x.slate, x.amount_cents]));
ok(JSON.stringify(couponOf("in_coupon_full")) === JSON.stringify({ council: 11900, school_board: 11900 }), "an invoice paid in full records the gift's amounts");
ok(JSON.stringify(couponOf("in_coupon_part")) === JSON.stringify({ council: 5951, school_board: 5950 }), "a discounted invoice records only what was paid, shared in proportion with the odd cent on council");
ok(w.body.result === "processed" && Object.keys(couponOf("in_coupon_free")).length === 0, "an invoice that collected nothing records nothing");

// Endpoints on API versions before 2025-03-31 deliver invoices in the old shape.
r = await post("/api/donations/checkout", { ...donor, email: "monthly2@example.com", frequency: "monthly", tier: "standard", amountCents: 2500 });
const mon2 = await fakeSession(sid(r.body.url));
await completed(mon2.id, { subscription: "sub_2", payment_intent: null });
const legacyPaidAt = Math.floor(Date.now() / 1000) - 7200;
w = await webhook("invoice.paid", {
  id: "in_legacy",
  object: "invoice",
  subscription: "sub_2",
  subscription_details: { metadata: mon2.params.subscription_data.metadata },
  payment_intent: "pi_legacy_1",
  status_transitions: { paid_at: legacyPaidAt },
});
const legacy = (await sql`select amount_cents, stripe_payment_intent_id, stripe_subscription_id, paid_at from contributions where stripe_invoice_id='in_legacy'`)[0];
ok(
  w.body.result === "processed" && legacy?.amount_cents === 2500 && legacy.stripe_payment_intent_id === "pi_legacy_1" && legacy.stripe_subscription_id === "sub_2" && seconds(legacy.paid_at) === legacyPaidAt,
  "invoice.paid in the legacy shape (invoice.subscription, no parent) still records the payment with the invoice's paid_at",
);
await stripeObject({
  id: "in_bare",
  object: "invoice",
  status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
  parent: { type: "subscription_details", subscription_details: { subscription: "sub_2", metadata: {} } },
});
w = await webhook("invoice.paid", { id: "in_bare", object: "invoice" });
ok(
  w.body.result === "processed" && (await sql`select count(*)::int c from contributions where stripe_invoice_id='in_bare'`)[0].c === 1 && (await stripeLog()).some((l) => l.method === "GET" && l.path === "/v1/invoices/in_bare"),
  "an invoice delivered without its subscription fields is re-read from Stripe",
);

// The first invoice can arrive before checkout.session.completed, without metadata: the subscription itself names the gift.
r = await post("/api/donations/checkout", { ...donor, email: "monthly3@example.com", frequency: "monthly", tier: "standard", amountCents: 1000 });
const mon3 = await fakeSession(sid(r.body.url));
await stripeObject({ id: "sub_3", object: "subscription", status: "active", metadata: mon3.params.subscription_data.metadata });
w = await webhook("invoice.paid", {
  id: "in_first",
  object: "invoice",
  status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
  parent: { type: "subscription_details", subscription_details: { subscription: "sub_3", metadata: null } },
});
let gift3 = (await sql`select status, stripe_subscription_id from recurring_donations where stripe_checkout_session_id=${mon3.id}`)[0];
ok(
  w.body.result === "processed" && gift3.status === "active" && gift3.stripe_subscription_id === "sub_3" && (await sql`select count(*)::int c from contributions where stripe_invoice_id='in_first'`)[0].c === 1,
  "a first invoice arriving before the checkout event activates the gift via the subscription's metadata",
);

// Subscriptions Stripe stops collecting on stop reserving the donor's limit.
await webhook("customer.subscription.updated", { id: "sub_2", object: "subscription", status: "unpaid", cancel_at_period_end: false });
let sub2 = (await sql`select status, cancelled_at from recurring_donations where stripe_subscription_id='sub_2'`)[0];
ok(sub2.status === "cancelled" && sub2.cancelled_at !== null, "customer.subscription.updated with status unpaid cancels the recurring gift");
await webhook("customer.subscription.updated", { id: "sub_3", object: "subscription", status: "past_due", cancel_at_period_end: false });
ok((await sql`select status from recurring_donations where stripe_subscription_id='sub_3'`)[0].status === "active", "past_due keeps the gift active");
await webhook("customer.subscription.paused", { id: "sub_3", object: "subscription", status: "paused" });
ok((await sql`select status from recurring_donations where stripe_subscription_id='sub_3'`)[0].status === "cancelled", "a paused subscription is cancelled");
await webhook("customer.subscription.resumed", { id: "sub_3", object: "subscription", status: "active" });
gift3 = (await sql`select status, cancelled_at from recurring_donations where stripe_subscription_id='sub_3'`)[0];
ok(gift3.status === "active" && gift3.cancelled_at === null, "a resumed subscription is active again");
await webhook("customer.subscription.updated", { id: "sub_3", object: "subscription", status: "active", cancel_at_period_end: true });
gift3 = (await sql`select status, cancelled_at from recurring_donations where stripe_subscription_id='sub_3'`)[0];
ok(gift3.status === "cancelled" && gift3.cancelled_at !== null, "a subscription set to cancel at the end of its period stops reserving the limit at once");
r = await post("/api/donations/checkout", { ...donor, email: "monthly3@example.com", frequency: "one_time", tier: "standard", amountCents: LIMIT - 1000 });
ok(r.status === 200, "so the room it reserved is free again");
await webhook("customer.subscription.updated", { id: "sub_3", object: "subscription", status: "active", cancel_at_period_end: false });
gift3 = (await sql`select status, cancelled_at from recurring_donations where stripe_subscription_id='sub_3'`)[0];
ok(gift3.status === "active" && gift3.cancelled_at === null, "taking the cancellation back makes the gift active again");
const nowSec = Math.floor(Date.now() / 1000);
await webhook("customer.subscription.updated", {
  id: "sub_3",
  object: "subscription",
  status: "active",
  cancel_at_period_end: false,
  cancel_at: nowSec + 86400,
  items: { object: "list", data: [{ id: "si_3", current_period_end: nowSec + 20 * 86400 }] },
});
ok((await sql`select status from recurring_donations where stripe_subscription_id='sub_3'`)[0].status === "cancelled", "a subscription Stripe will cancel before its next payment stops reserving the limit");
await webhook("customer.subscription.updated", { id: "sub_3", object: "subscription", status: "active", cancel_at_period_end: false, cancel_at: null }, { created: nowSec - 3600 });
ok((await sql`select status from recurring_donations where stripe_subscription_id='sub_3'`)[0].status === "cancelled", "an older update delivered late doesn't revive it");
await webhook("customer.subscription.updated", {
  id: "sub_3",
  object: "subscription",
  status: "active",
  cancel_at_period_end: false,
  cancel_at: nowSec + 40 * 86400,
  items: { object: "list", data: [{ id: "si_3", current_period_end: nowSec + 20 * 86400 }] },
});
ok((await sql`select status from recurring_donations where stripe_subscription_id='sub_3'`)[0].status === "active", "one that still has a payment to take before it ends keeps reserving it");

// What the active $10/month gift still reserves this year: this month's payment has arrived, so one fewer.
const reserved = 1000 * (12 - pacificMonthIndex - 1);
const room = LIMIT - 1000 - reserved;
r = await post("/api/donations/checkout", { ...donor, email: "monthly3@example.com", frequency: "one_time", tier: "standard", amountCents: room });
ok(r.status === 200, `a one-time gift that exactly fills the room beside the monthly gift (${room}¢) is accepted`);
r = await post("/api/donations/checkout", { ...donor, email: "monthly3@example.com", frequency: "one_time", tier: "standard", amountCents: room + 1 });
ok(r.status === 422 && r.body.error === OVER_LIMIT("city council slate"), "one cent more is refused without revealing amounts");
r = await post("/api/donations/checkout", { ...donor, email: "monthly3@example.com", frequency: "monthly", tier: "star", amountCents: 0 });
ok(r.status === 422 && r.body.error === OVER_LIMIT("city council slate"), "a Star Club monthly gift beside an active monthly gift would not fit a full year");

// Dashboard refund of a whole payment
await webhook("charge.refunded", { id: "ch_1", object: "charge", payment_intent: `pi_${donSession}`, amount: 5000, amount_refunded: 5000 });
ok((await sql`select status from contributions where stripe_checkout_session_id=${donSession}`)[0].status === "refunded", "full refund from the Stripe dashboard recorded");

// Expired checkout
r = await post("/api/donations/checkout", { ...donor, email: "late@example.com", frequency: "one_time", tier: "standard", amountCents: 2500 });
await webhook("checkout.session.expired", { id: sid(r.body.url), object: "checkout.session", metadata: {}, payment_status: "unpaid" });
ok((await sql`select status from contributions where stripe_checkout_session_id=${sid(r.body.url)}`)[0].status === "failed", "expired checkout marked failed");

// ── Shop ──────────────────────────────────────────────────────────────────
r = await post("/api/shop/checkout", { items: [{ slug: "stop-doug-lawn-sign", quantity: 2 }, { slug: "window-sign", quantity: 1 }, { slug: "stop-doug-lawn-sign", quantity: 1 }] });
const shopS = await fakeSession(sid(r.body.url));
ok(r.status === 200 && shopS.amount_total === 6500 && shopS.params.shipping_address_collection.allowed_countries["0"] === "CA", "shop checkout: 3 signs + window sign = $65, ships in Canada");
r = await post("/api/shop/checkout", { items: [{ slug: "nope", quantity: 1 }] });
ok(r.status === 422, "unknown product refused");
await completed(shopS.id, {
  customer_details: { email: "Buyer@Example.com", phone: "6045550100" },
  collected_information: { shipping_details: { name: "Buyer", address: { line1: "1 Main", city: "Surrey", country: "CA", postal_code: "V3T 1V8", state: "BC" } } },
});
const order = (await sql`select o.status, o.email, o.shipping, p.email as person_email, p.source from orders o left join people p on p.id=o.person_id where o.stripe_checkout_session_id=${shopS.id}`)[0];
ok(
  order.status === "paid" && order.email === "buyer@example.com" && order.shipping.address.city === "Surrey" && order.shipping.phone === "6045550100" && order.person_email === "buyer@example.com" && order.source === "shop",
  "order paid with shipping address and linked to a person by lowercased email",
);
r = await post("/api/shop/checkout", { items: [{ slug: "tote-bag", quantity: 1 }] });
const shopLegacy = sid(r.body.url);
await completed(shopLegacy, {
  customer_details: { email: "buyer@example.com", phone: null },
  shipping_details: { name: "Buyer", address: { line1: "2 Main", city: "Delta", country: "CA", postal_code: "V4K 1A1", state: "BC" } },
});
ok((await sql`select shipping from orders where stripe_checkout_session_id=${shopLegacy}`)[0].shipping?.address?.city === "Delta", "shipping in the legacy session shape is recorded too");

// ── Petition and pledge ───────────────────────────────────────────────────
r = await post("/api/signatures", { campaign: "skytrain-south-surrey", firstName: "Raj", lastName: "P", email: "raj@example.com", postalCode: "v4a1a1", answer: "Park & Ride", consent: true });
ok(r.status === 200, "petition signed");
r = await post("/api/signatures", { campaign: "skytrain-south-surrey", firstName: "Raj", lastName: "P", email: "raj@example.com", postalCode: "v4a1a1", consent: true });
ok(r.status === 200 && (await sql`select count(*)::int c from campaign_signatures where email='raj@example.com'`)[0].c === 1, "signing twice keeps one signature");
r = await post("/api/signatures", { campaign: "stop-mccallum-pledge", firstName: "Raj", lastName: "P", email: "raj@example.com", postalCode: "V4A 1A1", consent: true });
ok(r.status === 200 && (await sql`select count(*)::int c from campaign_signatures where email='raj@example.com'`)[0].c === 2, "pledge signed separately");

// ── Events ────────────────────────────────────────────────────────────────
await sql`insert into events (slug, title, starts_at, location, summary) values ('town-hall', 'Newton town hall', now() + interval '10 days', 'Newton Seniors Centre', 'Bring your questions.') on conflict do nothing`;
r = await post("/api/events/town-hall/rsvp", { name: "Raj Patel", email: "raj@example.com", guests: 2, newsletter: true });
ok(r.status === 200 && (await sql`select guests from event_rsvps where email='raj@example.com'`)[0].guests === 2, "RSVP recorded");
r = await post("/api/events/nope/rsvp", { name: "X", email: "x@example.com" });
ok(r.status === 404, "RSVP to unknown event 404s");
const home = await (await fetch(BASE + "/")).text();
ok(home.includes("Newton town hall"), "home page shows the upcoming event from the database");

// ── Unsubscribe ───────────────────────────────────────────────────────────
const tok = (await sql`select unsubscribe_token from newsletter_subscribers where email='news@example.com'`)[0].unsubscribe_token;
await fetch(BASE + "/api/newsletter/unsubscribe", { method: "POST", body: new URLSearchParams({ token: tok }), redirect: "manual" });
ok((await sql`select status from newsletter_subscribers where email='news@example.com'`)[0].status === "unsubscribed", "unsubscribe works");

// ── Contribution limits by year ───────────────────────────────────────────
// Every check uses the row for the contribution's Pacific year; the seed stores this year's.
const yearRow = async () => (await sql`select cents from contribution_limits where year=${pacificYear}`)[0];
ok((await yearRow())?.cents === LIMIT || pacificYear !== 2026, `the ${pacificYear} limit is stored`);
await sql`insert into contribution_limits (year, cents, note) values (${pacificYear}, 50000, 'e2e') on conflict (year) do update set cents = 50000`;
const LOW_OVER = "That would take you over this year's $500 contribution limit for our city council slate. Try a smaller amount, or email hello@imaginesurrey.ca if you think this is a mistake.";
r = await post("/api/donations/checkout", { ...donor, email: "by-year@example.com", frequency: "one_time", tier: "standard", amountCents: 50001 });
ok(r.status === 422 && r.body.error === LOW_OVER, "a donation over this year's stored limit is refused, naming that limit");
r = await post("/api/donations/checkout", { ...donor, email: "by-year@example.com", frequency: "one_time", tier: "star", amountCents: 0 });
ok(r.status === 200 && (await fakeSession(sid(r.body.url))).amount_total === 50000, "the Star Club gives this year's stored limit");
const byYearStar = sid(r.body.url);
r = await post("/api/membership", { ...joiner, email: "by-year@example.com", amountCents: 2500 });
const byYearMembership = sid(r.body.url);
r = await post("/api/membership", { ...joiner, email: "by-year-max@example.com", amountCents: 50001 });
ok(r.status === 422 && r.body.fields?.amountCents === "The most you can give is $500 a year under BC law.", "the membership maximum is this year's stored limit");
await completed(byYearStar);
w = await completed(byYearMembership);
const byYearFee = (await sql`select status, refunded_cents from contributions where stripe_checkout_session_id=${byYearMembership}`)[0];
ok(
  w.body.result === "processed" && byYearFee.status === "refunded_over_limit" && byYearFee.refunded_cents === 2500 && (await sql`select status from memberships where stripe_checkout_session_id=${byYearMembership}`)[0].status === "cancelled",
  "the webhook backstop checks the chosen membership amount against the stored limit and returns it",
);
await sql`insert into contribution_limits (year, cents, note) values (${pacificYear + 1}, 99000, 'e2e next year') on conflict (year) do nothing`;
r = await post("/api/donations/checkout", { ...donor, email: "next-year@example.com", frequency: "one_time", tier: "standard", amountCents: 60000 });
ok(r.status === 422 && r.body.error === LOW_OVER, "next year's figure doesn't apply until January 1");
await sql`delete from contribution_limits where year=${pacificYear}`;
r = await post("/api/donations/checkout", { ...donor, email: "next-year@example.com", frequency: "one_time", tier: "standard", amountCents: 60000 });
ok(r.status === 200, "a year with no row falls back to CONTRIBUTION_LIMIT_CENTS");
await sql`delete from contribution_limits where year=${pacificYear + 1}`;
await sql`insert into contribution_limits (year, cents, note) values (${pacificYear}, ${LIMIT}, 'Elections BC') on conflict (year) do update set cents = ${LIMIT}`;

// ── Admin ─────────────────────────────────────────────────────────────────
let a = await fetch(BASE + "/api/admin/export/members", { redirect: "manual" });
ok(a.status === 401, "CSV export requires sign-in");
a = await fetch(BASE + "/admin", { redirect: "manual" });
ok(a.status === 307 || a.status === 303, `admin redirects to login (status ${a.status})`);
await ensureAdmin();
a = await fetch(BASE + "/api/admin/login", { method: "POST", body: new URLSearchParams({ email: ADMIN_EMAIL, password: "wrong" }), redirect: "manual" });
ok(a.headers.get("location")?.includes("error=invalid"), "wrong admin password rejected");
a = await fetch(BASE + "/api/admin/login", { method: "POST", body: new URLSearchParams({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }), redirect: "manual" });
const cookie = a.headers.get("set-cookie")?.split(";")[0];
ok(!!cookie, "admin signs in");
const csv = await (await fetch(BASE + "/api/admin/export/contributions", { headers: { cookie } })).text();
ok(csv.startsWith("paid_at,contributor_name") && csv.includes("membership_fee"), "contributions CSV exported");
const dash = await (await fetch(BASE + "/admin", { headers: { cookie } })).text();
const activeMembers = await (await fetch(BASE + "/admin/people?membership=active", { headers: { cookie } })).text();
ok(dash.includes("Active members") && activeMembers.includes("asha@example.com"), "admin dashboard counts members and the people list shows active ones");
const limitsPage = await (await fetch(BASE + "/admin/limits", { headers: { cookie } })).text();
ok(limitsPage.includes("Contribution limits") && limitsPage.includes(`data-year="${pacificYear}"`) && limitsPage.includes("$1,429.70"), "Admin → Contribution limits lists the stored years");
ok((await fetch(BASE + "/admin/limits", { redirect: "manual" })).status !== 200, "the limits page needs sign-in");
ok(dash.includes('href="/admin/limits"'), "the admin nav links to the contribution limits");

await finish();
