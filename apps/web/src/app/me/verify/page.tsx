import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { safeMemberNext } from "@/lib/engagement";

export const metadata: Metadata = { title: "Sign in", robots: { index: false }, referrer: "same-origin" };

/**
 * Where the emailed sign-in link lands. Nothing happens until the person
 * presses the button: mail scanners that open links cannot use up the token,
 * and another site cannot sign a visitor into someone else's account.
 */
export default async function MemberVerify({ searchParams }: PageProps<"/me/verify">) {
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token.slice(0, 200) : "";
  const next = safeMemberNext(sp.next);
  return (
    <>
      <PageHead title="Your supporter home">One more step: press the button to sign in on this device.</PageHead>
      <section className="section section--surface">
        <div className="container stack" style={{ maxWidth: 520, gap: 20 }}>
          {token ? (
            <form method="post" action="/api/me/verify" className="form-card">
              <input type="hidden" name="token" value={token} />
              <input type="hidden" name="next" value={next} />
              <p>The link works once and lasts 30 minutes from when we sent it.</p>
              <div>
                <button type="submit" className="btn btn--red btn--lg">
                  Sign in
                </button>
              </div>
            </form>
          ) : (
            <div role="alert" className="alert">
              <span aria-hidden="true" className="alert-icon">
                !
              </span>
              <span>
                This link is incomplete. <Link href="/me/login">Ask for a new sign-in link</Link>.
              </span>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
