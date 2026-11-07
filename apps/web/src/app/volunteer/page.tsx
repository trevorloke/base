import "./volunteer.css";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { OpeningsBoard } from "@/components/volunteer/OpeningsBoard";
import { renderMarkdown } from "@/lib/markdown";
import { getSettings } from "@/lib/server/settings";
import { publishedOpenings } from "@/lib/server/volunteer";
import { todayInSurrey } from "@/lib/shifts";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Volunteer",
  description: "Pick a shift near you: door-knocking, phone banks, events and more. Sign up in one tap and get it in your calendar.",
};

export default async function VolunteerPage() {
  const [settings, openings] = await Promise.all([getSettings(), publishedOpenings(todayInSurrey())]);
  const notesHtml = Object.fromEntries(openings.filter((o) => o.notes).map((o) => [o.id, renderMarkdown(o.notes)]));
  const c = settings.committees;
  return (
    <>
      <PageHead title="Volunteer" eyebrow="A few hours, a lot of difference">
        {c.intro}
      </PageHead>
      <section className="section">
        <div className="container stack" style={{ gap: 36 }}>
          <div className="intro" style={{ maxWidth: 760 }}>
            <h2 className="display pop" style={{ fontSize: "clamp(32px, 4.4vw, 52px)" }}>
              Pick a shift
            </h2>
            <p className="lede">
              Every shift below has a place, a time and a few spots. Sign up, get it in your calendar, and bring a neighbour. Looking for something in
              your own part of Surrey? <Link href="/neighbourhoods">Find your neighbourhood</Link>.
            </p>
          </div>
          <OpeningsBoard openings={openings} notesHtml={notesHtml} />
        </div>
      </section>
      <section className="section section--surface">
        <div className="container split">
          <div className="stack" style={{ flex: "1 1 360px", gap: 12 }}>
            <h2 className="h3" style={{ margin: 0 }}>
              None of these times work?
            </h2>
            <p style={{ margin: 0, fontSize: 17, lineHeight: 1.55 }}>
              Join as a member and tick “Volunteering”. Organizers see who&apos;s willing and will find you a shift that fits.
            </p>
            <Link href="/#join" className="btn btn--primary" style={{ alignSelf: "flex-start" }}>
              Become a member
            </Link>
          </div>
          <div className="stack" style={{ flex: "1 1 360px", gap: 12 }}>
            <h2 className="h3" style={{ margin: 0 }}>
              {c.neighbourhoodsTitle}
            </h2>
            <p style={{ margin: 0, fontSize: 17, lineHeight: 1.55 }}>{c.neighbourhoodsIntro}</p>
            <Link href="/neighbourhoods" className="btn btn--outline" style={{ alignSelf: "flex-start" }}>
              Find your neighbourhood
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
