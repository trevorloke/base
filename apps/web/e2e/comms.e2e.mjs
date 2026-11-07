// Communications: newsletter opt-in and unsubscribe, inbound STOP handling,
// the day-before reminders cron and the log. Newsletters, campaign emails
// and text blasts go out from base ground, so the admin has no composer or text
// sender: only the log (checked in a real browser). Email and Twilio are not
// configured in e2e, so messages are logged as "skipped" but every row still
// exists.
import { chromium } from "playwright";
import { ADMIN_EMAIL, BASE, adminLogin, sql, ok, finish, post } from "./helpers.mjs";

const TAG = "e2e-comms";

/** Poll the database until a condition holds (background work runs after the response). */
async function eventually(fn, label, ms = 15_000) {
  const until = Date.now() + ms;
  let last;
  while (Date.now() < until) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`  (timed out waiting for: ${label})`);
  return last;
}

/** Wait for a server action's result message; on a timeout, say what the page shows instead. */
async function notice(pattern, ms = 15_000) {
  try {
    // .alert: the route announcer also has role=alert.
    await bp.locator(".alert, [role=status]", { hasText: pattern }).first().waitFor({ timeout: ms });
    return true;
  } catch {
    const shown = await bp.locator(".alert, [role=status]").allTextContents();
    ok(false, `expected a message matching ${pattern} at ${bp.url()}; the page shows: ${JSON.stringify(shown)}`);
    return false;
  }
}

/**
 * Press a button from the keyboard. Near the bottom of long admin pages the
 * site header's scroll-linked animation can keep the layout shifting by a
 * fraction of a pixel, which a mouse click waits on forever; keyboard
 * activation is what many organizers use anyway.
 */
async function activate(selector) {
  const target = bp.locator(selector).first();
  await target.focus();
  await bp.keyboard.press("Enter");
}

const noRedirect = (path, init = {}) => fetch(BASE + path, { redirect: "manual", ...init });

// ── Fixtures ──────────────────────────────────────────────────────────────
await sql`delete from people where email like '%@comms.example'`;
await sql`delete from newsletter_subscribers where email like '%@comms.example'`;
await sql`insert into people (email, first_name, last_name, phone, neighbourhood, contact_consent_at, sms_consent_at, tags, interest_volunteer) values
  ('sub1@comms.example', 'Sukh', 'Gill', '604-555-0101', 'Newton', now(), now(), ${[TAG]}, true),
  ('sub2@comms.example', 'Maria', 'Lopez', null, 'Whalley', now(), null, ${[TAG]}, false),
  ('member@comms.example', 'Dev', 'Patel', '(604) 555-0102', 'Fleetwood', now(), now(), ${[TAG]}, false),
  ('noconsent@comms.example', 'Noor', 'Khan', '604-555-0103', 'Newton', null, now(), ${[TAG]}, false),
  ('unsub@comms.example', 'Uma', 'Rao', null, 'Newton', now(), null, ${[TAG]}, false)`;
const person = async (email) => (await sql`select * from people where email = ${email}`)[0];
const sub1 = await person("sub1@comms.example");
const member = await person("member@comms.example");
await sql`insert into newsletter_subscribers (email, person_id, status, source, unsubscribe_token, confirmed_at) values
  ('sub1@comms.example', ${sub1.id}, 'subscribed', 'e2e', 'tok-sub1-e2e', now()),
  ('sub2@comms.example', ${(await person("sub2@comms.example")).id}, 'subscribed', 'e2e', 'tok-sub2-e2e', now()),
  ('unsub@comms.example', ${(await person("unsub@comms.example")).id}, 'unsubscribed', 'e2e', 'tok-unsub-e2e', null)`;
await sql`insert into memberships (person_id, status, fee_cents, voting_eligible, starts_at, expires_at) values (${member.id}, 'active', 1000, true, now(), now() + interval '1 year')`;

// ── Newsletter: single opt-in without an email key ────────────────────────
let r = await post("/api/newsletter", { email: "NL1@comms.example", source: "home" });
ok(r.status === 200 && r.body.status === "subscribed", `newsletter subscribe returns status "subscribed" (${JSON.stringify(r.body)})`);
let row = (await sql`select * from newsletter_subscribers where email = 'nl1@comms.example'`)[0];
ok(row?.status === "subscribed" && row.confirmed_at !== null, "subscriber row is subscribed and confirmed at once");
ok((await sql`select source from people where email = 'nl1@comms.example'`)[0]?.source === "newsletter", "a person is created for the subscriber");
ok((await sql`select count(*)::int c from consent_events where email = 'nl1@comms.example' and action = 'grant' and purpose = 'newsletter'`)[0].c === 1, "single opt-in records a newsletter grant in the consent ledger");

