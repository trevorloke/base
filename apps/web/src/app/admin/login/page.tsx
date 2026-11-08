import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import "@/components/admin/base-suite.css";
import { env } from "@/lib/env";
import { getAdminAccount } from "@/lib/server/admin-auth";
import { LOGIN_EMAIL_COOKIE } from "@/lib/server/admin-redirect";

export const metadata: Metadata = { title: "Admin sign in", robots: { index: false } };

const MESSAGES: Record<string, { tone: "error" | "note"; text: string }> = {
  invalid: { tone: "error", text: "That email and password don't match." },
  locked: { tone: "error", text: "Too many attempts. Try again in 15 minutes, or use an email link." },
  link: { tone: "error", text: "That sign-in link has expired or was already used. Ask for a new one." },
  expired: { tone: "error", text: "The code step timed out or was already used. Sign in again." },
  "email-not-configured": { tone: "error", text: "Email sending isn't set up yet, so sign-in links can't be sent. Use your password." },
  sent: { tone: "note", text: "If that address belongs to a staff account, a sign-in link is on its way. It works once and expires in 20 minutes." },
  signedout: { tone: "note", text: "You're signed out." },
  setup: { tone: "error", text: "Sign-in couldn't finish because the site isn't fully set up. See the note below." },
  "base-not-configured": { tone: "error", text: "Signing in with Base isn't set up on this site. Use your email and password, or an email link." },
  "base-state": { tone: "error", text: "That sign-in with Base took too long or was started in another tab. Try again." },
  "base-denied": { tone: "error", text: "Base didn't sign you in here. Try again, or use your email and password." },
  "base-refused": { tone: "error", text: "Base couldn't confirm who you are (the sign-in may have been used already). Try again." },
  "base-unreachable": { tone: "error", text: "Base didn't answer. Try again in a moment, or use your email and password." },
  "base-inactive": { tone: "error", text: "The Base Web staff account linked to your Base Ground login is deactivated. Ask an owner." },
  "base-linked-elsewhere": {
    tone: "error",
    text: "That Base Web staff account is already linked to a different Base Ground login. Sign in with your email and password, or ask an owner to remove the old link under Staff.",
  },
  "base-link-expired": { tone: "error", text: "Linking your Base Ground login took too long or was already finished. Sign in with Base again." },
  "base-link-other-browser": { tone: "error", text: "Open the emailed link in the browser where you signed in with Base. If you didn't ask for it, ignore it and tell an owner." },
};

/**
 * Settings the host must have for staff sign-in to work. Only names are
 * shown, never values, so a missing one is fixed in minutes instead of
 * surfacing as a bare "500" after the right password.
 */
function setupProblems(): string[] {
  const problems: string[] = [];
  const secret = process.env.ADMIN_SESSION_SECRET ?? "";
  if (secret.length < 16) problems.push("ADMIN_SESSION_SECRET is missing or too short. Set it to a long random string (Render: Environment → Add → Generate), then redeploy.");
  if (!process.env.DATABASE_URL) problems.push("DATABASE_URL is missing.");
  return problems;
}

export default async function AdminLogin({ searchParams }: PageProps<"/admin/login">) {
  // Signed in already (including someone who still has to set up two-factor sign-in).
  if (await getAdminAccount()) redirect("/admin");
  const sp = await searchParams;
  // Set by the sign-in routes for this page only (never carried in the URL).
  const email = ((await cookies()).get(LOGIN_EMAIL_COOKIE)?.value ?? "").slice(0, 320);
  const message =
    sp.error === "base-no-account"
      ? { tone: "error" as const, text: `No Base Web staff account for ${email || "that email"} — ask an owner to invite you.` }
      : MESSAGES[typeof sp.error === "string" ? sp.error : typeof sp.sent === "string" ? "sent" : typeof sp.signedout === "string" ? "signedout" : ""];
  const next = typeof sp.next === "string" && /^\/admin(\/|$)/.test(sp.next) ? sp.next : "/admin";
  const baseOn = env.baseSsoEnabled;
  const problems = setupProblems();

  return (
    <section className="section section--surface">
      <div className="container stack" style={{ maxWidth: 440, gap: 20 }}>
        <h1 className="h3" style={{ fontSize: 26 }}>
          Staff sign in
        </h1>
        {message && (
          <div role={message.tone === "error" ? "alert" : "status"} className={`alert ${message.tone === "note" ? "alert--note" : ""}`}>
            <span aria-hidden="true" className="alert-icon">
              !
            </span>
            <span>{message.text}</span>
          </div>
        )}
        {problems.length > 0 && (
          <div role="alert" className="alert">
            <span aria-hidden="true" className="alert-icon">
              !
            </span>
            <span>
              Staff sign-in isn&apos;t set up on this site yet. {problems.join(" ")}
            </span>
          </div>
        )}
        {baseOn && (
          <div className="form-card" style={{ gap: 10 }}>
            <a href={`/auth/base?next=${encodeURIComponent(next)}`} className="btn btn--primary btn--lg base-signin">
              <span className="base-wordmark" aria-hidden="true">
                Base
              </span>
              Sign in with Base
            </a>
            <p className="small" style={{ margin: 0 }}>
              Signed in to Base Ground already? This opens the admin with your linked staff account. The first time, you confirm once that the account is yours.
            </p>
          </div>
        )}
        <form method="post" action="/api/admin/login" className="form-card">
          <input type="hidden" name="next" value={next} />
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" className="input" required autoComplete="username" defaultValue={email} />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input id="password" name="password" type="password" className="input" required autoComplete="current-password" />
          </div>
          <button type="submit" className="btn btn--primary btn--lg">
            Sign in
          </button>
        </form>
        <form method="post" action="/api/admin/magic-link" className="form-card" style={{ gap: 12 }}>
          <input type="hidden" name="next" value={next} />
          <p style={{ margin: 0, fontWeight: 700, color: "var(--primary)" }}>Or get a sign-in link by email</p>
          <div className="field">
            <label htmlFor="link-email">Email</label>
            <input id="link-email" name="email" type="email" className="input" required autoComplete="username" defaultValue={email} />
          </div>
          <button type="submit" className="btn btn--outline">
            Email me a link
          </button>
        </form>
      </div>
    </section>
  );
}
