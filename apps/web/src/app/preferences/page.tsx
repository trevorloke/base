import type { Metadata } from "next";
import { PageHead } from "@/components/PageHead";
import { getDb } from "@/lib/db";
import { PreferencesForm } from "./PreferencesForm";
import { RequestLinkForm } from "./RequestLinkForm";
import { peekPreferencesToken, preferenceState } from "./server";
import "./preferences.css";

export const metadata: Metadata = { title: "Your preferences", description: "Choose what Imagine Surrey sends you.", robots: { index: false } };

/**
 * The preference centre. With a valid one-time token (from an email footer's
 * "manage preferences" link or the request form) it shows the person's current
 * choices; without one it offers to email a link.
 */
export default async function PreferencesPage({ searchParams }: PageProps<"/preferences">) {
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : "";
  const db = getDb();
  const peek = token ? await peekPreferencesToken(db, token) : null;
  const state = peek ? await preferenceState(db, peek.email) : null;

  return (
    <>
      <PageHead title="Your preferences">Choose what Imagine Surrey sends you: email updates, texts, and the language you prefer.</PageHead>
      <section className="section">
        <div className="container prefs-container">
          {state ? <PreferencesForm token={token} initial={state} /> : <RequestLinkForm expired={Boolean(token)} />}
        </div>
      </section>
    </>
  );
}
