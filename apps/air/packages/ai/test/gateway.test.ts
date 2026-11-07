import Anthropic, { APIConnectionError, AnthropicError, RateLimitError } from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AnthropicGateway,
  DEFAULT_MODEL,
  FakeGateway,
  ModelGatewayError,
  ModelOutputError,
  ModelRefusalError,
  REFUSAL_FALLBACK_BETA,
  classifyTopic,
  defaultFakeHandlers,
  draftForTrend,
  resolveModel,
  runPrompt,
  writeBrief,
  type BrandContext,
  type DraftForTrendVars,
} from "../src/index.ts";

const brand: BrandContext = {
  workspace: { name: "Acme", profile: { description: "Scheduling software", voice: { do: ["Be specific"] } } },
  policy: { redLines: [{ id: "p1", kind: "forbidden_phrase", description: "No guarantees", severity: "block", phrases: ["guaranteed"] }], timezone: "UTC" },
  networks: ["x"],
};
const draftVars: DraftForTrendVars = {
  brand,
  topic: { name: "Four-day week", keywords: ["four-day week"] },
  forecast: { stage: "rising", confidence: 0.7, hoursToPeak: 20, sources: ["google_trends"] },
  networks: ["x"],
  recentTopPosts: [],
};
const draftReply = { angle: "a", rationale: "r", variants: [{ network: "x", text: "t", thread: [] }], disclosure: { aiAssisted: true, aiContributions: ["text_drafted"] } };

