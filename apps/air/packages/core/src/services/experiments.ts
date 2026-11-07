import { and, desc, eq } from "drizzle-orm";
import { experiments, postOutcomes, posts } from "@starsign/db";
import { newId } from "@starsign/ledger";
import { z } from "zod";
import type { CoreContext, Principal } from "../context.ts";
import { CoreError } from "../errors.ts";

export const CreateExperimentInput = z.object({
  name: z.string().min(1).max(200),
  hypothesis: z.string().min(1).max(2000),
  arms: z.array(z.object({ key: z.string().regex(/^[a-z0-9_-]{1,32}$/), description: z.string().max(500) })).min(2).max(6),
  primaryMetric: z.enum(["engagements", "impressions", "likes", "replies", "reposts", "link_clicks", "conversions"]).default("engagements"),
  offset: z.enum(["24h", "72h", "7d"]).default("24h"),
});

export interface ArmReadout {
  key: string;
  description: string;
  posts: number;
  measured: number;
  mean: number | null;
}

export interface Comparison {
  arm: string;
  versus: string;
  /** Ratio of means, arm / versus. */
  lift: number;
  /** 80% bootstrap interval for the lift. */
  lo: number;
  hi: number;
  /** Share of resamples in which arm beat versus. */
  probabilityBetter: number;
}

export interface Readout {
  metric: string;
  offset: string;
  arms: ArmReadout[];
  comparisons: Comparison[];
  verdict: "not_enough_data" | "no_clear_winner" | "winner";
  winner: string | null;
  /** One sentence a strategist can repeat. */
  summary: string;
  minPerArm: number;
}

const MIN_PER_ARM = 3;
const RESAMPLES = 2000;

/** Seeded generator so a readout is reproducible from the same ledger. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  return s[lo]! + (s[Math.ceil(pos)]! - s[lo]!) * (pos - lo);
};

/** Bootstrap the ratio of means. Deterministic: seeded by the data itself. */
export function compareArms(a: number[], b: number[], seed = 1): { lift: number; lo: number; hi: number; probabilityBetter: number } {
  const r = rng(seed + a.length * 7919 + b.length * 104729 + Math.round(mean(a) + mean(b)));
  const ratios: number[] = [];
  let better = 0;
  for (let i = 0; i < RESAMPLES; i++) {
    let sa = 0;
    let sb = 0;
    for (let j = 0; j < a.length; j++) sa += a[Math.floor(r() * a.length)]!;
    for (let j = 0; j < b.length; j++) sb += b[Math.floor(r() * b.length)]!;
    const ma = sa / a.length;
    const mb = sb / b.length;
    ratios.push(mb > 0 ? ma / mb : ma > 0 ? Infinity : 1);
    if (ma > mb) better++;
  }
  const mb = mean(b);
  return { lift: mb > 0 ? mean(a) / mb : mean(a) > 0 ? Infinity : 1, lo: quantile(ratios, 0.1), hi: quantile(ratios, 0.9), probabilityBetter: better / RESAMPLES };
}

/**
 * Experiments: any post can be an arm. The readout compares arms on a fixed-offset outcome with an honest interval
 * and refuses to name a winner on thin data or when the interval straddles "no difference".
 */
export class ExperimentService {
  constructor(private readonly ctx: CoreContext) {}

