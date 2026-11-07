import { describe, expect, it } from "vitest";
import { keyDates, councilLetter, methodology } from "@/content/tracker";
import { seedAnnouncements, seedPromises, seedTests } from "@/content/tracker-seed";
import { NEIGHBOURHOODS } from "@/lib/neighbourhoods";
import { buildRss, countByStatus, daysBetween, dueInfo, dueInfoAt, escapeXml, neighbourhoodHref, noonInSurrey, promiseRecordToJson, promiseToJson, summarize, summaryToJson, type PublicPromiseRecord } from "@/lib/tracker";

describe("promise tracker seed", () => {
  it("has the 26 promises, numbered 1 to 26", () => {
    expect(seedPromises.map((p) => p.number)).toEqual(Array.from({ length: 26 }, (_, i) => i + 1));
  });
  it("cites a linked source for every promise", () => {
    for (const p of seedPromises) {
      expect(p.sources.length, `promise ${p.number}`).toBeGreaterThan(0);
      for (const s of p.sources) expect(s.url, `promise ${p.number}: ${s.label}`).toMatch(/^https:\/\//);
    }
  });
  it("gives each delivery test to existing promises, at most once each", () => {
    const covered = seedTests.flatMap((t) => t.promises);
    expect(new Set(covered).size).toBe(covered.length);
    for (const n of covered) expect(n).toBeGreaterThanOrEqual(1);
    expect(covered.length).toBe(18);
  });
  it("lists the eight announcements newest first", () => {
    expect(seedAnnouncements).toHaveLength(8);
    const dates = seedAnnouncements.map((a) => a.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });
  it("keeps key dates in order, with one hard deadline", () => {
    const starts = keyDates.map((d) => d.start);
    expect([...starts].sort()).toEqual(starts);
    expect(keyDates.filter((d) => d.hard)).toHaveLength(1);
  });
  it("carries the dates and town centres the document states", () => {
    const by = Object.fromEntries(seedPromises.map((p) => [p.number, p]));
    expect(by[10].targetDate).toBe("2027-02-07");
    expect(by[10].promisedOn).toBe("2026-04-13");
    expect(by[1].targetDate).toBe("2027-05-15");
    expect(by[22].targetDate).toBe("2026-12-31");
    expect(by[8].promisedOn).toBe("2026-09-21");
    expect(by[9].neighbourhoods).toEqual(["Newton", "Whalley"]);
    expect(by[14].neighbourhoods).toEqual(["Cloverdale"]);
    expect(by[15].neighbourhoods).toEqual(["Whalley"]);
    expect(by[16].neighbourhoods).toEqual(["Newton"]);
    expect(by[17].neighbourhoods).toEqual(["Cloverdale"]);
    expect(by[19].neighbourhoods).toEqual(["South Surrey"]);
    expect(by[20].neighbourhoods).toEqual(["South Surrey"]);
    // Only three promises carry a deadline the party gave.
    expect(seedPromises.filter((p) => p.targetDate).map((p) => p.number)).toEqual([1, 10, 22]);
  });
  it("uses real dates and known town centres", () => {
    for (const p of seedPromises) {
      for (const d of [p.promisedOn, p.targetDate]) if (d) expect(d, `promise ${p.number}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (p.promisedOn && p.targetDate) expect(p.promisedOn < p.targetDate, `promise ${p.number}`).toBe(true);
      for (const n of p.neighbourhoods ?? []) expect(NEIGHBOURHOODS as readonly string[]).toContain(n);
    }
  });
});

describe("countByStatus", () => {
  it("counts every status, including zeros", () => {
    expect(countByStatus(["kept", "broken", "kept"])).toEqual({ not_started: 0, in_progress: 0, partly_kept: 0, kept: 2, broken: 1 });
  });
});

describe("countdowns and overdue flags", () => {
  const helicopter = { status: "not_started" as const, targetDate: "2027-02-07", promisedOn: "2026-04-13", hasRecord: false };

  it("counts whole days between calendar dates", () => {
    expect(daysBetween("2026-11-02", "2027-02-07")).toBe(97);
    expect(daysBetween("2027-02-07", "2026-11-02")).toBe(-97);
    expect(daysBetween("2027-03-13", "2027-03-15")).toBe(2); // across the spring clock change
  });

  it("counts down to the deadline and then counts the days overdue", () => {
    expect(dueInfo(helicopter, "2026-11-02")).toEqual({ kind: "due", days: 97, label: "Due in 97 days" });
    expect(dueInfo(helicopter, "2027-02-06")).toEqual({ kind: "due", days: 1, label: "Due in 1 day" });
    expect(dueInfo(helicopter, "2027-02-07")).toEqual({ kind: "due_today", days: 0, label: "Due today" });
    expect(dueInfo(helicopter, "2027-02-08")).toEqual({ kind: "overdue", days: 1, label: "1 day overdue" });
    expect(dueInfo(helicopter, "2027-03-01")).toEqual({ kind: "overdue", days: 22, label: "22 days overdue" });
  });

  it("takes the calendar date in Pacific time, across the day boundary", () => {
    // 06:59 UTC on Feb 7 is still 23:59 on Feb 6 in Surrey (BC's permanent UTC-7 from Nov 2026).
    expect(dueInfoAt(helicopter, new Date("2027-02-07T06:59:00Z"))?.label).toBe("Due in 1 day");
    expect(dueInfoAt(helicopter, new Date("2027-02-07T07:00:00Z"))?.label).toBe("Due today");
    expect(dueInfoAt(helicopter, new Date("2027-02-08T06:59:59Z"))?.label).toBe("Due today");
    expect(dueInfoAt(helicopter, new Date("2027-02-08T07:00:00Z"))?.label).toBe("1 day overdue");
  });

  it("uses the summer offset in July", () => {
    const audit = { status: "not_started" as const, targetDate: null, promisedOn: "2026-07-22", hasRecord: false };
    // 06:59 UTC on July 23 is 23:59 on July 22 in Surrey (PDT, UTC-7).
    expect(dueInfoAt(audit, new Date("2026-07-23T06:59:00Z"))?.label).toBe("Promised today, no record yet");
    expect(dueInfoAt(audit, new Date("2026-07-23T07:00:00Z"))?.label).toBe("Promised 1 day ago, no record yet");
    expect(dueInfoAt(audit, new Date("2026-11-02T20:00:00Z"))).toEqual({ kind: "waiting", days: 103, label: "Promised 103 days ago, no record yet" });
  });

  it("stops counting once a promise has a record or a final score", () => {
    expect(dueInfo({ ...helicopter, hasRecord: true, status: "in_progress" }, "2026-11-02")?.label).toBe("Due in 97 days");
    expect(dueInfo({ status: "in_progress", targetDate: null, promisedOn: "2026-04-13", hasRecord: true }, "2026-11-02")).toBeNull();
    expect(dueInfo({ ...helicopter, status: "kept" }, "2027-03-01")).toBeNull();
    expect(dueInfo({ ...helicopter, status: "broken" }, "2027-03-01")).toBeNull();
    expect(dueInfo({ status: "not_started", targetDate: null, promisedOn: null, hasRecord: false }, "2026-11-02")).toBeNull();
    expect(dueInfo({ status: "not_started", targetDate: null, promisedOn: "2030-01-01", hasRecord: false }, "2026-11-02")).toBeNull();
  });

  it("stamps feed items at noon in Surrey", () => {
    expect(noonInSurrey("2027-02-07").toISOString()).toBe("2027-02-07T19:00:00.000Z");
    expect(noonInSurrey("2026-07-22").toISOString()).toBe("2026-07-22T19:00:00.000Z");
  });
});

describe("neighbourhood links", () => {
  it("slugifies town centre names", () => {
    expect(neighbourhoodHref("South Surrey")).toBe("/neighbourhoods/south-surrey");
    expect(neighbourhoodHref("Newton")).toBe("/neighbourhoods/newton");
  });
});

describe("RSS", () => {
  it("escapes everything XML cares about and drops control characters", () => {
    expect(escapeXml(`Tom & Jerry <b>"quoted"</b> 'single'\u0000`)).toBe("Tom &amp; Jerry &lt;b&gt;&quot;quoted&quot;&lt;/b&gt; &apos;single&apos;");
  });
  it("builds a valid RSS 2.0 document with escaped items", () => {
    const xml = buildRss({
      title: "Tracker <updates>",
      link: "https://example.org/tracker",
      description: "Scores & records",
      selfUrl: "https://example.org/tracker/feed.xml?a=1&b=2",
      lastBuildDate: new Date("2026-11-02T20:00:00Z"),
      items: [
        {
          title: `Promise 10 is now in progress: Police helicopter & drones`,
          link: "https://example.org/tracker/10#update-abc",
          guid: "https://example.org/tracker/10#update-abc",
          pubDate: new Date("2026-11-02T20:00:00Z"),
          description: `Board approves <lease> "quoted"`,
          category: "Policing",
        },
      ],
    });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"')).toBe(true);
    expect(xml).toContain("<title>Tracker &lt;updates&gt;</title>");
    expect(xml).toContain("<description>Scores &amp; records</description>");
    expect(xml).toContain('href="https://example.org/tracker/feed.xml?a=1&amp;b=2"');
    expect(xml).toContain("Police helicopter &amp; drones</title>");
    expect(xml).toContain("<description>Board approves &lt;lease&gt; &quot;quoted&quot;</description>");
    expect(xml).toContain("<pubDate>Mon, 02 Nov 2026 20:00:00 GMT</pubDate>");
    expect(xml).toContain("<category>Policing</category>");
    expect(xml).toContain('<guid isPermaLink="false">https://example.org/tracker/10#update-abc</guid>');
    expect(xml.match(/<item>/g)).toHaveLength(1);
    // No raw ampersands or angle brackets survive inside text.
    expect(/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml)).toBe(false);
  });
});

describe("summary and JSON shapes", () => {
  const record = (n: number, status: PublicPromiseRecord["status"], updates: PublicPromiseRecord["updates"] = []): PublicPromiseRecord => ({
    id: `id-${n}`,
    number: n,
    title: `Promise ${n}`,
    specifics: "",
    area: "Policing",
    status,
    statusChangedAt: null,
    sources: [{ label: "Homepage", url: "https://example.org" }],
    testKept: "Kept means",
    testPartly: "Partly means",
    testBroken: "Broken means",
    testRecord: "Minutes",
    promisedOn: "2026-04-13",
    targetDate: null,
    neighbourhoods: ["Newton"],
    updates,
  });
  const update = { id: "u1", date: "2026-11-02", status: "in_progress" as const, note: "Board approves", url: "https://example.org/minutes", createdAt: "2026-11-02T20:00:00.000Z" };

  it("counts by status and finds the newest update date", () => {
    const summary = summarize([record(1, "kept", [{ ...update, date: "2026-11-01" }]), record(2, "kept"), record(3, "in_progress", [update]), record(4, "not_started")]);
    expect(summary).toEqual({ total: 4, counts: { not_started: 1, in_progress: 1, partly_kept: 0, kept: 2, broken: 0 }, lastUpdated: "2026-11-02" });
    expect(summarize([]).lastUpdated).toBeNull();
    const json = summaryToJson(summary, "https://example.org");
    expect(json.statuses.map((s) => s.count)).toEqual([1, 1, 0, 2, 0]);
    expect(json.trackerUrl).toBe("https://example.org/tracker");
  });

  it("serializes a promise for the API with its latest update and an absolute url", () => {
    const item = promiseToJson(record(3, "in_progress", [update]), "https://example.org", 26);
    expect(item.url).toBe("https://example.org/tracker/3");
    expect(item.statusLabel).toBe("In progress");
    expect(item.latestUpdate).toEqual({ date: "2026-11-02", status: "in_progress", note: "Board approves", url: "https://example.org/minutes" });
    expect(item.neighbourhoods).toEqual(["Newton"]);
    expect(promiseToJson(record(4, "not_started"), "https://example.org", 26).latestUpdate).toBeNull();
    const full = promiseRecordToJson(record(3, "in_progress", [update]), "https://example.org", 26);
    expect(full.updates).toHaveLength(1);
    expect(full.deliveryTest?.kept).toBe("Kept means");
    expect(full.shareImage).toBe("https://example.org/tracker/3/opengraph-image");
  });
});

describe("methodology and letters", () => {
  it("explains every status", () => {
    for (const id of ["not_started", "in_progress", "partly_kept", "kept", "broken"] as const) expect(methodology.statuses[id].length).toBeGreaterThan(40);
  });
  it("writes a letter that names the promise and asks for a written answer", () => {
    const text = councilLetter({ number: 10, total: 26, title: "Police helicopter", statusLabel: "In progress", dueLine: "Due in 97 days", url: "https://example.org/tracker/10" });
    expect(text).toContain('"Police helicopter" (promise 10 of 26');
    expect(text).toContain("in progress. Due in 97 days.");
    expect(text).toContain("in writing");
    expect(text).not.toMatch(/@/);
  });
});