/** A stand-in for the SDK client: records request params and replies like the API would, running the SDK's own parse helper. */
type Reply = { text?: string; stop_reason?: string; model?: string; stop_details?: unknown; usage?: Record<string, unknown>; throws?: Error };
function stubClient(reply: (params: Record<string, unknown>) => Reply) {
  const seen: { parse: Record<string, unknown>[]; stream: Record<string, unknown>[] } = { parse: [], stream: [] };
  const build = (params: Record<string, unknown>) => {
    const r = reply(params);
    if (r.throws) throw r.throws;
    const message = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: r.model ?? (params.model as string),
      content: r.text === undefined ? [] : [{ type: "text", text: r.text }],
      stop_reason: r.stop_reason ?? "end_turn",
      stop_sequence: null,
      stop_details: r.stop_details ?? null,
      usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, iterations: null, ...(r.usage ?? {}) },
    };
    // What the SDK's beta parser does with an auto-parseable output_config.format.
    const format = (params.output_config as { format?: { parse?: (s: string) => unknown } } | undefined)?.format;
    let parsed_output: unknown = null;
    if (format?.parse && r.text !== undefined) {
      try {
        parsed_output = format.parse(r.text);
      } catch (e) {
        // parseBetaMessage wraps any parse failure (bad JSON, schema miss) in the SDK's base error
        throw new AnthropicError(`Failed to parse structured output: ${e}`);
      }
    }
    return { ...message, parsed_output };
  };
  const client = {
    beta: {
      messages: {
        parse: async (params: Record<string, unknown>) => {
          seen.parse.push(params);
          return build(params);
        },
        stream: (params: Record<string, unknown>) => {
          seen.stream.push(params);
          return { finalMessage: async () => build(params) };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, seen };
}

describe("FakeGateway", () => {
  it("renders the prompt, validates the output against the schema and records the call", async () => {
    const gw = new FakeGateway(defaultFakeHandlers());
    const res = await runPrompt(gw, draftForTrend, draftVars);
    expect(res.output.disclosure.aiAssisted).toBe(true);
    expect(res.output.variants[0]?.network).toBe("x");
    expect(res.usage).toMatchObject({ model: "fake", promptVersion: "draftForTrend@1.0.0" });
    expect(res.usage.inputTokens).toBeGreaterThan(0);
    expect(res.usage.costUsd).toBeGreaterThan(0);
    expect(gw.calls).toHaveLength(1);
    expect(gw.callsFor("draftForTrend")[0]).toMatchObject({ prompt: "draftForTrend", version: "1.0.0", effort: "medium" });
    expect(gw.calls[0]!.system).toContain("Acme");
    expect(gw.calls[0]!.system).toContain("guaranteed");
  });

  it("rejects outputs that break the schema, honours per-call effort, and fails loudly without a handler", async () => {
    const gw = new FakeGateway({ classifyTopic: () => ({ likelihood: 7, reason: "nope" }) });
    await expect(runPrompt(gw, classifyTopic, { text: "t", keywords: ["k"], description: "d" })).rejects.toThrow();
    gw.on("classifyTopic", () => ({ likelihood: 0.2, reason: "fine" }));
    const res = await runPrompt(gw, classifyTopic, { text: "t", keywords: ["k"], description: "d" }, "high");
    expect(res.output.likelihood).toBe(0.2);
    expect(gw.calls.at(-1)?.effort).toBe("high");
    await expect(runPrompt(new FakeGateway(), classifyTopic, { text: "t", keywords: ["k"], description: "d" })).rejects.toThrow(/no handler/);
  });
});

describe("AnthropicGateway", () => {
  it("defaults to claude-opus-5-5, reads STARSIGN_MODEL, never appends a date suffix", () => {
    expect(DEFAULT_MODEL).toBe("claude-opus-5-5");
    expect(resolveModel({})).toBe("claude-opus-5-5");
    expect(resolveModel({ STARSIGN_MODEL: "  " })).toBe("claude-opus-5-5");
    expect(resolveModel({ STARSIGN_MODEL: "claude-sonnet-5-5" })).toBe("claude-sonnet-5-5");
    expect(DEFAULT_MODEL).not.toMatch(/\d{8}$/);
  });

  it("sends the skill's request shape: structured output format + effort, server-side refusal fallback, no thinking or sampling params", async () => {
    const { client, seen } = stubClient(() => ({ text: JSON.stringify(draftReply) }));
    const gw = new AnthropicGateway({ client, model: "claude-opus-5-5" });
    const res = await runPrompt(gw, draftForTrend, draftVars);

    expect(seen.parse).toHaveLength(1);
    expect(seen.stream).toHaveLength(0);
    const p = seen.parse[0]!;
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.max_tokens).toBe(16_000);
    expect(p.betas).toEqual([REFUSAL_FALLBACK_BETA]);
    expect(p.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(p.fallbacks).toBe("default");
    expect(p).not.toHaveProperty("thinking");
    expect(p).not.toHaveProperty("temperature");
    expect(p).not.toHaveProperty("top_p");
    expect(p).not.toHaveProperty("top_k");
    const oc = p.output_config as { effort: string; format: { type: string; schema: Record<string, unknown>; parse: unknown } };
    expect(oc.effort).toBe("medium");
    expect(oc.format.type).toBe("json_schema");
    expect(oc.format.schema.additionalProperties).toBe(false);
    expect(typeof oc.format.parse).toBe("function");
    const system = p.system as { type: string; text: string; cache_control: { type: string } }[];
    expect(system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(system[0]?.text).toContain("Acme");
    const messages = p.messages as { role: string; content: string }[];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toContain("Four-day week");

    expect(res.output).toEqual(draftReply);
    expect(res.usage).toEqual({ inputTokens: 1000, outputTokens: 200, costUsd: expect.closeTo(0.008, 9), model: "claude-opus-5-5", promptVersion: "draftForTrend@1.0.0" });
  });

  it("streams long outputs through finalMessage() at high effort with the streaming token budget", async () => {
    const { client, seen } = stubClient(() => ({ text: JSON.stringify({ headline: "h", markdown: "# m", evidence: [] }) }));
    const gw = new AnthropicGateway({ client, model: "claude-opus-5-5" });
    const res = await runPrompt(gw, writeBrief, { brand, period: { from: "a", to: "b", days: 7, timezone: "UTC" }, summary: {}, liftByStage: [], feedCounts: [], radar: [], alerts: [] });
    expect(seen.stream).toHaveLength(1);
    expect(seen.parse).toHaveLength(0);
    expect(seen.stream[0]!.max_tokens).toBe(64_000);
    expect((seen.stream[0]!.output_config as { effort: string }).effort).toBe("high");
    expect(res.output.headline).toBe("h");
  });

  it("prices a fallback rescue at the serving model's rates and reports that model", async () => {
    const { client } = stubClient(() => ({ text: JSON.stringify(draftReply), model: "claude-opus-4-8", usage: { iterations: [{ type: "message" }, { type: "fallback_message" }] } }));
    const lines: string[] = [];
    const gw = new AnthropicGateway({ client, model: "claude-opus-5-5", log: (l) => lines.push(l) });
    const res = await runPrompt(gw, draftForTrend, draftVars);
    expect(res.usage.model).toBe("claude-opus-4-8");
    expect(res.usage.costUsd).toBeCloseTo(1000 * 5e-6 + 200 * 25e-6, 9);
    expect(lines.join("\n")).toContain("served by claude-opus-4-8");
  });

  it("counts cached prompt tokens in inputTokens and prices them as cache reads/writes", async () => {
    const { client } = stubClient(() => ({ text: JSON.stringify(draftReply), usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } }));
    const res = await runPrompt(new AnthropicGateway({ client, model: "claude-opus-5-5" }), draftForTrend, draftVars);
    expect(res.usage.inputTokens).toBe(1000);
    expect(res.usage.costUsd).toBeCloseTo(100 * 4e-6 + 900 * 0.2e-6 + 200 * 20e-6, 12);
  });

  it("throws a typed refusal when the whole fallback chain declines", async () => {
    const { client } = stubClient(() => ({ stop_reason: "refusal", stop_details: { type: "refusal", category: "general_harms", explanation: "declined" } }));
    const gw = new AnthropicGateway({ client, model: "claude-opus-5-5" });
    const err = await runPrompt(gw, draftForTrend, draftVars).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelRefusalError);
    expect(err).toMatchObject({ category: "general_harms", explanation: "declined", model: "claude-opus-5-5" });
  });

  it("maps truncation, unparseable replies and SDK errors onto typed gateway errors", async () => {
    const truncated = new AnthropicGateway({ client: stubClient(() => ({ text: '{"angle":', stop_reason: "max_tokens" })).client, model: "claude-opus-5-5" });
    const t = await runPrompt(truncated, draftForTrend, draftVars).catch((e: unknown) => e);
    expect(t).toBeInstanceOf(ModelOutputError);
    expect(t).toMatchObject({ problem: "unparseable" });

    const garbage = new AnthropicGateway({ client: stubClient(() => ({ text: "not json" })).client, model: "claude-opus-5-5" });
    const g = await runPrompt(garbage, draftForTrend, draftVars).catch((e: unknown) => e);
    expect(g).toBeInstanceOf(ModelOutputError);
    expect(g).toMatchObject({ problem: "unparseable" });

    const empty = new AnthropicGateway({ client: stubClient(() => ({})).client, model: "claude-opus-5-5" });
    const m = await runPrompt(empty, draftForTrend, draftVars).catch((e: unknown) => e);
    expect(m).toMatchObject({ problem: "missing" });

    const cut = new AnthropicGateway({ client: stubClient(() => ({ text: JSON.stringify(draftReply), stop_reason: "max_tokens" })).client, model: "claude-opus-5-5" });
    const c = await runPrompt(cut, draftForTrend, draftVars).catch((e: unknown) => e);
    expect(c).toMatchObject({ problem: "truncated", stopReason: "max_tokens" });

    const limited = new AnthropicGateway({ client: stubClient(() => ({ throws: new RateLimitError(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, "slow down", new Headers()) })).client, model: "claude-opus-5-5" });
    const r = await runPrompt(limited, draftForTrend, draftVars).catch((e: unknown) => e);
    expect(r).toBeInstanceOf(ModelGatewayError);
    expect(r).toMatchObject({ code: "rate_limited", retryable: true, status: 429 });

    const offline = new AnthropicGateway({ client: stubClient(() => ({ throws: new APIConnectionError({ message: "socket hang up" }) })).client, model: "claude-opus-5-5" });
    const o = await runPrompt(offline, draftForTrend, draftVars).catch((e: unknown) => e);
    expect(o).toMatchObject({ code: "connection", retryable: true });
  });

  it("can be told to run without the server-side fallback", async () => {
    const { client, seen } = stubClient(() => ({ text: JSON.stringify(draftReply) }));
    await runPrompt(new AnthropicGateway({ client, model: "claude-opus-5-5", refusalFallback: false }), draftForTrend, draftVars);
    expect(seen.parse[0]!.betas).toBeUndefined();
    expect(seen.parse[0]!.fallbacks).toBeUndefined();
  });

  it("accepts any zod schema through the generic complete()", async () => {
    const schema = z.object({ ok: z.boolean() });
    const { client } = stubClient(() => ({ text: JSON.stringify({ ok: true }) }));
    const res = await new AnthropicGateway({ client, model: "claude-opus-5-5" }).complete({ prompt: classifyTopic, vars: { text: "t", keywords: ["k"], description: "d" }, schema, effort: "low" });
    expect(res.output).toEqual({ ok: true });
  });
});
