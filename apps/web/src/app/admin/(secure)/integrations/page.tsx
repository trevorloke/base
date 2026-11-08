import type { ReactNode } from "react";
import { AdminPage } from "@/components/admin/content/AdminPage";
import Link from "next/link";
import { BaseGroundForms, TestEmailForm, TestSmsForm } from "@/components/admin/content/IntegrationTests";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { requireAdmin } from "@/lib/server/admin-auth";
import { integrationStats } from "@/lib/server/content-admin";
import { NOT_SUPPORTED_YET, baseGroundUrlProblem } from "@/lib/server/base-ground";
import { localUploadProblem } from "@/lib/server/storage";
import { outboxStats } from "@/lib/server/base-ground-outbox";

type Tone = "ok" | "warn" | "off" | "bad";

function when(d: Date | null): string {
  return d ? d.toLocaleString("en-CA", { timeZone: "America/Vancouver", dateStyle: "medium", timeStyle: "short" }) : "never";
}

function Card({ title, tone, rows, env: vars, children }: { title: string; tone: Tone; rows: [string, ReactNode][]; env: string[]; children?: ReactNode }) {
  const label = { ok: "working", warn: "needs attention", off: "not configured", bad: "problem" }[tone];
  return (
    <section className="int-card" aria-label={title}>
      <h2>
        <span className={`status-dot status-dot--${tone}`} aria-hidden="true" />
        {title}
        <span className="visually-hidden">: {label}</span>
      </h2>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {children}
      <p className="int-env">
        Environment: {vars.map((v, i) => (
          <span key={v}>
            {i > 0 && ", "}
            <code>{v}</code>
          </span>
        ))}
      </p>
    </section>
  );
}

