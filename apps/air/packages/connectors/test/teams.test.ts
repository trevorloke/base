import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountRef, ConnectorError, PublishInput } from "../src/index.ts";
import { TeamsConnector, createTeamsConnectors, isLegacyTeamsWebhook, mapTeamsError, parseTeamsWebhookUrl, teamsCardMessage } from "../src/teams.ts";

const SIG = "Zk1t-3vR9n2QpAbCdEfGhIjKlMnOpQrStUvWxYz01";
const PP_URL = `https://default0123456789abcdef0123456789ab.cd.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/3f1c2b4a5d6e7f8091a2b3c4d5e6f708/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=${SIG}`;
const LOGIC_URL = `https://prod-27.westeurope.logic.azure.com:443/workflows/a1b2c3d4e5f60718293a4b5c6d7e8f90/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=${SIG}`;

const acct: AccountRef = { id: "acc1", workspaceId: "w", network: "teams", externalId: "3f1c2b4a5d6e7f8091a2b3c4d5e6f708", handle: "Teams workflow 3f1c2b4a", auth: { webhookUrl: PP_URL }, config: {} };
const input: PublishInput = { variantId: "v1", text: "Release **2.0** ships today", media: [], thread: [], idempotencyKey: "k1" };

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
function call(i: number) {
  const c = fetchMock.mock.calls[i];
  if (!c) throw new Error(`fetch call ${i} was not made`);
  const [url, init] = c;
  return { url: String(url), method: init?.method, headers: (init?.headers ?? {}) as Record<string, string>, json: () => JSON.parse(String(init?.body)) as Record<string, unknown> };
}
beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

async function rejects(p: Promise<unknown>): Promise<ConnectorError> {
  try {
    await p;
  } catch (err) {
    return err as ConnectorError;
  }
  throw new Error("expected a rejection");
}

describe("teams URL validation", () => {
  it("accepts Power Platform and Logic Apps workflow URLs", () => {
    expect(parseTeamsWebhookUrl(PP_URL)).toMatchObject({ workflowId: "3f1c2b4a5d6e7f8091a2b3c4d5e6f708", host: "default0123456789abcdef0123456789ab.cd.environment.api.powerplatform.com", sig: SIG });
    expect(parseTeamsWebhookUrl(LOGIC_URL)).toMatchObject({ workflowId: "a1b2c3d4e5f60718293a4b5c6d7e8f90", host: "prod-27.westeurope.logic.azure.com" });
  });
  it("rejects other hosts, http, missing sig, other paths and legacy connector URLs", () => {
    expect(parseTeamsWebhookUrl(PP_URL.replace("https://", "http://"))).toBeNull();
    expect(parseTeamsWebhookUrl(PP_URL.replace("environment.api.powerplatform.com", "environment.api.powerplatform.com.evil.example"))).toBeNull();
    expect(parseTeamsWebhookUrl(LOGIC_URL.replace("logic.azure.com", "logic-azure.com"))).toBeNull();
    expect(parseTeamsWebhookUrl(PP_URL.replace(`&sig=${SIG}`, ""))).toBeNull();
    expect(parseTeamsWebhookUrl(PP_URL.replace("/paths/invoke", "/run"))).toBeNull();
    expect(parseTeamsWebhookUrl(PP_URL.replace(":443", ":8443"))).toBeNull();
    expect(parseTeamsWebhookUrl("not a url")).toBeNull();
    expect(isLegacyTeamsWebhook("https://acme.webhook.office.com/webhookb2/abc@def/IncomingWebhook/123/456")).toBe(true);
  });
  it("connects without a network call; legacy URLs get a migration hint", async () => {
    const c = new TeamsConnector();
    const [a] = await c.connectWithInputs({ network: "teams", inputs: { webhookUrl: ` ${PP_URL} ` } });
    expect(a).toMatchObject({ network: "teams", identity: { externalId: "3f1c2b4a5d6e7f8091a2b3c4d5e6f708", handle: "Teams workflow 3f1c2b4a", displayName: null }, config: { workflowId: "3f1c2b4a5d6e7f8091a2b3c4d5e6f708" } });
    expect(String(a!.auth.webhookUrl)).not.toContain(":443");
    expect(fetchMock).not.toHaveBeenCalled();
    const e = await rejects(c.connectWithInputs({ network: "teams", inputs: { webhookUrl: "https://acme.webhook.office.com/webhookb2/abc@def/IncomingWebhook/123/456" } }));
    expect(e).toMatchObject({ kind: "auth" });
    expect(e.message).toContain("Workflows");
    expect(await rejects(c.connectWithInputs({ network: "teams", inputs: { webhookUrl: "https://example.com/hook" } }))).toMatchObject({ kind: "auth" });
    expect(c.capabilities()).toMatchObject({ publish: true, fetchActivity: false, reply: false, moderate: false, accountMetrics: false, webhooks: false, kinds: ["post", "link"] });
    expect(c.credentialInputs[0]).toMatchObject({ key: "webhookUrl", secret: true });
  });
});

