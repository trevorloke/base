// base web is a product with Imagine Surrey as its first client: a new
// client's fresh deployment is a clean, neutral site, and Imagine Surrey's
// is exactly what it was. The client is fixed when the site is built
// (BASE_WEB_CLIENT), so each case loads the code afresh.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

async function load(client: string | undefined, orgName?: string) {
  vi.resetModules();
  vi.stubEnv("BASE_WEB_CLIENT", client ?? "");
  vi.stubEnv("BASE_WEB_ORG_NAME", orgName ?? "");
  return {
    settings: await import("@/lib/settings"),
    hoods: await import("@/lib/neighbourhoods"),
    validation: await import("@/lib/validation"),
    consent: await import("@/lib/consent-wording"),
    tracker: await import("@/content/tracker"),
    engagement: await import("@/lib/engagement"),
    client: await import("@/seeds/client"),
  };
}
afterEach(() => vi.unstubAllEnvs());

const SURREY = /Surrey|Imagine|McCallum|SkyTrain|Nagra|Safe Surrey|Kwantlen|Coast Salish|imaginesurrey/i;

describe("a new client's fresh deployment", () => {
  it("has neutral site copy, with no trace of Imagine Surrey", async () => {
    const { settings } = await load(undefined);
    const all = settings.defaultSettings();
    // Words people see, not internal ids such as the "skytrain" section key.
    expect(JSON.stringify({ ...all, homeModules: null }).replace(/"skytrain":/, "")).not.toMatch(SURREY);
    expect(all.org.name).toBe("Our organization");
    expect(all.hero.image.url).toBe("");
    expect(all.socials.accounts).toEqual([]);
    expect(all.footer.acknowledgement).toBe("");
  });
  it("takes its name from BASE_WEB_ORG_NAME before anything is saved", async () => {
    const { settings, consent, client } = await load("default", "Riverside Together");
    expect(settings.defaultSettings().org.name).toBe("Riverside Together");
    expect(settings.defaultSettings().seo.title).toBe("Riverside Together");
    expect(consent.CONSENT_WORDING.newsletter).toBe("Send me the Riverside Together newsletter. I can unsubscribe at any time.");
    expect(client.clientProfile.orgName).toBe("Riverside Together");
  });
  it("hides the modules built around Imagine Surrey's campaigns, board and shop", async () => {
    const { settings } = await load(undefined);
    const enabled = settings.defaultSettings().homeModules.modules.filter((m) => m.enabled).map((m) => m.kind);
    expect(enabled).toEqual(["hero", "actNow", "pillars", "news", "join", "donate", "organize", "events", "social"]);
  });
  it("has no neighbourhoods, so no neighbourhood field, pages or voting rule", async () => {
    const { hoods, validation } = await load(undefined);
    expect(hoods.HAS_NEIGHBOURHOODS).toBe(false);
    expect(hoods.NEIGHBOURHOOD_SLUGS).toEqual([]);
    expect(hoods.neighbourhoodForPostalCode("V3S 1A1")).toBeUndefined();
    expect(hoods.livesInPlace("", "Anywhere")).toBe(true);
    expect(hoods.choices(hoods.NEIGHBOURHOODS)).toEqual([""]);
    expect(validation.membershipSchema.shape.neighbourhood.safeParse(undefined).success).toBe(true);
  });
  it("tracks promises with neutral copy and skips the home page's pledge and petition", async () => {
    const { tracker, engagement } = await load(undefined);
    expect(JSON.stringify({ ...tracker, councilLetter: tracker.councilLetter({ number: 1, total: 2, title: "T", statusLabel: "Kept", dueLine: null, url: "u" }) })).not.toMatch(SURREY);
    expect(tracker.keyDates).toEqual([]);
    expect(engagement.CAMPAIGN_SLUGS).toEqual({ pledge: "", petition: "" });
  });
});

describe("Imagine Surrey's deployment", () => {
  it("keeps its copy, its six town centres, its tracker and its campaigns", async () => {
    const { settings, hoods, tracker, engagement, consent } = await load("imagine-surrey");
    const all = settings.defaultSettings();
    expect(all.org.name).toBe("Imagine Surrey");
    expect(all.org.email).toBe("hello@imaginesurrey.ca");
    expect(all.hero.image.url).toBe("/images/hero-park.jpg");
    expect(all.homeModules.modules.every((m) => m.enabled)).toBe(true);
    expect(all.stop.pledgeTitle).toBe("Stop Doug McCallum and Mandeep Nagra");
    expect(hoods.NEIGHBOURHOODS).toEqual(["Newton", "Whalley", "Fleetwood", "Cloverdale", "Guildford", "South Surrey"]);
    expect(hoods.neighbourhoodForPostalCode("v3s 1a1")).toBe("Cloverdale");
    expect(hoods.livesInPlace("Outside Surrey", "Surrey")).toBe(false);
    expect(hoods.livesInPlace("Newton", "Langley")).toBe(false);
    expect(hoods.livesInPlace("Newton", "surrey")).toBe(true);
    expect(tracker.trackerIntro.title).toBe("Safe Surrey promise tracker");
    expect(engagement.CAMPAIGN_SLUGS).toEqual({ pledge: "stop-mccallum-pledge", petition: "skytrain-south-surrey" });
    expect(consent.CONSENT_WORDING.updates).toBe("Yes, Imagine Surrey can email me news and ways to help. I can unsubscribe at any time.");
  });
  it("its saved sections still take its own copy for any field they lack", async () => {
    const { settings } = await load("imagine-surrey");
    expect(settings.parseSection("org", { name: "Imagine Surrey" }).platformLabel).toBe("Read the 2026 election platform");
  });
  it("every section of its copy is valid under the schemas", async () => {
    const { settings, client } = await load("imagine-surrey");
    for (const key of Object.keys(client.clientSettings)) expect(() => settings.parseSection(key as never, {})).not.toThrow();
  });
});

describe("product code", () => {
  // Files that are Imagine Surrey's own (its seed, its home-page SkyTrain
  // module, the public embed's global name) or that name it on purpose.
  const ALLOWED = [
    "src/seeds/",
    "src/components/Icons.tsx", // the SkyTrain map, shown only by Imagine Surrey's SkyTrain module
    "src/app/page.tsx", // the SkyTrain module's legend
    "src/components/tracker/EmbedPreview.tsx", // window.ImagineSurreyTracker, the embed's public API
    "src/lib/brand.ts", // the Imagine Surrey preset
    "src/lib/settings.ts", // an admin description naming Imagine Surrey's campaign section
    "src/lib/home-modules.ts", // the SkyTrain module's admin label
    "src/content/tracker.ts", // picks Imagine Surrey's tracker copy
  ];
  const root = path.resolve(import.meta.dirname, "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = path.join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(f)) files.push(path.relative(root, p));
    }
  };
  walk(path.join(root, "src"));
  it("names no client outside its seed (comments aside)", () => {
    const offenders = files
      .filter((f) => !ALLOWED.some((a) => f.startsWith(a)))
      .flatMap((f) =>
        readFileSync(path.join(root, f), "utf8")
          .split("\n")
          .map((line, i) => ({ f, i: i + 1, line }))
          .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line) && /Imagine Surrey|Safe Surrey|McCallum|"Surrey"|imaginesurrey\.ca/.test(line)),
      )
      .map(({ f, i, line }) => `${f}:${i}: ${line.trim().slice(0, 100)}`);
    expect(offenders).toEqual([]);
  });
});
