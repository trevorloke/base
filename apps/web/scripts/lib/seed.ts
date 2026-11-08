import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { contributionLimits, products, trackerAnnouncements, trackerPromises, volunteerTasks, campaigns } from "../../src/lib/db/schema";
import { JURISDICTIONS } from "../../src/lib/jurisdiction";
import { DEFAULT_TASKS } from "../../src/lib/shifts";
import { profile as defaultProfile } from "../../src/seeds/default/profile";
import { seedCampaigns } from "../../src/seeds/imagine-surrey/db/campaigns";
import { seed as seedComms } from "../../src/seeds/imagine-surrey/db/comms";
import { seed as seedOpenings } from "../../src/seeds/imagine-surrey/db/openings";
import { pagesFor, seed as seedPages } from "../../src/seeds/imagine-surrey/db/pages";
import { seedAnnouncements, seedPromises, seedTests } from "../../src/seeds/imagine-surrey/db/promises";
import { seed as seedTrackerDates } from "../../src/seeds/imagine-surrey/db/tracker";

// Imagine Surrey's shop as designed. Safe to re-run: existing products keep their prices.
const catalogue = [
  { slug: "stop-doug-lawn-sign", name: "Stop Doug lawn sign", priceCents: 2000, tileLabel: "Stop Doug", tileBackground: "#EF2023", tileForeground: "#FFFFFF" },
  { slug: "t-shirt", name: "Imagine Surrey T-shirt", priceCents: 3000, tileLabel: "Fighting for Surrey", tileBackground: "#003979", tileForeground: "#FFF100" },
  { slug: "button-3-pack", name: "Button 3-pack", priceCents: 1000, tileLabel: "Buttons", tileBackground: "#FFF100", tileForeground: "#003979" },
  { slug: "tote-bag", name: "Tote bag", priceCents: 2500, tileLabel: "Imagine Surrey", tileBackground: "#FFFFFF", tileForeground: "#003979" },
  { slug: "hoodie", name: "Imagine Surrey hoodie", priceCents: 5500, tileLabel: "Imagine Surrey", tileBackground: "#00285A", tileForeground: "#FFF100" },
  { slug: "window-sign", name: "Window sign", priceCents: 500, tileLabel: "SkyTrain to South Surrey", tileBackground: "#FFFFFF", tileForeground: "#EF2023" },
];

/**
 * Adds whatever starter rows are missing for the client this deployment is
 * for (BASE_WEB_CLIENT, read when it runs). Never overwrites anything changed
 * in /admin.
 *
 * Every client: the starter volunteer tasks, the jurisdiction's published
 * contribution limits, and draft privacy and accessibility pages.
 * Imagine Surrey also gets its shop, the Safe Surrey promise tracker, its
 * pledge and petition, sample shift openings and a sample draft email.
 */
export async function seedDatabase(url: string, client = process.env.BASE_WEB_CLIENT, jurisdictionId = process.env.BASE_WEB_JURISDICTION): Promise<string> {
  const imagineSurrey = client === "imagine-surrey";
  const jurisdiction = JURISDICTIONS[jurisdictionId ?? ""] ?? JURISDICTIONS.bc;
  // prepare: false so it also works through a transaction pooler.
  const pg = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  const db = drizzle(pg);
  try {
    // Starter volunteer tasks. Rename or recolour them in /admin/shifts.
    await db
      .insert(volunteerTasks)
      .values(DEFAULT_TASKS.map((t, i) => ({ ...t, sortOrder: i })))
      .onConflictDoNothing({ target: volunteerTasks.name });
    // The published contribution limits (BC: 2026, $1,429.70), unless a figure for that year is stored. Later years go in Admin → Contribution limits.
    const limits = Object.entries(jurisdiction.contributionLimits).map(([year, l]) => ({ year: Number(year), cents: l.cents, note: l.note }));
    if (limits.length) await db.insert(contributionLimits).values(limits).onConflictDoNothing({ target: contributionLimits.year });
    // Draft privacy policy and accessibility pages (only when missing).
    await seedPages(db, imagineSurrey ? undefined : pagesFor({ name: defaultProfile.orgName, email: defaultProfile.email, placeLine: defaultProfile.placeLine }));
    if (!imagineSurrey) return `Seeded ${DEFAULT_TASKS.length} volunteer tasks, ${limits.length} contribution limit(s) and the draft pages for a new client.`;

    await db
      .insert(products)
      .values(catalogue.map((p, i) => ({ ...p, sortOrder: i })))
      .onConflictDoNothing({ target: products.slug });
    // The promise tracker as first published. Existing rows are left alone, so
    // re-running never overwrites statuses set in /admin/tracker.
    await db
      .insert(trackerPromises)
      .values(
        seedPromises.map((p) => {
          const test = seedTests.find((t) => t.promises.includes(p.number));
          return { ...p, testKept: test?.kept, testPartly: test?.partly, testBroken: test?.broken, testRecord: test?.record };
        }),
      )
      .onConflictDoNothing({ target: trackerPromises.number });
    await db.insert(trackerAnnouncements).values(seedAnnouncements).onConflictDoNothing();
    // Dates and town centres for promises seeded before those columns existed.
    await seedTrackerDates(db);
    // Two sample shift openings next Saturday, only on an empty table.
    await seedOpenings(db);
    // One sample draft email campaign, only when there are none.
    await seedComms(db);
    // The pledge and petition the home page is built around.
    await db.insert(campaigns).values(seedCampaigns).onConflictDoNothing({ target: campaigns.slug });
    return `Seeded ${catalogue.length} products, ${DEFAULT_TASKS.length} volunteer tasks, ${seedPromises.length} tracked promises and ${seedCampaigns.length} campaigns.`;
  } finally {
    await pg.end();
  }
}