// A referral code in the body is credited to the referrer once.
await sql`update people set referral_code = 'COMMSRF2' where email = 'sub2@comms.example'`;
r = await post("/api/newsletter", { email: "referred@comms.example", source: "home", ref: "commsrf2" });
ok(r.body?.status === "subscribed" && (await sql`select r.email from people p join people r on r.id = p.referred_by_id where p.email = 'referred@comms.example'`)[0]?.email === "sub2@comms.example", "newsletter sign-up credits the referral code");

r = await post("/api/newsletter", { email: "nl1@comms.example", source: "home" });
ok(r.body.status === "subscribed" && (await sql`select count(*)::int c from newsletter_subscribers where email = 'nl1@comms.example'`)[0].c === 1, "subscribing again keeps one subscribed row");

let res = await noRedirect("/api/newsletter/unsubscribe", { method: "POST", body: new URLSearchParams({ token: row.unsubscribe_token }) });
ok(res.status === 303 && res.headers.get("location")?.includes("/newsletter/unsubscribe?done=1"), "unsubscribe POST redirects to the done page");
ok((await sql`select status from newsletter_subscribers where email = 'nl1@comms.example'`)[0].status === "unsubscribed", "unsubscribe works");
const withdrawal = (await sql`select * from consent_events where email = 'nl1@comms.example' and action = 'withdraw'`)[0];
ok(withdrawal?.channel === "email" && withdrawal.purpose === "updates" && withdrawal.source === "unsubscribe" && withdrawal.person_id !== null, "unsubscribe records a withdrawal in the consent ledger");
ok((await sql`select contact_consent_at from people where email = 'nl1@comms.example'`)[0].contact_consent_at === null, "unsubscribe clears the person's contact consent");
r = await post("/api/newsletter", { email: "nl1@comms.example", source: "home" });
ok(r.status === 200 && r.body.status === "unsubscribed", `re-subscribing an unsubscribed address returns "unsubscribed" (${JSON.stringify(r.body)})`);
ok((await sql`select status from newsletter_subscribers where email = 'nl1@comms.example'`)[0].status === "unsubscribed", "unsubscribed row is never flipped back by the form");

res = await noRedirect("/api/newsletter/unsubscribe?token=tok-sub1-e2e");
ok(res.status === 303 && res.headers.get("location")?.endsWith("/newsletter/unsubscribe?token=tok-sub1-e2e"), "GET unsubscribe link only shows the confirmation page");
ok((await sql`select status from newsletter_subscribers where email = 'sub1@comms.example'`)[0].status === "subscribed", "GET unsubscribe changes nothing");
let page = await (await fetch(BASE + "/newsletter/unsubscribe?token=tok-sub1-e2e")).text();
ok(page.includes("Unsubscribe me") && page.includes('value="tok-sub1-e2e"'), "unsubscribe page shows the button with the token");

res = await noRedirect("/api/newsletter/confirm?token=not-a-real-token");
ok(res.status === 303 && res.headers.get("location")?.includes("/newsletter/confirmed?invalid=1"), "a bad confirmation token redirects to the expired message");
page = await (await fetch(BASE + "/newsletter/confirmed?invalid=1")).text();
ok(page.includes("That link has expired"), "confirmed page explains an expired link");
page = await (await fetch(BASE + "/newsletter/confirmed")).text();
ok(page.includes("subscribed"), "confirmed page thanks the subscriber");

// ── Promise follows: the unfollow link ────────────────────────────────────
const promise = (await sql`select id from tracker_promises order by number limit 1`)[0];
await sql`insert into promise_follows (promise_id, email, token, confirmed_at) values (${promise.id}, 'sub1@comms.example', 'follow-tok-e2e', now())`;
res = await noRedirect("/api/newsletter/unfollow?token=follow-tok-e2e");
ok(res.status === 303 && res.headers.get("location")?.endsWith("/newsletter/unfollowed"), "unfollow link redirects to the confirmation page");
ok((await sql`select count(*)::int c from promise_follows where token = 'follow-tok-e2e'`)[0].c === 0, "unfollow deletes the follow");
res = await noRedirect("/api/newsletter/unfollow?token=follow-tok-e2e");
ok(res.headers.get("location")?.includes("missing=1"), "a used unfollow link says so");
page = await (await fetch(BASE + "/newsletter/unfollowed")).text();
ok(page.includes("stopped following"), "unfollowed page renders");

// ── Admin: the log, and no way to send bulk email or texts ───────────────
const browser = await chromium.launch();
const bp = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
bp.on("dialog", (d) => d.accept());
await adminLogin(bp);

