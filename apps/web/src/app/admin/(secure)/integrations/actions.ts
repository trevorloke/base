"use server";

import { z } from "zod";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { esc, layout, paragraph, textVersion } from "@/lib/email/templates";
import { ActionError, adminAction } from "@/lib/server/actions";
import { sendEmail } from "@/lib/server/email";
import { getSettings } from "@/lib/server/settings";
import { normalizePhone, sendSms } from "@/lib/server/sms";
import { ping } from "@/lib/server/starbase";
import { deliverOutbox, retryOutboxRow, skipOutboxRow, type DeliveryReport } from "@/lib/server/starbase-outbox";
import { revalidatePath } from "next/cache";

/** A test message to the signed-in admin's own address, through the same path every site email takes. */
export const sendTestEmail = adminAction(
  "integrations",
  z.object({}),
  async (_d, { user }) => {
    const settings = await getSettings();
    const org = settings.org;
    const when = new Date().toLocaleString("en-CA", { timeZone: "America/Vancouver", dateStyle: "medium", timeStyle: "short" });
    const bodyHtml =
      paragraph(`This is a test from the ${esc(org.name)} admin, sent ${esc(when)} (Surrey time). If you're reading it, email sending works.`) +
      paragraph(`Sender: ${esc(env.emailFrom)}${env.emailReplyTo ? ` · Reply-to: ${esc(env.emailReplyTo)}` : ""}`);
    const result = await sendEmail(getDb(), {
      to: user.email,
      subject: `${org.name} test email`,
      html: layout({ title: "Test email", bodyHtml, siteUrl: env.siteUrl, orgName: org.name, orgEmail: org.email, reason: "Sent from the admin Integrations page." }),
      text: textVersion([`This is a test from the ${org.name} admin, sent ${when} (Surrey time).`, `Sender: ${env.emailFrom}`], { orgName: org.name }),
      kind: "test",
    });
    if (result.status === "sent") return `Sent to ${user.email}. Check your inbox (and the spam folder, the first time).`;
    if (result.status === "skipped") throw new ActionError("Email isn't configured: RESEND_API_KEY is not set, so the message was logged as skipped.");
    throw new ActionError(`The email provider refused the message: ${result.error ?? "unknown error"}`);
  },
  "integrations.test-email",
);

export const sendTestSms = adminAction(
  "integrations",
  z.object({ to: z.string().trim().min(7, "Enter a phone number.").max(30) }),
  async (d) => {
    if (!env.smsEnabled) throw new ActionError("Text messages aren't configured: set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM.");
    const to = normalizePhone(d.to);
    if (!to) throw new ActionError("Please check the highlighted fields.", { to: "Enter a Canadian phone number, like 604 555 0100." });
    const settings = await getSettings();
    const result = await sendSms(getDb(), { to, body: `Test text from the ${settings.org.name} admin. Texting works. Reply STOP to opt out`, kind: "test" });
    if (result.status === "sent") return `Sent to ${to}.`;
    throw new ActionError(`The text could not be sent: ${result.error ?? "unknown error"}`);
  },
  "integrations.test-sms",
);

// ── Starbase ("the desk") ─────────────────────────────────────────────────

function refreshStarbase() {
  revalidatePath("/admin/integrations");
  revalidatePath("/admin/integrations/starbase");
}

function describe(report: DeliveryReport): string {
  const parts = [`${report.sent} sent`];
  if (report.failed) parts.push(`${report.failed} refused`);
  if (report.retrying) parts.push(`${report.retrying} will be retried`);
  if (report.unsupported) parts.push("unsubscribes and STOPs still wait: this Starbase doesn't take them yet (/in/v1/consent)");
  return parts.join(", ");
}

/** GET /in/v1/ping with the configured key: which campaign and which key, or what is wrong. */
export const testStarbase = adminAction(
  "integrations",
  z.object({}),
  async () => {
    if (!env.starbaseEnabled) throw new ActionError("Starbase isn't configured: set STARBASE_URL and STARBASE_KEY.");
    const r = await ping();
    if (r.ok) return `Connected to ${r.campaign || "Starbase"} with the key “${r.key || "unnamed"}”.`;
    const hint = r.status === 401 ? " The key is wrong or was revoked: make a new one in Starbase → Settings → Services → Website keys." : "";
    throw new ActionError(`Starbase answered: ${r.status ? `${r.status} ` : ""}${r.error}.${hint}`);
  },
  "integrations.starbase-test",
);

/** Send every waiting sign-up now, whatever its backoff. */
export const sendStarbaseNow = adminAction(
  "integrations",
  z.object({}),
  async () => {
    if (!env.starbaseEnabled) throw new ActionError("Starbase isn't configured: set STARBASE_URL and STARBASE_KEY.");
    const report = await deliverOutbox(getDb(), 45_000, { ignoreBackoff: true });
    refreshStarbase();
    if (report.problem && report.sent === 0) throw new ActionError(`Nothing could be sent. ${report.problem}`);
    return `${describe(report)}.${report.problem ? ` Stopped: ${report.problem}` : ""}`;
  },
  "integrations.starbase-send",
);

const rowId = z.object({ id: z.uuid({ error: "Not an outbox id" }) });

/** A failed (or skipped) row back to pending with its attempts reset, then one try now. */
export const retryStarbaseRow = adminAction(
  "integrations",
  rowId,
  async ({ id }) => {
    const { row, report } = await retryOutboxRow(getDb(), id);
    refreshStarbase();
    if (!row) throw new ActionError("That row no longer exists.");
    if (row.status === "sent") return "Sent to Starbase.";
    if (!report) return row.status === "pending" ? "Queued again. It goes once Starbase is connected." : `Only failed or skipped rows can be retried (this one is ${row.status}).`;
    return `Queued again. ${row.lastError ? `Starbase answered: ${row.lastError}` : "It will be sent shortly."}`;
  },
  "integrations.starbase-retry",
);

/** Pending or failed → skipped: it will not be sent. */
export const skipStarbaseRow = adminAction(
  "integrations",
  rowId,
  async ({ id }) => {
    const skipped = await skipOutboxRow(getDb(), id);
    refreshStarbase();
    if (!skipped) throw new ActionError("Only pending or failed rows can be skipped.");
    return "Skipped: it won't be sent.";
  },
  "integrations.starbase-skip",
);
