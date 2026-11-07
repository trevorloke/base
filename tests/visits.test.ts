import { describe, expect, it, vi } from "vitest";
import { cleanPath, isBotUserAgent, isUntrackedPath, MAX_PATH_LENGTH, referrerHost } from "@/lib/visits";

vi.mock("server-only", () => ({}));
const { hashVisitor, pageViewRow, saltStore, VISITOR_HASH_LENGTH } = await import("@/lib/server/visits");

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const OWN = ["imaginesurrey.ca", "imaginesurreywebsite.onrender.com"];

describe("visitor hash", () => {
  const salt = "a".repeat(64);
  it("is a short hex digest that doesn't contain the IP or user agent", () => {
    const h = hashVisitor(salt, "203.0.113.7", CHROME);
    expect(h).toMatch(new RegExp(`^[0-9a-f]{${VISITOR_HASH_LENGTH}}$`));
    expect(h).not.toContain("203");
    expect(h.length).toBeLessThan(64);
  });
  it("is the same for the same visitor on the same day", () => {
    expect(hashVisitor(salt, "203.0.113.7", CHROME)).toBe(hashVisitor(salt, "203.0.113.7", CHROME));
  });
  it("differs by IP, by browser and by day's salt", () => {
    const base = hashVisitor(salt, "203.0.113.7", CHROME);
    expect(hashVisitor(salt, "203.0.113.8", CHROME)).not.toBe(base);
    expect(hashVisitor(salt, "203.0.113.7", IPHONE)).not.toBe(base);
    expect(hashVisitor("b".repeat(64), "203.0.113.7", CHROME)).not.toBe(base);
  });
  it("can't be confused by moving characters between the IP and the user agent", () => {
    expect(hashVisitor(salt, "1.2.3.4", "5 x")).not.toBe(hashVisitor(salt, "1.2.3.45", " x"));
  });
});

