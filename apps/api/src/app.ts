import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { streamSSE } from "hono/streaming";
import { and, desc, eq } from "drizzle-orm";
import { ZodError } from "zod";
import { approvalDiffs, postOutcomes, postVariants } from "@meridian/db";
import { CoreError, type Meridian, type Principal } from "@meridian/core";
import { Policy, type ActivityKind, type Network, type PostStatus } from "@meridian/schema";
import { gatePost } from "@meridian/policy";

export const VERSION = "0.1.0";

type Env = { Variables: { principal: Principal } };

export interface AppOptions {
  /** Slug of a workspace that unauthenticated requests act on, as human owner "dev". Dev only. */
  devWorkspace?: string;
}

const err = (code: string, message: string, details?: unknown) => ({ error: { code, message, details } });

function date(v: string | undefined, fallback: Date): Date {
  if (!v) return fallback;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new CoreError("invalid", `bad date: ${v}`);
  return d;
}
const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
const daysAgo = (n: number, now: Date) => new Date(now.getTime() - n * 86_400_000);

export function createApp(m: Meridian, opts: AppOptions = {}) {
  const app = new Hono<Env>();

  app.onError((e, c) => {
    if (e instanceof CoreError) return c.json(err(e.code, e.message, e.details), e.httpStatus as 400);
    if (e instanceof ZodError) return c.json(err("invalid", "validation failed", e.issues), 400);
    console.error("[api]", e);
    return c.json(err("internal", "internal error"), 500);
  });

  app.get("/api/health", (c) => c.json({ ok: true, version: VERSION, db: m.ctx.db.constructor.name.toLowerCase().includes("pglite") ? "pglite" : "postgres" }));

  const auth = createMiddleware<Env>(async (c, next) => {
    const header = c.req.header("authorization");
    let key = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : undefined;
    if (!key && c.req.path.endsWith("/feed/stream")) key = c.req.query("key") ?? undefined; // EventSource cannot send headers
    if (key) {
      const p = await m.workspaces.authenticate(key);
      if (!p) return c.json(err("unauthorized", "invalid api key"), 401);
      c.set("principal", p);
      return next();
    }
    if (opts.devWorkspace) {
      const ws = await m.workspaces.bySlug(opts.devWorkspace);
      if (ws) {
        c.set("principal", { workspaceId: ws.id, actor: { type: "human", id: "dev" }, role: "owner" });
        return next();
      }
    }
    return c.json(err("unauthorized", "missing api key"), 401);
  });
  app.use("/v1/*", auth);

  // ---------------------------------------------------------------- identity & workspace
  app.get("/v1/me", async (c) => {
    const p = c.get("principal");
    return c.json({ workspace: await m.workspaces.get(p.workspaceId), actor: p.actor, role: p.role ?? null });
  });
  app.get("/v1/workspace", async (c) => c.json(await m.workspaces.get(c.get("principal").workspaceId)));
  app.patch("/v1/workspace/profile", async (c) => {
    const body = (await c.req.json()) as { profile: Record<string, unknown> };
    return c.json(await m.workspaces.updateProfile(c.get("principal"), body.profile ?? {}));
  });

  // ---------------------------------------------------------------- accounts
  app.get("/v1/accounts", async (c) => c.json(await m.accounts.list(c.get("principal").workspaceId)));
  app.post("/v1/accounts", async (c) => {
    const p = c.get("principal");
    m.workspaces.requireRole(p, ["owner", "approver"]);
    return c.json(await m.accounts.connect(p, await c.req.json()), 201);
  });
  app.delete("/v1/accounts/:id", async (c) => {
    const p = c.get("principal");
    m.workspaces.requireRole(p, ["owner", "approver"]);
    await m.accounts.disconnect(p, c.req.param("id"));
    return c.body(null, 204);
  });

  // ---------------------------------------------------------------- policy
  app.get("/v1/policy", async (c) => c.json(await m.policy.getActive(c.get("principal").workspaceId)));
  app.put("/v1/policy", async (c) => {
    const p = c.get("principal");
    m.workspaces.requireRole(p, ["owner"]);
    if (p.actor.type !== "human") throw new CoreError("forbidden", "only humans change policy");
    return c.json(await m.policy.update(p, await c.req.json()));
  });
  app.get("/v1/policy/history", async (c) => c.json(await m.policy.history(c.get("principal").workspaceId)));
  app.post("/v1/policy/check", async (c) => {
    const p = c.get("principal");
    const body = (await c.req.json()) as { variants: { network: string; text: string }[]; scheduledAt?: string; actionClass?: string; disclosure?: unknown };
    const policy = await m.policy.getActive(p.workspaceId);
    const at = body.scheduledAt ? new Date(body.scheduledAt) : null;
    const gate = gatePost({
      policy,
      actionClass: (body.actionClass as never) ?? "new_post",
      actorType: p.actor.type,
      role: p.role,
      subjects: (body.variants ?? []).map((v) => ({ text: v.text, network: v.network, scheduledAt: at, disclosure: (body.disclosure as never) ?? null })),
      wantsSchedule: !!at,
      ctx: { postsToday: await m.policy.postsToday(p.workspaceId, policy.timezone, at ?? m.ctx.now()), classifyTopic: m.ctx.classifyTopic, now: m.ctx.now() },
    });
    return c.json({ ...gate.decision, wouldLand: gate.initialStatus, refused: gate.refusedReason ?? null });
  });

  // ---------------------------------------------------------------- posts
  app.get("/v1/posts", async (c) => {
    const p = c.get("principal");
    const status = list(c.req.query("status")) as PostStatus[];
    const limit = Number(c.req.query("limit") ?? 50);
    return c.json(await m.posts.list(p.workspaceId, { status: status.length ? status : undefined, limit }));
  });
  app.get("/v1/posts/queue", async (c) => c.json(await m.posts.queue(c.get("principal").workspaceId)));
  app.post("/v1/posts", async (c) => c.json(await m.posts.create(c.get("principal"), await c.req.json()), 201));
  app.get("/v1/posts/:id", async (c) => {
    const p = c.get("principal");
    const detail = await m.posts.get(p.workspaceId, c.req.param("id"));
    return c.json({ ...detail, history: await m.events.history("post", detail.post.id) });
  });
  app.post("/v1/posts/:id/schedule", async (c) => {
    const body = (await c.req.json()) as { at: string };
    return c.json(await m.posts.schedule(c.get("principal"), c.req.param("id"), date(body.at, m.ctx.now())));
  });
  app.post("/v1/posts/:id/publish-now", async (c) => c.json(await m.posts.publishNow(c.get("principal"), c.req.param("id"))));
  app.post("/v1/posts/:id/cancel", async (c) => c.json(await m.posts.cancel(c.get("principal"), c.req.param("id"))));
  app.patch("/v1/posts/:id/variants", async (c) => {
    const body = (await c.req.json()) as { edits: Record<string, string> };
    return c.json(await m.posts.updateVariants(c.get("principal"), c.req.param("id"), body.edits ?? {}));
  });
  app.post("/v1/posts/:id/decide", async (c) => c.json(await m.approvals.decide(c.get("principal"), c.req.param("id"), await c.req.json())));

  // ---------------------------------------------------------------- feed
  app.get("/v1/feed", async (c) => {
    const p = c.get("principal");
    const q = c.req.query();
    return c.json(
      await m.listening.feed(p.workspaceId, {
        streamId: q.stream,
        networks: list(q.networks) as Network[],
        kinds: list(q.kinds) as ActivityKind[],
        accountId: q.account,
        since: q.since ? date(q.since, m.ctx.now()) : undefined,
        before: q.before ? date(q.before, m.ctx.now()) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
        q: q.q,
      }),
    );
  });
  app.get("/v1/feed/counts", async (c) => {
    const p = c.get("principal");
    return c.json(await m.listening.counts(p.workspaceId, date(c.req.query("since"), daysAgo(7, m.ctx.now()))));
  });
  app.get("/v1/feed/stream", (c) => {
    const p = c.get("principal");
    return streamSSE(c, async (stream) => {
      const names = ["activity", "post", "alert", "forecast"] as const;
      const handlers = names.map((name) => {
        const h = (payload: { workspaceId?: string | null }) => {
          const ws = payload.workspaceId;
          if (ws === p.workspaceId || (name === "forecast" && (ws === null || ws === undefined))) {
            void stream.writeSSE({ event: name, data: JSON.stringify(payload) });
          }
        };
        m.emitter.on(name, h);
        return [name, h] as const;
      });
      stream.onAbort(() => {
        for (const [name, h] of handlers) m.emitter.off(name, h);
      });
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ workspaceId: p.workspaceId }) });
      while (!stream.aborted) {
        await stream.sleep(25_000);
        await stream.write(": ping\n\n");
      }
    });
  });
  app.get("/v1/streams", async (c) => c.json(await m.listening.listStreams(c.get("principal").workspaceId)));
  app.post("/v1/streams", async (c) => c.json(await m.listening.createStream(c.get("principal"), await c.req.json()), 201));
  app.delete("/v1/streams/:id", async (c) => {
    await m.listening.deleteStream(c.get("principal"), c.req.param("id"));
    return c.body(null, 204);
  });
  app.post("/v1/ingest/items", async (c) => {
    const p = c.get("principal");
    const body = (await c.req.json()) as { accountId?: string | null; items: unknown[] };
    return c.json(await m.listening.ingestItems(p.workspaceId, body.accountId ?? null, body.items ?? []));
  });
  app.post("/v1/ingest/:accountId", async (c) => {
    const p = c.get("principal");
    await m.accounts.get(p.workspaceId, c.req.param("accountId"));
    return c.json(await m.listening.ingestAccount(c.req.param("accountId")));
  });

  // ---------------------------------------------------------------- metrics
  app.get("/v1/metrics/summary", async (c) => {
    const p = c.get("principal");
    const now = m.ctx.now();
    const policy = await m.policy.getActive(p.workspaceId);
    return c.json(await m.metrics.summary(p.workspaceId, date(c.req.query("from"), daysAgo(7, now)), date(c.req.query("to"), now), policy.timezone));
  });
  app.get("/v1/metrics/lift-by-stage", async (c) => {
    const p = c.get("principal");
    const now = m.ctx.now();
    return c.json(await m.metrics.liftByStage(p.workspaceId, date(c.req.query("from"), daysAgo(30, now)), date(c.req.query("to"), now)));
  });
  app.get("/v1/metrics/series", async (c) => {
    const q = c.req.query();
    const now = m.ctx.now();
    if (!q.entityType || !q.entityId || !q.metric) throw new CoreError("invalid", "entityType, entityId and metric are required");
    return c.json(await m.metrics.series(q.entityType, q.entityId, q.metric, date(q.from, daysAgo(30, now)), date(q.to, now)));
  });
  app.get("/v1/metrics/variant/:variantId", async (c) => {
    const p = c.get("principal");
    const [v] = await m.ctx.db.select().from(postVariants).where(eq(postVariants.id, c.req.param("variantId"))).limit(1);
    if (!v) throw new CoreError("not_found", "variant");
    await m.posts.get(p.workspaceId, v.postId); // tenancy check
    const outcomes = await m.ctx.db.select().from(postOutcomes).where(eq(postOutcomes.variantId, v.id)).orderBy(postOutcomes.dueAt);
    return c.json({ latest: v.externalId ? await m.metrics.latest("post_variant", v.externalId) : {}, outcomes });
  });

  // ---------------------------------------------------------------- trends
  app.get("/v1/trends/radar", async (c) => c.json(await m.trends.radar(c.get("principal").workspaceId)));
  app.get("/v1/trends/topics", async (c) => c.json(await m.trends.listTopics(c.get("principal").workspaceId)));
  app.post("/v1/trends/topics", async (c) => {
    const p = c.get("principal");
    const body = (await c.req.json()) as { name: string; keywords: string[]; relevance?: number; global?: boolean };
    if (body.global) m.workspaces.requireRole(p, ["owner"]);
    return c.json(await m.trends.createTopic({ workspaceId: body.global ? null : p.workspaceId, name: body.name, keywords: body.keywords ?? [], relevance: body.relevance }), 201);
  });
  app.patch("/v1/trends/topics/:id", async (c) => {
    const body = (await c.req.json()) as { relevance: number };
    await m.trends.setRelevance(c.get("principal"), c.req.param("id"), Number(body.relevance));
    return c.body(null, 204);
  });
  app.get("/v1/trends/topics/:id", async (c) => c.json(await m.trends.detail(c.get("principal").workspaceId, c.req.param("id"))));
  app.post("/v1/trends/topics/:id/forecast", async (c) => {
    const { combined, ...rest } = await m.trends.computeForecast(c.req.param("id"));
    return c.json(rest);
  });
  app.post("/v1/trends/points", async (c) => {
    const p = c.get("principal");
    const body = (await c.req.json()) as { points: unknown[] };
    return c.json({ recorded: await m.trends.recordPoints(body.points ?? [], p.workspaceId) });
  });

  // ---------------------------------------------------------------- operators' output
  app.get("/v1/alerts", async (c) => {
    const p = c.get("principal");
    return c.json(await m.ops.alerts(p.workspaceId, { unacknowledgedOnly: c.req.query("unacknowledged") === "1", limit: Number(c.req.query("limit") ?? 50) }));
  });
  app.post("/v1/alerts/:id/ack", async (c) => {
    await m.ops.acknowledge(c.get("principal"), c.req.param("id"));
    return c.body(null, 204);
  });
  app.get("/v1/briefs", async (c) => c.json(await m.ops.briefs(c.get("principal").workspaceId, Number(c.req.query("limit") ?? 12))));
  app.get("/v1/briefs/latest", async (c) => c.json((await m.ops.briefs(c.get("principal").workspaceId, 1))[0] ?? null));
  app.get("/v1/runs", async (c) => c.json(await m.ops.runs(c.get("principal").workspaceId, Number(c.req.query("limit") ?? 50))));

  // ---------------------------------------------------------------- ledger & export
  app.get("/v1/ledger", async (c) => {
    const p = c.get("principal");
    const q = c.req.query();
    return c.json(
      await m.events.list({
        workspaceId: p.workspaceId,
        types: list(q.types),
        subjectType: q.subjectType,
        subjectId: q.subjectId,
        afterSeq: q.afterSeq ? Number(q.afterSeq) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
      }),
    );
  });
  app.get("/v1/export", async (c) => {
    const p = c.get("principal");
    const data = await m.exports.workspace(p);
    c.header("Content-Disposition", `attachment; filename="meridian-${data.workspace?.slug ?? p.workspaceId}.json"`);
    return c.json(data);
  });

  // ---------------------------------------------------------------- brand context for agents
  app.get("/v1/context", async (c) => {
    const p = c.get("principal");
    const now = m.ctx.now();
    const [ws, policy, accounts, summary, radar] = await Promise.all([
      m.workspaces.get(p.workspaceId),
      m.policy.getActive(p.workspaceId),
      m.accounts.list(p.workspaceId),
      m.metrics.summary(p.workspaceId, daysAgo(30, now), now),
      m.trends.radar(p.workspaceId),
    ]);
    const diffs = await m.ctx.db
      .select({ before: approvalDiffs.beforeText, after: approvalDiffs.afterText })
      .from(approvalDiffs)
      .where(and(eq(approvalDiffs.workspaceId, p.workspaceId)))
      .orderBy(desc(approvalDiffs.createdAt))
      .limit(20);
    const parsed = Policy.parse(policy);
    return c.json({
      workspace: { name: ws.name, profile: ws.profile },
      policy: { autonomy: parsed.autonomy, redLines: parsed.redLines.map((r) => ({ id: r.id, kind: r.kind, description: r.description, severity: r.severity })), timezone: parsed.timezone, competitors: parsed.competitors },
      accounts,
      recentTop: summary.top,
      voiceExamples: diffs,
      activeTopics: radar.slice(0, 10),
    });
  });

  return app;
}
