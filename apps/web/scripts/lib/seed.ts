import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { campaigns, contributionLimits, products, trackerAnnouncements, trackerPromises, volunteerTasks } from "../../src/lib/db/schema";
import { seedCampaigns } from "../../src/content/campaigns-seed";
import { seedAnnouncements, seedPromises, seedTests } from "../../src/content/tracker-seed";
import { DEFAULT_TASKS } from "../../src/lib/shifts";
import { seed as seedOpenings } from "../../src/content/seeds/openings";
import { seed as seedTrackerDates } from "../../src/content/seeds/tracker";
import { seed as seedComms } from "../../src/content/seeds/comms";
import { seed as seedPages } from "../../src/content/seeds/pages";


// The shop as designed. Safe to re-run: existing products keep their prices.
const catalogue = [
  { slug: "stop-doug-lawn-sign", name: "Stop Doug lawn sign", priceCents: 2000, tileLabel: "Stop Doug", tileBackground: "#EF2023", tileForeground: "#FFFFFF" },
  { slug: "t-shirt", name: "Imagine Surrey T-shirt", priceCents: 3000, tileLabel: "Fighting for Surrey", tileBackground: "#003979", tileForeground: "#FFF100" },
  { slug: "button-3-pack", name: "Button 3-pack", priceCents: 1000, tileLabel: "Buttons", tileBackground: "#FFF100", tileForeground: "#003979" },
  { slug: "tote-bag", name: "Tote bag", priceCents: 2500, tileLabel: "Imagine Surrey", tileBackground: "#FFFFFF", tileForeground: "#003979" },
  { slug: "hoodie", name: "Imagine Surrey hoodie", priceCents: 5500, tileLabel: "Imagine Surrey", tileBackground: "#00285A", tileForeground: "#FFF100" },
  { slug: "window-sign", name: "Window sign", priceCents: 500, tileLabel: "SkyTrain to South Surrey", tileBackground: "#FFFFFF", tileForeground: "#EF2023" },
];

/** Adds whatever starter rows are missing. Never overwrites anything changed in /admin. */
export async function seedDatabase(url: string): Promise<string> {
  // prepare: false so it also works through a transaction pooler.
  const client = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  const db = drizzle(client);
  try {
    await db
      .insert(products)
      .values(catalogue.map((p, i) => ({ ...p, sortOrder: i })))
      .onConflictDoNothing({ target: products.slug });
    // Starter volunteer tasks. Rename or recolour them in /admin/shifts.
    await db
      .insert(volunteerTasks)
      .values(DEFAULT_TASKS.map((t, i) => ({ ...t, sortOrder: i })))
      .onConflictDoNothing({ target: volunteerTasks.name });
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
    // Draft privacy policy and accessibility pages (only when missing).
    await seedPages(db);
    // The pledge and petition the home page is built around.
    await db.insert(campaigns).values(seedCampaigns).onConflictDoNothing({ target: campaigns.slug });
    // The 2026 BC contribution limit ($1,429.70), unless a 2026 figure is already stored. Later years go in Admin → Contribution limits.
    await db.insert(contributionLimits).values({ year: 2026, cents: 142970, note: "Elections BC, 2026 local elections contribution limit" }).onConflictDoNothing({ target: contributionLimits.year });
    return `Seeded ${catalogue.length} products, ${DEFAULT_TASKS.length} volunteer tasks, ${seedPromises.length} tracked promises and ${seedCampaigns.length} campaigns.`;
  } finally {
    await client.end();
  }
}