describe("day rollover", () => {
  it("uses one salt all day and a new one the next day", async () => {
    const load = vi.fn(async (day: string) => `salt-for-${day}`);
    const store = saltStore(load);
    expect(await store.get("2026-11-07")).toBe("salt-for-2026-11-07");
    expect(await store.get("2026-11-07")).toBe("salt-for-2026-11-07");
    expect(load).toHaveBeenCalledTimes(1);
    expect(await store.get("2026-11-08")).toBe("salt-for-2026-11-08");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("gives the same visitor a different hash after midnight", () => {
    const before = pageViewRow({ path: "/", referrer: "", source: null, ref: null, ip: "203.0.113.7", userAgent: CHROME, ownHosts: OWN }, "salt-day-1", "2026-11-07");
    const after = pageViewRow({ path: "/", referrer: "", source: null, ref: null, ip: "203.0.113.7", userAgent: CHROME, ownHosts: OWN }, "salt-day-2", "2026-11-08");
    expect(before?.day).toBe("2026-11-07");
    expect(after?.day).toBe("2026-11-08");
    expect(before?.visitorHash).not.toBe(after?.visitorHash);
  });

  it("retries a salt that failed to load instead of keeping the failure", async () => {
    let calls = 0;
    const store = saltStore(async () => {
      calls += 1;
      if (calls === 1) throw new Error("database down");
      return "ok";
    });
    await expect(store.get("2026-11-07")).rejects.toThrow("database down");
    expect(await store.get("2026-11-07")).toBe("ok");
  });
});

describe("referrer parsing", () => {
  it("keeps only the hostname", () => {
    expect(referrerHost("https://www.facebook.com/groups/surrey/posts/123?fbclid=abc", OWN)).toBe("facebook.com");
    expect(referrerHost("https://l.instagram.com/?u=https%3A%2F%2Fimaginesurrey.ca", OWN)).toBe("l.instagram.com");
    expect(referrerHost("http://News.Example.CA:8080/story#top", OWN)).toBe("news.example.ca");
  });
  it("is null for the site's own pages", () => {
    expect(referrerHost("https://imaginesurrey.ca/act", OWN)).toBeNull();
    expect(referrerHost("https://www.imaginesurrey.ca/", OWN)).toBeNull();
    expect(referrerHost("https://imaginesurreywebsite.onrender.com/donate", OWN)).toBeNull();
  });
  it("is null for nothing, junk and non-web referrers", () => {
    expect(referrerHost("", OWN)).toBeNull();
    expect(referrerHost(undefined, OWN)).toBeNull();
    expect(referrerHost(42, OWN)).toBeNull();
    expect(referrerHost("not a url", OWN)).toBeNull();
    expect(referrerHost("android-app://com.whatsapp/", OWN)).toBeNull();
    expect(referrerHost("javascript:alert(1)", OWN)).toBeNull();
  });
});

describe("paths", () => {
  it("drops the query string and fragment", () => {
    expect(cleanPath("/act/skytrain-south-surrey?source=whatsapp&email=a@b.ca")).toBe("/act/skytrain-south-surrey");
    expect(cleanPath("/#join")).toBe("/");
    expect(cleanPath("/")).toBe("/");
  });
  it("caps the length", () => {
    expect(cleanPath("/" + "a".repeat(5000))!.length).toBe(MAX_PATH_LENGTH);
  });
  it("refuses anything that isn't a site path", () => {
    expect(cleanPath("https://evil.example/")).toBeNull();
    expect(cleanPath("//evil.example/")).toBeNull();
    expect(cleanPath("act")).toBeNull();
    expect(cleanPath("/a b")).toBeNull();
    expect(cleanPath("/a\nb")).toBeNull();
    expect(cleanPath(null)).toBeNull();
  });
  it("never counts the admin, the portal or the API", () => {
    for (const p of ["/admin", "/admin/people", "/me", "/me/preferences", "/api", "/api/v"]) expect(isUntrackedPath(p)).toBe(true);
    for (const p of ["/", "/act", "/media", "/meet-us", "/administration", "/apiary"]) expect(isUntrackedPath(p)).toBe(false);
  });
});

describe("bots", () => {
  it("skips crawlers, previews, scripts and headless browsers", () => {
    for (const ua of [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36",
      "curl/8.5.0",
      "python-requests/2.32",
      "Mozilla/5.0 (compatible; bingbot/2.0)",
      "WhatsApp/2.23.20.0 A",
      "",
    ])
      expect(isBotUserAgent(ua)).toBe(true);
    expect(isBotUserAgent(null)).toBe(true);
  });
  it("counts ordinary browsers", () => {
    expect(isBotUserAgent(CHROME)).toBe(false);
    expect(isBotUserAgent(IPHONE)).toBe(false);
  });
});

describe("the stored row", () => {
  const input = {
    path: "/act/skytrain-south-surrey?email=someone@example.com",
    referrer: "https://www.facebook.com/some/post",
    source: "whatsapp",
    ref: "REF123",
    ip: "198.51.100.23",
    userAgent: CHROME,
    ownHosts: OWN,
  };
  it("holds no IP address, user agent or query string", () => {
    const row = pageViewRow(input, "salt", "2026-11-07")!;
    expect(row).toEqual({ day: "2026-11-07", path: "/act/skytrain-south-surrey", referrerHost: "facebook.com", source: "whatsapp", ref: "REF123", visitorHash: expect.any(String) });
    const text = JSON.stringify(row);
    expect(text).not.toContain("198.51.100.23");
    expect(text).not.toContain("Chrome");
    expect(text).not.toContain("someone@example.com");
  });
  it("drops a malformed source or ref instead of storing it", () => {
    const row = pageViewRow({ ...input, source: "<script>", ref: "x".repeat(40) }, "salt", "2026-11-07")!;
    expect(row.source).toBeNull();
    expect(row.ref).toBe("x".repeat(20));
  });
  it("is null for bots and untracked paths", () => {
    expect(pageViewRow({ ...input, userAgent: "Googlebot/2.1" }, "salt", "2026-11-07")).toBeNull();
    expect(pageViewRow({ ...input, path: "/admin/people" }, "salt", "2026-11-07")).toBeNull();
  });
});
