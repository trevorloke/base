import type { Metadata } from "next";
import { SubmitButton } from "@/components/admin/SubmitButton";
import { requireMember } from "@/lib/server/member-auth";
import { DELETION_TAG } from "@/lib/server/portal";
import { getSettings } from "@/lib/server/settings";

export const metadata: Metadata = { title: "Your data", robots: { index: false } };

export default async function MyData({ searchParams }: PageProps<"/me/data">) {
  const person = await requireMember("/me/data");
  const sp = await searchParams;
  const { org } = await getSettings();
  const requested = sp.requested === "1" || person.tags.includes(DELETION_TAG);
  const failed = sp.requested === "failed";
  return (
    <>
      <h1>Your data</h1>
      <p className="portal-intro">
        British Columbia&apos;s Personal Information Protection Act gives you the right to see what we hold about you and to ask us to delete it. Both start here. Questions: <a href={`mailto:${org.email}`}>{org.email}</a>.
      </p>
      <div className="portal-grid">
        <section className="portal-card" aria-labelledby="export-h">
          <h2 id="export-h">Download my data</h2>
          <p>A file with your record, memberships, contributions, signatures, RSVPs, shifts, consent history and the subjects of emails we&apos;ve sent you. Nothing about anyone else.</p>
          <div className="portal-actions">
            <a href="/api/me/export" className="btn btn--primary btn--sm" download="my-imagine-surrey-data.json">
              Download my data (JSON)
            </a>
          </div>
        </section>
        <section className="portal-card" aria-labelledby="delete-h">
          <h2 id="delete-h">Delete my account</h2>
          {requested ? (
            <div role="status" className="alert alert--note">
              <span aria-hidden="true" className="alert-icon">
                ✓
              </span>
              <span>We&apos;ve received your request. We will confirm within 30 days. Some records, such as contribution receipts, must be kept for the period BC election law requires; we&apos;ll tell you what stays and why.</span>
            </div>
          ) : (
            <form method="post" action="/api/me/delete-request" className="stack" style={{ gap: 12 }}>
              <p>We&apos;ll remove your details and stop all contact. Contribution records that election law requires us to keep are the exception; we&apos;ll tell you exactly what stays.</p>
              {failed && (
                <div role="alert" className="alert">
                  <span aria-hidden="true" className="alert-icon">
                    !
                  </span>
                  <span>We couldn&apos;t record that just now. Please try again, or email {org.email}.</span>
                </div>
              )}
              <div>
                <SubmitButton className="btn btn--outline btn--sm" pendingText="Sending…" confirm="Ask us to delete your account? You'll stop hearing from us and lose your supporter home.">
                  Ask us to delete my account
                </SubmitButton>
              </div>
            </form>
          )}
        </section>
      </div>
    </>
  );
}