export default async function IntegrationsPage() {
  const user = await requireAdmin("integrations");
  const db = getDb();
  const [stats, desk] = await Promise.all([integrationStats(db), outboxStats(db)]);

  // Stripe getters throw when the keys are missing; show that instead of crashing.
  let stripeMode: string | null = null;
  try {
    stripeMode = env.stripeMode;
  } catch {
    stripeMode = null;
  }
  let webhookSet = false;
  try {
    webhookSet = Boolean(env.stripeWebhookSecret);
  } catch {
    webhookSet = false;
  }
  // Vercel's filesystem is read-only and Render's is wiped on every deploy, so
  // uploads there need Supabase Storage; storage.ts refuses them the same way.
  const diskHost = env.ephemeralDiskHost;
  const uploadProblem = localUploadProblem();
  // A live host (Vercel or Render) needs the scheduled jobs and the human check.
  const hosted = diskHost !== null;
  const analytics = env.plausibleDomain ? `Plausible (${env.plausibleDomain})` : env.gaMeasurementId ? `Google Analytics (${env.gaMeasurementId})` : null;
  const queueStale = stats.email.oldestQueuedAt ? Date.now() - stats.email.oldestQueuedAt.getTime() > 10 * 60_000 : false;

  // Base Ground: the key is shown only by the first characters Base Ground lists it by.
  const baseGroundOn = env.baseGroundEnabled;
  const baseGroundUrlIssue = baseGroundOn ? baseGroundUrlProblem(env.baseGroundUrl) : null;
  const deskError = desk.lastError;
  const inboundOn = Boolean(env.baseGroundInboundKey);
  const keyRefused = Boolean(deskError && desk.counts.pending > 0 && /^(401|403|404):/.test(deskError.message));
  const baseGroundTone: Tone = !baseGroundOn ? "off" : baseGroundUrlIssue || keyRefused ? "bad" : desk.counts.failed > 0 || (deskError && desk.counts.pending > 0) ? "warn" : "ok";
  const humanKeys = [env.turnstileSiteKey, env.turnstileSecretKey].filter(Boolean).length;

  return (
    <AdminPage title="Integrations" intro="What is connected, what is not, and the environment variables that control each one. Keys are set in the hosting dashboard, never here.">
      <div className="int-cards">
        <Card
          title="Stripe"
          tone={!stripeMode ? "off" : !webhookSet ? "warn" : "ok"}
          rows={[
            ["Mode", stripeMode ? (stripeMode === "live" ? "Live (real payments)" : "Test") : "Not configured"],
            ["Webhook secret", webhookSet ? "Set" : "Missing: payments won't be recorded"],
            ["Last webhook event", when(stats.stripe.lastEventAt)],
            ["Events processed", String(stats.stripe.total)],
          ]}
          env={["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "CONTRIBUTION_LIMIT_CENTS", "MEMBERSHIP_FEE_CENTS"]}
        />
        <Card
          title="Email"
          tone={!env.emailEnabled ? "off" : stats.email.failed7d > 0 && stats.email.sent7d === 0 ? "bad" : stats.email.failed7d > 0 ? "warn" : "ok"}
          rows={[
            ["Provider", env.emailEnabled ? "Resend, configured" : "Not configured: messages are logged as skipped"],
            ["From", env.emailFrom],
            ["Reply-to", env.emailReplyTo ?? "same as From"],
            ["Sent, last 7 days", String(stats.email.sent7d)],
            ["Failed or skipped, last 7 days", String(stats.email.failed7d)],
            ["Waiting in the queue", String(stats.email.queued)],
          ]}
          env={["RESEND_API_KEY", "EMAIL_FROM", "EMAIL_REPLY_TO"]}
        >
          <TestEmailForm to={user.email} />
        </Card>
        <Card
          title="Text messages"
          tone={env.smsEnabled ? "ok" : "off"}
          rows={[
            ["Provider", env.smsEnabled ? "Twilio, configured" : "Not configured: texts are logged as skipped"],
            ["From", env.twilioFrom ?? "—"],
          ]}
          env={["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM"]}
        >
          {env.smsEnabled ? <TestSmsForm /> : <p className="small">Set the three Twilio variables to enable texting and the test button.</p>}
        </Card>
        <Card
          title="Image storage"
          tone={env.storageEnabled ? "ok" : uploadProblem ? "bad" : "warn"}
          rows={[
            [
              "Provider",
              env.storageEnabled ? `Supabase Storage, bucket "${env.mediaBucket}"` : diskHost ? `Not configured: uploads are refused on ${diskHost}` : "Not configured: uploads go to public/uploads on this machine",
            ],
          ]}
          env={["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_MEDIA_BUCKET"]}
        >
          {uploadProblem && (
            <p className="small" style={{ color: "var(--accent-hover)", fontWeight: 700 }}>
              {uploadProblem} Create a public bucket in Supabase first.
            </p>
          )}
        </Card>
        <Card
          title="Base Ground (the desk)"
          tone={baseGroundTone}
          rows={[
            ["Connection", baseGroundOn ? (baseGroundUrlIssue ?? `Configured: ${env.baseGroundUrl}`) : "Not configured: sign-ups are kept here as skipped and not sent"],
            ["Website key", env.baseGroundKey ? `Set (${env.baseGroundKey.slice(0, 10)}…)` : "Not set"],
            ["Waiting to send", String(desk.counts.pending)],
            ["Sent", `${desk.counts.sent}${desk.lastSentAt ? ` (last ${when(desk.lastSentAt)})` : ""}`],
            ["Refused by Base Ground", String(desk.counts.failed)],
            ["Skipped", String(desk.counts.skipped)],
            [
              "Unsubscribes and STOPs to Base Ground",
              desk.consent.notSupported > 0 ? (
                <span style={{ fontWeight: 700 }}>
                  {desk.consent.notSupported} waiting: {NOT_SUPPORTED_YET.toLowerCase()} (this Base Ground has no /in/v1/consent). They go once it does.
                </span>
              ) : desk.consent.pending > 0 ? (
                `${desk.consent.pending} waiting, ${desk.consent.sent} sent`
              ) : (
                `${desk.consent.sent} sent`
              ),
            ],
            ["Unsubscribes from Base Ground", inboundOn ? "On: Base Ground can withdraw consent here (POST /api/in/consent)" : "Off: BASE_GROUND_INBOUND_KEY isn't set"],
            [
              "Last problem",
              deskError ? (
                <span style={keyRefused ? { color: "var(--accent-hover)", fontWeight: 700 } : undefined}>
                  {deskError.message} ({when(deskError.at)}){keyRefused ? ". Check the key: sign-ups are waiting until it works." : ""}
                </span>
              ) : (
                "none"
              ),
            ],
          ]}
          env={["BASE_GROUND_URL", "BASE_GROUND_KEY", "BASE_GROUND_INBOUND_KEY"]}
        >
          <p className="small">
            New sign-ups (petitions, pledges, the newsletter, volunteer shifts, memberships, deletion requests), edits in the supporter portal, and tags for RSVPs, paid
            orders and promise follows are sent from this server, and so is every unsubscribe and text STOP. Money never is: no donation, fee or order amount.{" "}
            <Link href="/admin/integrations/base-ground">See everything sent</Link>
            {" · "}
            <Link href="/admin/desk-gifts">Gifts to log at the desk</Link>
          </p>
          {baseGroundOn && <BaseGroundForms waiting={desk.counts.pending} />}
        </Card>
        <Card
          title="Human check (Cloudflare Turnstile)"
          tone={env.humanCheckEnabled ? "ok" : hosted ? "bad" : "warn"}
          rows={[
            [
              "Status",
              env.humanCheckEnabled
                ? "On: sign-up, RSVP, follow, sign-in and preference-link forms must pass it"
                : humanKeys === 1
                  ? "Off: only one of the two keys is set"
                  : "Off: public forms rely on the honeypot and rate limits only",
            ],
            ["Checked by", env.turnstileVerifyUrl],
          ]}
          env={["NEXT_PUBLIC_TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY", "TURNSTILE_VERIFY_URL"]}
        >
          {!env.humanCheckEnabled && (
            <p className="small" style={{ color: "var(--accent-hover)", fontWeight: 700 }}>
              The live site should have this on: every accepted sign-up becomes a supporter record here and in Base Ground, and can file a request for the desk. Make a free
              Turnstile widget in Cloudflare and set both keys.
            </p>
          )}
        </Card>
        <Card title="Analytics" tone={analytics ? "ok" : "off"} rows={[["Service", analytics ?? "None"]]} env={["NEXT_PUBLIC_PLAUSIBLE_DOMAIN", "NEXT_PUBLIC_GA_MEASUREMENT_ID"]} />
        <Card
          title="Scheduled jobs"
          tone={!env.cronSecret ? (hosted ? "bad" : "warn") : queueStale ? "warn" : "ok"}
          rows={[
            ["Cron secret", env.cronSecret ? "Set" : hosted ? "Missing: set it for the daily jobs" : "Not set (fine locally)"],
            ["Email job last sent", when(stats.email.lastCronAt)],
            ["Oldest queued email", stats.email.oldestQueuedAt ? `${when(stats.email.oldestQueuedAt)}${queueStale ? " (waiting too long: is the cron job running?)" : ""}` : "nothing waiting"],
          ]}
          env={["CRON_SECRET"]}
        />
        <Card
          title="Database"
          tone={stats.database.ok ? "ok" : "bad"}
          rows={[
            ["Connection", stats.database.ok ? "OK" : `Problem: ${stats.database.error ?? "unknown"}`],
            ["Migrations applied", stats.database.migrations === null ? "unknown" : String(stats.database.migrations)],
          ]}
          env={["DATABASE_URL"]}
        />
        <Card title="Site" tone="ok" rows={[["Public address", env.siteUrl]]} env={["NEXT_PUBLIC_SITE_URL", "ADMIN_SESSION_SECRET", "ADMIN_EMAIL", "ADMIN_PASSWORD"]} />
      </div>
    </AdminPage>
  );
}