await bp.goto(BASE + "/admin/comms");
ok((await bp.locator("h1").textContent())?.includes("Email & text log"), "Email & texts is the log");
ok((await bp.locator("[role=note]").textContent())?.includes("go out from base ground"), "it says newsletters and texts go out from base ground");
ok((await bp.locator(".stat").filter({ hasText: "Confirmed subscribers" }).locator(".value").textContent()) === String((await sql`select count(*)::int c from newsletter_subscribers where status='subscribed' and confirmed_at is not null`)[0].c), "stats show confirmed subscribers");
ok((await bp.getByRole("link", { name: /New email campaign|Send a text/ }).count()) === 0 && (await bp.locator("textarea, #c-subject, #sms-message").count()) === 0, "no composer and no text sender");
const cookie = (await bp.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
for (const path of ["/admin/comms/new", "/admin/comms/sms", "/admin/comms/00000000-0000-4000-8000-000000000000"]) {
  ok((await fetch(BASE + path, { headers: { cookie } })).status === 404, `${path} is gone`);
}
const [sentCampaign] = await sql`insert into email_campaigns (subject, preheader, body, audience, status, recipient_count, sent_count, failed_count, sent_at) values ('E2E earlier campaign', '', 'Hi', '{"lists":["newsletter"]}', 'sent', 2, 2, 0, now()) returning id`;
await bp.reload();
const earlier = bp.locator("section", { hasText: "Earlier campaigns" });
ok((await earlier.count()) === 1 && (await earlier.textContent()).includes("E2E earlier campaign") && (await earlier.locator("a, button").count()) === 0, "earlier campaigns are listed read-only");
ok(!(await earlier.textContent()).includes("What's happening in your neighbourhood"), "the seeded draft is not listed");
await sql`delete from email_campaigns where id = ${sentCampaign.id}`;

// ── RSVP confirmation (the public route calls notifyRsvp) ─────────────────
await sql`insert into events (slug, title, starts_at, location, summary) values ('comms-next-week', 'Next week meetup', now() + interval '7 days', 'Bear Creek Park', 'Come along.') on conflict (slug) do nothing`;
r = await post("/api/events/comms-next-week/rsvp", { name: "Rita Rsvp", email: "rsvp@comms.example", guests: 1 });
ok(r.status === 200, `RSVP accepted (${r.status} ${JSON.stringify(r.body)})`);
const rsvpMail = await eventually(async () => (await sql`select * from email_log where "to" = 'rsvp@comms.example' and kind = 'rsvp'`)[0], "rsvp email row");
ok(rsvpMail?.subject === "You're in: Next week meetup" && rsvpMail.text?.includes("Attachments: comms-next-week.ics") && rsvpMail.html.includes("calendar.google.com") && !rsvpMail.html.includes("Unsubscribe</a>"), "RSVP email logged with the calendar file noted and no unsubscribe link");

// ── Reminders cron ────────────────────────────────────────────────────────
await sql`insert into events (slug, title, starts_at, location, summary) values ('comms-tomorrow', 'Tomorrow rally', now() + interval '24 hours', 'Holland Park', 'Be there.') on conflict (slug) do update set starts_at = excluded.starts_at`;
const ev = (await sql`select id from events where slug = 'comms-tomorrow'`)[0];
await sql`insert into event_rsvps (event_id, person_id, name, email, guests) values (${ev.id}, ${sub1.id}, 'Sukh Gill', 'sub1@comms.example', 1)`;
const tomorrow = new Date(new Date(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver" }).format(new Date()) + "T00:00:00Z").getTime() + 86_400_000).toISOString().slice(0, 10);
await sql`insert into shifts (person_id, date, slot, status) values (${member.id}, ${tomorrow}, 'morning', 'scheduled')`;
r = await fetch(BASE + "/api/cron/reminders");
const cron = await r.json();
ok(r.status === 200 && cron.ok && cron.events >= 1 && cron.shifts >= 1 && cron.texts >= 2, `reminders cron reports its work (${JSON.stringify(cron)})`);
ok((await sql`select reminder_sent_at from event_rsvps where event_id = ${ev.id}`)[0].reminder_sent_at !== null, "RSVP for tomorrow's event marked reminded");
ok((await sql`select reminder_sent_at from shifts where person_id = ${member.id} and date = ${tomorrow}`)[0].reminder_sent_at !== null, "tomorrow's shift marked reminded");
const reminderEmails = await sql`select kind, status, subject from email_log where kind in ('event-reminder', 'shift-reminder') and "to" in ('sub1@comms.example', 'member@comms.example') order by kind`;
ok(reminderEmails.length === 2 && reminderEmails[0].subject === "Tomorrow: Tomorrow rally" && reminderEmails.every((e) => e.status === "skipped"), "reminder emails logged for the RSVP and the shift");
ok((await sql`select count(*)::int c from sms_log where kind in ('event-reminder', 'shift-reminder') and person_id in (${sub1.id}, ${member.id})`)[0].c === 2, "reminder texts logged for people with SMS consent");
ok((await sql`select count(*)::int c from email_log where "to" = 'rsvp@comms.example' and kind = 'event-reminder'`)[0].c === 0, "an event a week away gets no reminder yet");
r = await fetch(BASE + "/api/cron/reminders");
const again = await r.json();
ok(again.events === 0 && again.shifts === 0, "running the cron again sends nothing twice");

// ── Inbound texts (Twilio webhook) ────────────────────────────────────────
const inbound = async (body) => {
  const res = await fetch(BASE + "/api/sms/inbound", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ From: "+16045550101", To: "+16045550000", Body: body, MessageSid: `SM${Date.now()}` }) });
  return { status: res.status, type: res.headers.get("content-type") ?? "", text: await res.text() };
};
let t = await inbound("STOP");
ok(t.status === 200 && t.type.includes("text/xml") && t.text.includes("<Response><Message>") && t.text.includes("opted out"), `STOP gets a TwiML reply (${t.text})`);
ok((await sql`select sms_consent_at from people where email = 'sub1@comms.example'`)[0].sms_consent_at === null, "STOP clears the seeded person's SMS consent");
// Other suites may have stored the same test number on other people; STOP opts
// the number out for all of them and logs one inbound row for the number.
ok((await sql`select count(*)::int c from sms_log where kind = 'inbound-stop' and "to" = '+16045550101'`)[0].c === 1, "STOP is logged");
ok((await sql`select count(*)::int c from consent_events where person_id = ${sub1.id} and channel = 'sms' and action = 'withdraw' and source = 'sms-stop'`)[0].c === 1, "STOP records an SMS withdrawal in the consent ledger");
const stopRows = await sql`select * from base_ground_outbox where kind = 'consent' and payload->>'phone' = '+16045550101'`;
ok(stopRows.length === 1 && stopRows[0].endpoint === "/in/v1/consent" && stopRows[0].payload.channel === "sms" && stopRows[0].payload.reason === "stop" && stopRows[0].payload.action === "withdraw", "STOP is passed to base ground as a consent withdrawal for the number");
t = await inbound("START");
ok((await sql`select sms_consent_at from people where email = 'sub1@comms.example'`)[0].sms_consent_at !== null && t.text.includes("Reply STOP to opt out"), "START restores consent and the reply ends with the STOP line");
ok((await sql`select count(*)::int c from base_ground_outbox where kind = 'consent' and payload->>'phone' = '+16045550101'`)[0].c === 1, "START sends nothing to base ground (only withdrawals flow on their own)");
t = await inbound("Punjabi");
ok((await sql`select locale from people where email = 'sub1@comms.example'`)[0].locale === "pa" && t.text.includes("Punjabi"), "PUNJABI sets the locale and is acknowledged");
t = await inbound("HELP");
ok(t.text.includes("@") && t.text.includes("Reply STOP to opt out"), "HELP replies with contact details");
t = await inbound("JOIN");
ok(t.text.includes("/#join"), "JOIN replies with the join link");
t = await inbound("Is the meeting still on?");
ok(t.text.includes(BASE.replace(/^https?:\/\//, "")) || t.text.includes("localhost"), "other texts get a friendly reply with the website");

// ── Log and resend ────────────────────────────────────────────────────────
await sql`insert into email_log ("to", kind, subject, html, text, status, error, attempts) values ('fail@comms.example', 'rsvp', 'Failed once', '<p>Hello</p>', 'Hello', 'failed', 'Connection reset', 3)`;
await bp.goto(BASE + "/admin/comms/log?status=failed&q=fail%40comms");
ok(new URL(bp.url()).pathname === "/admin/comms" && new URL(bp.url()).searchParams.get("q") === "fail@comms", "an old link to the log lands on Email & texts with its filters");
ok((await bp.locator("table tbody tr").count()) === 1 && (await bp.locator("table").textContent())?.includes("Connection reset"), "log filters to the failed email and shows its error");
await activate("text=Resend");
await notice(/Queued/);
const copies = await eventually(async () => {
  const c = await sql`select status from email_log where "to" = 'fail@comms.example' order by created_at`;
  return c.length === 2 && c[1].status !== "queued" ? c : null;
}, "resent copy processed");
ok(copies?.length === 2 && copies[0].status === "failed" && copies[1].status === "skipped", "resend copies the row into the queue and the original stays failed");
await bp.goto(BASE + "/admin/comms?channel=sms&kind=inbound-stop");
ok((await bp.locator("table tbody tr").count()) === 1 && (await bp.locator("table").textContent())?.includes("Received: STOP"), "log shows inbound texts");

await browser.close();
await finish();
