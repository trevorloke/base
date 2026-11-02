import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MeridianClient } from "../src/client.ts";
import { INSTRUCTIONS, SERVER_NAME, SERVER_VERSION, createServer } from "../src/server.ts";
import { TOOL_NAMES } from "../src/tools.ts";
import { NOW, fakeApi, pendingDetail, radar, textOf } from "./helpers.ts";

const WRITE_TOOLS = new Set(["create_post", "schedule_post", "cancel_post"]);

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function connect(api: ReturnType<typeof fakeApi>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(new MeridianClient({ baseUrl: "http://api.test", apiKey: "mer_t", fetch: api.fetch }), { now: () => NOW });
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  cleanup = async () => {
    await client.close();
    await server.close();
  };
  return client;
}

describe("meridian MCP server", () => {
  it("identifies itself and carries instructions that say to call get_brand_context first", async () => {
    const client = await connect(fakeApi([]));
    expect(client.getServerVersion()).toMatchObject({ name: SERVER_NAME, version: SERVER_VERSION });
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    expect(INSTRUCTIONS).toContain("get_brand_context first");
    expect(INSTRUCTIONS).toContain("approval queue");
    expect(INSTRUCTIONS).toContain("Red lines are enforced server-side");
  });

  it("lists exactly the documented tools, with read-only annotations on everything but the three write tools", async () => {
    const client = await connect(fakeApi([]));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.annotations?.readOnlyHint, `${tool.name} readOnlyHint`).toBe(!WRITE_TOOLS.has(tool.name));
    }
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("cancel_post")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("create_post")?.annotations?.destructiveHint).toBe(false);
    expect(byName.get("get_brand_context")?.description).toMatch(/Call this FIRST/);
    expect(byName.get("check_policy")?.description).toMatch(/before create_post/);
    expect(byName.get("create_post")?.inputSchema.required).toEqual(expect.arrayContaining(["body", "variants"]));
    expect(byName.get("create_post")?.inputSchema.required).not.toContain("aiAssisted");
    expect(byName.get("get_brand_context")?.inputSchema).toMatchObject({ type: "object" });
    expect(byName.get("search_feed")?.inputSchema.properties).toHaveProperty("sinceHours");
  });

  it("calls get_radar end to end: summary text first, raw JSON second", async () => {
    const api = fakeApi([{ path: "/v1/trends/radar", body: radar }]);
    const client = await connect(api);
    const result = await client.callTool({ name: "get_radar", arguments: {} });
    expect(result.isError).toBeFalsy();
    const content = result.content as unknown[];
    expect(content).toHaveLength(2);
    expect(textOf({ content })).toMatch(/Vancouver snow day\s+top_1\s+rising\s+72%/);
    expect(JSON.parse(textOf({ content }, 1))).toEqual(radar);
    expect(api.last().headers.authorization).toBe("Bearer mer_t");
  });

  it("calls create_post end to end, applying schema defaults and the disclosure", async () => {
    const api = fakeApi([{ method: "POST", path: "/v1/posts", status: 201, body: pendingDetail }]);
    const client = await connect(api);
    const result = await client.callTool({
      name: "create_post",
      arguments: { body: "Snow day", variants: [{ socialAccountId: "acc_x", text: "Snow day in Vancouver." }] },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf({ content: result.content as unknown[] })).toContain("landed in the approval queue");
    expect(api.last().body).toMatchObject({
      actionClass: "new_post",
      disclosure: { aiAssisted: true, aiContributions: ["text_drafted"], humanReviewed: false, model: "mcp-client" },
    });
  });

  it("rejects bad arguments and surfaces API errors as isError results, never protocol errors", async () => {
    const api = fakeApi([{ path: "/v1/context", status: 401, body: { error: { code: "unauthorized", message: "unknown api key" } } }]);
    const client = await connect(api);

    const invalid = await client.callTool({ name: "get_topic", arguments: {} });
    expect(invalid.isError).toBe(true);
    expect(textOf({ content: invalid.content as unknown[] })).toMatch(/topicId/);

    const unauthorized = await client.callTool({ name: "get_brand_context", arguments: {} });
    expect(unauthorized.isError).toBe(true);
    expect(textOf({ content: unauthorized.content as unknown[] })).toContain("401 (unauthorized)");
    expect(textOf({ content: unauthorized.content as unknown[] })).toContain("unknown api key");
  });
});
