import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MeridianClient } from "./client.ts";
import { registerTools } from "./tools.ts";

export const SERVER_NAME = "meridian";
export const SERVER_VERSION = "0.1.0";

export const INSTRUCTIONS = `Meridian is the system of record for attention: it watches every social surface a brand owns (the live feed), forecasts where attention is going (the trend radar), enforces the brand's red lines, and keeps an outcome ledger of what was posted, by whom, in which trend stage, and what moved.

You are connected to one workspace; the API key identifies it and everything you do is attributed to you in the ledger.

How to work here:
1. Call get_brand_context first, before drafting anything. It gives you the brand voice, the red lines, your autonomy level per action class, the connected accounts (you need their ids) and what humans changed in earlier drafts.
2. Look before you propose: get_radar / get_topic for what is rising, search_feed for what people are saying, get_metrics_summary and get_lift_by_stage for what has worked.
3. Dry-run drafts with check_policy, then propose with create_post. Posts land in the brand's approval queue (or as drafts, or scheduled) according to the autonomy dial; a human approves, edits or rejects in the Meridian app. You cannot approve, publish, change policy or connect accounts.
4. Red lines are enforced server-side on every post regardless of what you send; a block is final and is recorded. Read the violations in the result and fix the text instead of retrying the same words.

Every tool returns a readable summary first and the raw JSON second. Errors come back as results with isError set, with the API's message.`;

/** The Meridian MCP server, with every tool registered against the given API client. */
export function createServer(client: MeridianClient, opts: { now?: () => Date } = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, client, opts);
  return server;
}
