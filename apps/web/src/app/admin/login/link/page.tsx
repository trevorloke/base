import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { getAdminAccount, LOCK_WINDOW_MINUTES } from "@/lib/server/admin-auth";
import { LINK_COOKIE, readPendingLink } from "@/lib/server/base-link";

export const metadata: Metadata = { title: "Link your Base Ground login", robots: { index: false } };
export const dynamic = "force-dynamic";

const MESSAGES: Record<string, { tone: "error" | "note"; text: string }> = {
  invalid: { tone: "error", text: "That password doesn't match this staff account. Try again, or get a link by email." },
  locked: { tone: "error", text: `Too many attempts. Try again in ${LOCK_WINDOW_MINUTES} minutes, or get a link by email.` },
  "no-password": { tone: "error", text: "This staff account has no password yet. Get a link by email instead." },
  link: { tone: "error", text: "That emailed link has expired or was already used. Ask for a new one below." },
  sent: { tone: "note", text: "A link is on its way to the staff account's address. Open it in this browser; it works once." },
  "email-not-configured": { tone: "error", text: "Email sending isn't set up on this site, so a link can't be sent. Use the account's password." },
  failed: { tone: "error", text: "The email couldn't be sent. Try again in a moment, or use the account's password." },
  setup: { tone: "error", text: "Something went wrong on our side. Try again in a moment." },
};

/**
 * The first "Sign in with Base" for a staff account (SUITE.md, "The
 * hand-off", step 6): Base Ground vouched for an email, and the person now
 * proves the staff account with that email is theirs, once, with its
 * password or an emailed link. The verified hand-off waits on the server;
 * this browser holds only a signed cookie naming it.
 */
export default async function LinkBaseLogin({ searchParams }: PageProps<"/admin/login/link">) {
  if (await getAdminAccount()) redirect("/admin");
  const pending = await readPendingLink(getDb(), (await cookies()).get(LINK_COOKIE)?.value);
  if (!pending) redirect("/admin/login?error=base-link-expired");
  const sp = await searchParams;
  const key = typeof sp.error === "string" ? sp.error : typeof sp.sent === "string" ? "sent" : "";
  const message = MESSAGES[key];
  const { account, data } = pending;
  const minutesLeft = Math.max(1, Math.round((pending.expiresAt.getTime() - Date.now()) / 60_000));

  return (
    <section className="section section--surface">
      <div className="container stack" style={{ maxWidth: 480, gap: 20 }}>
        <h1 className="h3" style={{ fontSize: 26 }}>
          Link your Base Ground login
        </h1>
        <p style={{ margin: 0 }}>
          Base Ground signed you in{data.groundEmail ? ` as ${data.groundEmail}` : ""}. To open this admin with Base from now on, show once that the staff account <strong>{account.email}</strong> is yours.
        </p>
        {message && (
          <div role={message.tone === "error" ? "alert" : "status"} className={`alert ${message.tone === "note" ? "alert--note" : ""}`}>
            <span aria-hidden="true" className="alert-icon">
              !
            </span>
            <span>{message.text}</span>
          </div>
        )}
        {account.passwordSet && (
          <form method="post" action="/api/admin/base-link" className="form-card">
            <input type="hidden" name="username" value={account.email} autoComplete="username" />
            <div className="field">
              <label htmlFor="password">This staff account&apos;s password</label>
              <input id="password" name="password" type="password" className="input" required maxLength={200} autoComplete="current-password" aria-invalid={key === "invalid" || undefined} autoFocus />
            </div>
            <button type="submit" className="btn btn--primary btn--lg">
              Link and sign in
            </button>
          </form>
        )}
        {env.emailEnabled && (
          <form method="post" action="/api/admin/base-link/email" className="form-card" style={{ gap: 12 }}>
            <p style={{ margin: 0, fontWeight: 700, color: "var(--primary)" }}>{account.passwordSet ? "Or get a link by email" : "Get a link by email"}</p>
            <p className="small" style={{ margin: 0 }}>
              We&apos;ll send a one-time link to {account.email}. Open it in this browser.
            </p>
            <button type="submit" className={`btn ${account.passwordSet ? "btn--outline" : "btn--primary btn--lg"}`}>
              Email me a link
            </button>
          </form>
        )}
        {!account.passwordSet && !env.emailEnabled && (
          <div role="alert" className="alert">
            <span aria-hidden="true" className="alert-icon">
              !
            </span>
            <span>This staff account has no password and email isn&apos;t set up, so it can&apos;t be linked yet. Ask an owner to reset its password.</span>
          </div>
        )}
        <p className="small">
          Owners and administrators still give their authenticator code afterwards. This step stays open for {minutesLeft} more minute{minutesLeft === 1 ? "" : "s"}. <Link href="/admin/login">Sign in another way</Link>
        </p>
      </div>
    </section>
  );
}
