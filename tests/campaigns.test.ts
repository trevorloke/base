import { describe, expect, it } from "vitest";
import { campaignShareLinks, nextAsks } from "@/app/act/links";

describe("share links", () => {
  const links = campaignShareLinks({ url: "https://imaginesurrey.ca/act/skytrain-south-surrey", text: "I signed. Add your name:" });
  it("tags every channel with its own source", () => {
    expect(decodeURIComponent(links.whatsapp)).toContain("/act/skytrain-south-surrey?source=share-whatsapp");
    expect(decodeURIComponent(links.sms)).toContain("source=share-sms");
    expect(decodeURIComponent(links.facebook)).toContain("source=share-facebook");
    expect(decodeURIComponent(links.x)).toContain("source=share-x");
    expect(decodeURIComponent(links.email)).toContain("source=share-email");
    expect(links.copy).toBe("https://imaginesurrey.ca/act/skytrain-south-surrey?source=share-copy");
  });
  it("puts the share text in the message", () => {
    expect(decodeURIComponent(links.whatsapp)).toContain("I signed. Add your name:");
  });
  it("tags the next asks with the campaign", () => {
    expect(nextAsks("skytrain-south-surrey").map((a) => a.href)).toEqual([
      "/join?source=act-skytrain-south-surrey",
      "/donate?source=act-skytrain-south-surrey",
      "/volunteer?source=act-skytrain-south-surrey",
    ]);
  });
});
