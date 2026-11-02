import { describe, expect, it } from "vitest";
import { forecastTopic, kinematics, classifyStage, resample, type Point } from "../src/index.ts";

const H = 3_600_000;
const T0 = Date.parse("2026-11-01T00:00:00Z");

function synth(n: number, f: (i: number) => number, noiseSeed = 1, noise = 2): Point[] {
  let s = noiseSeed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31 - 0.5);
  return Array.from({ length: n }, (_, i) => ({ t: T0 + i * H, v: Math.max(0, f(i) + rnd() * noise) }));
}

describe("resample", () => {
  it("buckets, interpolates gaps and carries edges", () => {
    const pts: Point[] = [
      { t: T0, v: 10 },
      { t: T0 + 3 * H, v: 40 },
    ];
    const r = resample(pts, H);
    expect(r.map((p) => p.v)).toEqual([10, 20, 30, 40]);
  });
});

describe("stage classification", () => {
  it("flat low series is dormant", () => {
    const k = kinematics(synth(48, () => 10).map((p) => p.v));
    expect(classifyStage(k)).toBe("dormant");
  });

  it("logistic rise is rising, then peaking at the shoulder", () => {
    const logistic = (i: number) => 10 + 200 / (1 + Math.exp(-(i - 40) / 5));
    const early = synth(38, logistic).map((p) => p.v);
    expect(classifyStage(kinematics(early))).toBe("rising");
    const shoulder = synth(58, logistic).map((p) => p.v);
    expect(classifyStage(kinematics(shoulder))).toBe("peaking");
    const settled = synth(80, logistic).map((p) => p.v);
    expect(classifyStage(kinematics(settled))).toBe("plateau");
  });

  it("decay is fading", () => {
    const decay = (i: number) => 10 + 200 * Math.exp(-i / 10);
    expect(classifyStage(kinematics(synth(20, decay).map((p) => p.v)))).toBe("fading");
    // fully decayed and still: dormant, honestly
    expect(classifyStage(kinematics(synth(60, decay).map((p) => p.v)))).toBe("dormant");
  });
});

describe("forecastTopic", () => {
  it("is deterministic and always emits a band", () => {
    const pts = synth(60, (i) => 20 + i * 2, 1, 0);
    const a = forecastTopic([{ source: "google_trends", points: pts }], { now: T0 + 60 * H, horizonSteps: 24 });
    const b = forecastTopic([{ source: "google_trends", points: pts }], { now: T0 + 60 * H, horizonSteps: 24 });
    expect(a).toEqual(b);
    expect(a.curve).toHaveLength(24);
    for (const c of a.curve) {
      expect(c.lo).toBeLessThanOrEqual(c.value);
      expect(c.hi).toBeGreaterThanOrEqual(c.value);
    }
    // bands widen with horizon
    expect(a.curve[23]!.hi - a.curve[23]!.lo).toBeGreaterThan(a.curve[0]!.hi - a.curve[0]!.lo);
    expect(a.stage).toBe("rising");
    expect(a.hoursToPeak).toBeNull(); // a straight line is not decelerating: the peak is not in sight
  });

  it("a decelerating rise reports hours to peak", () => {
    const logistic = (i: number) => 10 + 200 / (1 + Math.exp(-(i - 40) / 5));
    const r = forecastTopic([{ source: "google_trends", points: synth(52, logistic) }], { now: T0 + 52 * H });
    expect(r.stage).toBe("rising");
    expect(r.hoursToPeak).not.toBeNull();
    expect(r.hoursToPeak!).toBeGreaterThan(2);
    expect(r.hoursToPeak!).toBeLessThan(40);
  });

  it("thin data yields low confidence", () => {
    const pts = synth(4, (i) => 10 + i);
    const r = forecastTopic([{ source: "manual", points: pts }], { now: T0 + 4 * H });
    expect(r.confidence).toBeLessThan(0.5);
  });

  it("agreeing sources raise confidence over a single source; disagreeing ones lower it", () => {
    const rise = (i: number) => 10 + i * 3;
    const fall = (i: number) => 200 - i * 3;
    const one = forecastTopic([{ source: "google_trends", points: synth(48, rise, 1) }], { now: T0 + 48 * H });
    const agree = forecastTopic(
      [
        { source: "google_trends", points: synth(48, rise, 1) },
        { source: "wikipedia_pageviews", points: synth(48, rise, 7) },
      ],
      { now: T0 + 48 * H },
    );
    const disagree = forecastTopic(
      [
        { source: "google_trends", points: synth(48, rise, 1) },
        { source: "wikipedia_pageviews", points: synth(48, fall, 7) },
      ],
      { now: T0 + 48 * H },
    );
    expect(agree.sourceAgreement!).toBeGreaterThan(0.8);
    expect(disagree.sourceAgreement!).toBeLessThan(0.2);
    expect(agree.confidence).toBeGreaterThan(one.confidence);
    expect(disagree.confidence).toBeLessThan(agree.confidence);
  });

  it("handles empty input", () => {
    const r = forecastTopic([], { now: T0 });
    expect(r.stage).toBe("dormant");
    expect(r.confidence).toBe(0);
    expect(r.curve).toEqual([]);
  });
});