describe("teams publish", () => {
  it("posts an Adaptive Card in the message envelope with text, image and link", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 202, headers: { "x-ms-workflow-run-id": "08584512345678901234567890CU12" } }));
    const r = await new TeamsConnector().publish(acct, { ...input, options: { link: "https://acme.example/release", title: "Release 2.0" }, media: [{ kind: "image", url: "https://cdn.example/banner.png", alt: "Banner" }] });
    expect(call(0)).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
    expect(call(0).url).toBe(PP_URL.replace(":443", ""));
    expect(call(0).json()).toEqual({
      type: "message",
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          contentUrl: null,
          content: {
            $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
            type: "AdaptiveCard",
            version: "1.4",
            body: [
              { type: "TextBlock", text: "Release 2.0", weight: "Bolder", size: "Medium", wrap: true },
              { type: "TextBlock", text: "Release **2.0** ships today", wrap: true },
              { type: "Image", url: "https://cdn.example/banner.png", altText: "Banner", size: "Stretch" },
            ],
            msteams: { width: "Full" },
            actions: [{ type: "Action.OpenUrl", title: "Open link", url: "https://acme.example/release" }],
          },
        },
      ],
    });
    expect(r).toMatchObject({ externalId: "3f1c2b4a5d6e7f8091a2b3c4d5e6f708:08584512345678901234567890CU12", url: null });
  });

  it("derives an external id from the idempotency key when no run id comes back, and does not post twice", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 202 }));
    const c = new TeamsConnector();
    const r1 = await c.publish(acct, input);
    const r2 = await c.publish(acct, input);
    expect(r1.externalId).toMatch(/^3f1c2b4a5d6e7f8091a2b3c4d5e6f708:k-[0-9a-f]{20}$/);
    expect(r2).toEqual(r1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("validates media, threads, size and emptiness", () => {
    const c = new TeamsConnector();
    expect(c.validate(acct, { ...input, media: [{ kind: "video", url: "https://cdn.example/a.mp4" }] }).map((i) => i.code)).toEqual(["unsupported_media"]);
    expect(c.validate(acct, { ...input, media: [{ kind: "image", url: "http://cdn.example/a.png" }] }).map((i) => i.code)).toEqual(["unsupported_media"]);
    expect(c.validate(acct, { ...input, media: [{ kind: "image", url: "https://a/1.png" }, { kind: "image", url: "https://a/2.png" }] }).map((i) => i.code)).toEqual(["too_many_media"]);
    expect(c.validate(acct, { ...input, thread: ["more"] }).map((i) => i.code)).toEqual(["thread_unsupported"]);
    expect(c.validate(acct, { ...input, text: "x".repeat(29_000) }).map((i) => i.code)).toEqual(["too_long"]);
    expect(c.validate(acct, { ...input, text: "" }).map((i) => i.code)).toEqual(["empty"]);
    expect(teamsCardMessage({ text: "hi" })).not.toHaveProperty("attachments.0.content.actions");
  });

  it("maps errors without leaking the signature", async () => {
    expect(mapTeamsError(429, new Headers({ "retry-after": "20" }), undefined, "post")).toMatchObject({ kind: "rate_limit", retryable: true, cause: { retryAfter: 20 } });
    expect(mapTeamsError(400, new Headers(), { error: { code: "InvalidRequestContent", message: "bad JSON" } }, "post")).toMatchObject({ kind: "rejected" });
    expect(mapTeamsError(404, new Headers(), { error: { code: "WorkflowNotFound" } }, "post")).toMatchObject({ kind: "auth" });
    expect(mapTeamsError(409, new Headers(), { error: { code: "WorkflowDisabled" } }, "post")).toMatchObject({ kind: "auth" });
    expect(mapTeamsError(502, new Headers(), undefined, "post")).toMatchObject({ kind: "network", retryable: true });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "DirectApiAuthorizationRequired", message: "sig invalid" } }), { status: 401 }));
    expect(await rejects(new TeamsConnector().publish(acct, { ...input, idempotencyKey: "k2" }))).toMatchObject({ kind: "auth", retryable: false });
    fetchMock.mockRejectedValueOnce(new TypeError(`connect ECONNRESET ${PP_URL}`));
    const e = await rejects(new TeamsConnector().publish(acct, { ...input, idempotencyKey: "k3" }));
    expect(e).toMatchObject({ kind: "network", retryable: true });
    expect(e.message).not.toContain(SIG);
    expect(createTeamsConnectors({}).map((x) => x.name)).toEqual(["teams"]);
  });
});
