import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAdminAccount, PENDING_COOKIE } from "@/lib/server/admin-auth";

export const metadata: Metadata = { title: "Two-factor sign in", robots: { index: false } };

/** The second sign-in step for accounts with two-factor sign-in on. */
export default async function VerifySignIn({ searchParams }: PageProps<"/admin/login/verify">) {
  if (await getAdminAccount()) redirect("/admin");
  if (!(await cookies()).get(PENDING_COOKIE)?.value) redirect("/admin/login?error=expired");
  const sp = await searchParams;
  const wrong = sp.error === "code";

  return (
    <section className="section section--surface">
      <div className="container stack" style={{ maxWidth: 440, gap: 20 }}>
        <h1 className="h3" style={{ fontSize: 26 }}>
          Enter your code
        </h1>
        {wrong && (
          <div role="alert" className="alert">
            <span aria-hidden="true" className="alert-icon">
              !
            </span>
            <span>That code didn&apos;t work. Codes change every 30 seconds, and each one works once: use the newest code in your app, or one of your recovery codes.</span>
          </div>
        )}
        <form method="post" action="/api/admin/login/verify" className="form-card">
          <div className="field">
            <label htmlFor="code">Code from your authenticator app</label>
            <p id="code-hint" className="small" style={{ margin: 0 }}>
              The 6-digit code for Imagine Surrey. Lost your phone? Type one of your recovery codes instead.
            </p>
            <input
              id="code"
              name="code"
              type="text"
              className="input"
              required
              autoComplete="one-time-code"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={40}
              aria-describedby="code-hint"
              aria-invalid={wrong || undefined}
              autoFocus
            />
          </div>
          <button type="submit" className="btn btn--navy btn--lg">
            Sign in
          </button>
        </form>
        <p className="small">
          This step stays open for 10 minutes. <Link href="/admin/login">Start again</Link>
        </p>
      </div>
    </section>
  );
}
