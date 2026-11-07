import { describe, expect, it } from "vitest";
import { ConnectorError } from "@starsign/connectors";
import { connectFailureReason } from "../src/services/accounts.ts";

describe("connect failure reasons", () => {
  it("keeps the connector's own hint for bad credentials instead of a generic line", () => {
    const e = new ConnectorError("telegram: that does not look like a bot token (123456789:AA...)", "auth", false);
    expect(connectFailureReason(e, "telegram")).toBe("The credentials were not accepted: That does not look like a bot token (123456789:AA...)");
    expect(connectFailureReason(new ConnectorError("line getBotInfo: Unauthorized", "auth", false), "line")).toBe("The credentials were not accepted. Check them and try again.");
  });

  it("never blames the credentials when the server could not reach the network", () => {
    const reach = /couldn't reach the network/;
    expect(connectFailureReason(new ConnectorError("telegram getMe: fetch failed", "network", true), "telegram")).toMatch(reach);
    expect(connectFailureReason(new Error("mastodon POST /api/v1/apps (mastodon.invalid): fetch failed"), "mastodon")).toMatch(reach);
    expect(connectFailureReason(new ConnectorError("bluesky login: fetch failed", "auth", false), "bluesky")).toMatch(reach);
  });

  it("says what the network refused, without the call that refused it", () => {
    expect(connectFailureReason(new ConnectorError("telegram: the bot @acme_bot is not an admin of Acme; add it as an administrator first", "rejected", false), "telegram")).toBe(
      "The bot @acme_bot is not an admin of Acme; add it as an administrator first.",
    );
    expect(connectFailureReason(new Error("wechat: AppID looks like wx followed by 16 letters or digits"), "wechat")).toBe("AppID looks like wx followed by 16 letters or digits.");
    expect(connectFailureReason(new ConnectorError("discord_bot: paste a webhook URL like https://discord.com/api/webhooks/<id>/<token>", "auth", false), "discord_bot")).toMatch(/^The credentials were not accepted: Paste a webhook URL like https:\/\/discord\.com/);
  });
});
