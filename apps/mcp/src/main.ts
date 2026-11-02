/**
 * Entry point.
 *   pnpm --filter @meridian/mcp start                 -> stdio (one workspace, key from MERIDIAN_API_KEY)
 *   pnpm --filter @meridian/mcp start -- --http 4001  -> Streamable HTTP at /mcp, stateless; the key comes
 *                                                        from each request's Authorization header, so one
 *                                                        process can serve many workspaces.
 * Logs go to stderr: stdout is the protocol in stdio mode.
 */
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { MeridianClient } from "./client.ts";
import { createServer } from "./server.ts";

const DEFAULT_HTTP_PORT = 4001;
const log = (...args: unknown[]) => console.error("[meridian-mcp]", ...args);

function parseArgs(argv: string[]): { mode: "stdio" } | { mode: "http"; port: number } {
  const i = argv.indexOf("--http");
  if (i === -1) return { mode: "stdio" };
  const next = argv[i + 1];
  const port = next && /^\d+$/.test(next) ? Number(next) : Number(process.env.MERIDIAN_MCP_PORT ?? DEFAULT_HTTP_PORT);
  return { mode: "http", port };
}

function bearerToken(header: string | undefined): string | undefined {
  const m = header?.match(/^Bearer\s+(\S+)$/i);
  return m?.[1];
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

async function runStdio(): Promise<void> {
  const client = MeridianClient.fromEnv();
  if (!client.apiKey) log("MERIDIAN_API_KEY is not set: requests go out unauthenticated (only works against a dev API with MERIDIAN_DEV_WORKSPACE).");
  const server = createServer(client);
  await server.connect(new StdioServerTransport());
  log(`stdio transport ready; API ${client.baseUrl}`);
}

function runHttp(port: number): void {
  const base = MeridianClient.fromEnv();
  const http = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") return sendJson(res, 200, { ok: true, server: "meridian-mcp", api: base.baseUrl });
    if (url.pathname !== "/mcp") return sendJson(res, 404, { error: { code: "not_found", message: "The MCP endpoint is /mcp" } });
    if (req.method !== "POST") return sendJson(res, 405, rpcError(-32000, "Method not allowed: this server is stateless and accepts POST only"), { allow: "POST" });

    const key = bearerToken(req.headers.authorization) ?? base.apiKey;
    if (!key) {
      return sendJson(
        res,
        401,
        { error: { code: "unauthorized", message: "Send the workspace API key as 'Authorization: Bearer mer_...' (or set MERIDIAN_API_KEY for a single-workspace server)" } },
        { "www-authenticate": 'Bearer realm="meridian"' },
      );
    }

    // Stateless: a fresh server + transport per request, bound to the key that identifies the workspace.
    const server = createServer(base.withApiKey(key));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      log("request failed:", err);
      if (!res.headersSent) sendJson(res, 500, rpcError(-32603, "Internal server error"));
    }
  });
  http.listen(port, () => log(`Streamable HTTP ready at http://localhost:${port}/mcp; API ${base.baseUrl}`));
  const shutdown = () => {
    http.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const args = parseArgs(process.argv.slice(2));
if (args.mode === "http") {
  runHttp(args.port);
} else {
  runStdio().catch((err) => {
    log("failed to start:", err);
    process.exit(1);
  });
}
