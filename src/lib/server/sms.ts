import "server-only";
import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { smsLog } from "@/lib/db/schema";
import { env } from "@/lib/env";

/** Canadian numbers in any common format → E.164 (+1XXXXXXXXXX), or null. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export type OutgoingSms = { to: string; body: string; kind: string; personId?: string | null };

/**
 * Send a text through Twilio. Only call this for people with smsConsentAt
 * set (CASL express consent). Without Twilio keys the message is logged as
 * skipped. Every text should end with "Reply STOP to opt out".
 */
export async function sendSms(db: Db, sms: OutgoingSms): Promise<{ id: string; status: "sent" | "failed" | "skipped"; error?: string }> {
  const to = normalizePhone(sms.to);
  const [row] = await db
    .insert(smsLog)
    .values({ to: to ?? sms.to, body: sms.body, kind: sms.kind, personId: sms.personId ?? null })
    .returning({ id: smsLog.id });
  if (!to) {
    await db.update(smsLog).set({ status: "failed", error: "Not a valid Canadian phone number" }).where(eq(smsLog.id, row.id));
    return { id: row.id, status: "failed", error: "Not a valid Canadian phone number" };
  }
  if (!env.smsEnabled) {
    await db.update(smsLog).set({ status: "skipped", error: "Twilio is not configured" }).where(eq(smsLog.id, row.id));
    return { id: row.id, status: "skipped", error: "SMS is not configured" };
  }
  try {
    const from = env.twilioFrom!;
    const form = new URLSearchParams({ To: to, Body: sms.body, ...(from.startsWith("MG") ? { MessagingServiceSid: from } : { From: from }) });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.twilioAccountSid}/Messages.json`, {
      method: "POST",
      headers: { authorization: "Basic " + Buffer.from(`${env.twilioAccountSid}:${env.twilioAuthToken}`).toString("base64"), "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
    if (!res.ok) throw new Error(data.message ?? `Twilio responded ${res.status}`);
    await db.update(smsLog).set({ status: "sent", providerId: data.sid ?? null, sentAt: new Date() }).where(eq(smsLog.id, row.id));
    return { id: row.id, status: "sent" };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    await db.update(smsLog).set({ status: "failed", error: message }).where(eq(smsLog.id, row.id));
    return { id: row.id, status: "failed", error: message };
  }
}
