import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageHead } from "@/components/PageHead";
import { safeMemberNext } from "@/lib/engagement";
import { getMember } from "@/lib/server/member-auth";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Sign in", robots: { index: false } };

export default async function MemberLogin({ searchParams }: PageProps<"/me/login">) {
  const sp = await searchParams;
  const next = safeMemberNext(sp.next);
  if (await getMember()) redirect(next);
  const expired = sp.error === "expired";
  return (
    <>
      <PageHead title="Your supporter home">Sign in with a link we email you. There is no password to remember.</PageHead>
      <section className="section section--surface">
        <div className="container stack" style={{ maxWidth: 520, gap: 20 }}>
          {expired && (
            <div role="alert" className="alert">
              <span aria-hidden="true" className="alert-icon">
                !
              </span>
              <span>That sign-in link has expired or was already used. Ask for a new one below.</span>
            </div>
          )}
          <LoginForm next={next} />
          <p className="small">
            Your home shows your membership, what you&apos;ve given this year, your shifts and events, and your personal link for bringing a neighbour in. You can also download or ask us to delete your data.
          </p>
        </div>
      </section>
    </>
  );
}