  async create(p: Principal, raw: unknown) {
    if (p.actor.type === "human" && p.role === "viewer") throw new CoreError("forbidden", "viewers cannot start experiments");
    const input = CreateExperimentInput.parse(raw);
    if (new Set(input.arms.map((a) => a.key)).size !== input.arms.length) throw new CoreError("invalid", "arm keys must be unique");
    const [row] = await this.ctx.db
      .insert(experiments)
      .values({ id: newId("exp"), workspaceId: p.workspaceId, name: input.name, hypothesis: input.hypothesis, status: "running", arms: input.arms, primaryMetric: `${input.primaryMetric}@${input.offset}` })
      .returning();
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "experiment.started", subjectType: "experiment", subjectId: row!.id, actor: p.actor, data: { name: input.name, hypothesis: input.hypothesis, arms: input.arms.map((a) => a.key), metric: input.primaryMetric, offset: input.offset } });
    return row!;
  }

  async list(workspaceId: string) {
    return this.ctx.db.select().from(experiments).where(eq(experiments.workspaceId, workspaceId)).orderBy(desc(experiments.createdAt));
  }

  async get(workspaceId: string, id: string) {
    const [row] = await this.ctx.db.select().from(experiments).where(and(eq(experiments.id, id), eq(experiments.workspaceId, workspaceId))).limit(1);
    if (!row) throw new CoreError("not_found", `experiment ${id}`);
    return row;
  }

  /** Read the experiment from the outcome ledger. A post's value is the sum over its variants at the offset. */
  async readout(workspaceId: string, id: string): Promise<Readout> {
    const exp = await this.get(workspaceId, id);
    const [metric = "engagements", offset = "24h"] = exp.primaryMetric.split("@");
    const rows = await this.ctx.db
      .select({ postId: posts.id, arm: posts.experimentArm, metrics: postOutcomes.metrics, status: postOutcomes.status })
      .from(posts)
      .leftJoin(postOutcomes, and(eq(postOutcomes.postId, posts.id), eq(postOutcomes.offsetLabel, offset)))
      .where(and(eq(posts.workspaceId, workspaceId), eq(posts.experimentId, id)));
    const byPost = new Map<string, { arm: string; value: number; measured: boolean }>();
    for (const r of rows) {
      if (!r.arm) continue;
      const e = byPost.get(r.postId) ?? { arm: r.arm, value: 0, measured: false };
      if (r.status === "captured" && r.metrics) {
        const m = r.metrics as Record<string, number>;
        const v = metric === "engagements" ? (m.engagements ?? (m.likes ?? 0) + (m.replies ?? 0) + (m.reposts ?? 0)) : (m[metric] ?? 0);
        e.value += v;
        e.measured = true;
      }
      byPost.set(r.postId, e);
    }
    const arms: ArmReadout[] = exp.arms.map((a) => {
      const ps = [...byPost.values()].filter((p) => p.arm === a.key);
      const vals = ps.filter((p) => p.measured).map((p) => p.value);
      return { key: a.key, description: a.description, posts: ps.length, measured: vals.length, mean: vals.length ? mean(vals) : null };
    });
    const values = (k: string) => [...byPost.values()].filter((p) => p.arm === k && p.measured).map((p) => p.value);
    const ready = arms.filter((a) => a.measured >= MIN_PER_ARM);
    const label = metric.replace(/_/g, " ");
    if (ready.length < 2) {
      const short = arms.filter((a) => a.measured < MIN_PER_ARM).map((a) => `${a.key} needs ${MIN_PER_ARM - a.measured} more`);
      return { metric, offset, arms, comparisons: [], verdict: "not_enough_data", winner: null, minPerArm: MIN_PER_ARM, summary: `Not enough measured posts yet (${short.join(", ")}).` };
    }
    // Compare the best arm by mean against every other ready arm.
    const best = [...ready].sort((a, b) => (b.mean ?? 0) - (a.mean ?? 0))[0]!;
    const comparisons = ready.filter((a) => a.key !== best.key).map((other) => ({ arm: best.key, versus: other.key, ...compareArms(values(best.key), values(other.key)) }));
    const clear = comparisons.every((c) => c.lo > 1);
    const weakest = [...comparisons].sort((a, b) => a.lift - b.lift)[0]!;
    const fmt = (x: number) => (Number.isFinite(x) ? `${x.toFixed(2)}x` : "∞");
    if (clear) {
      return { metric, offset, arms, comparisons, verdict: "winner", winner: best.key, minPerArm: MIN_PER_ARM, summary: `"${best.key}" wins on ${label} at ${offset}: ${fmt(weakest.lift)} the next-best arm (80% interval ${fmt(weakest.lo)}–${fmt(weakest.hi)}).` };
    }
    return { metric, offset, arms, comparisons, verdict: "no_clear_winner", winner: null, minPerArm: MIN_PER_ARM, summary: `"${best.key}" leads on ${label} at ${offset} (${fmt(weakest.lift)}), but the 80% interval (${fmt(weakest.lo)}–${fmt(weakest.hi)}) includes no difference. Keep running.` };
  }

  /** Conclude: freeze the readout into the experiment and the ledger. */
  async conclude(p: Principal, id: string) {
    if (p.actor.type !== "human" || !p.role || p.role === "viewer") throw new CoreError("forbidden", "a person concludes experiments");
    const exp = await this.get(p.workspaceId, id);
    if (exp.status === "concluded") throw new CoreError("conflict", "already concluded");
    const readout = await this.readout(p.workspaceId, id);
    const [row] = await this.ctx.db.update(experiments).set({ status: "concluded", result: readout as unknown as Record<string, unknown> }).where(eq(experiments.id, id)).returning();
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "experiment.concluded", subjectType: "experiment", subjectId: id, actor: p.actor, data: { verdict: readout.verdict, winner: readout.winner, summary: readout.summary } });
    return row!;
  }
}
