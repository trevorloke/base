import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorError, type AccountRef, type PublishInput } from "../src/index.ts";
import { GoogleBusinessConnector, buildLocalPost, createGoogleBusinessConnectors, type GoogleBusinessConnectorOptions } from "../src/google-business.ts";

const NOW = new Date("2026-11-03T12:00:00.000Z");
const LOC = "accounts/111/locations/222";

const acct: AccountRef = {
  id: "acc-gbp",
  workspaceId: "w",
  network: "google_business",
  externalId: "locations/222",
  handle: "Acme Coffee",
  auth: { accessToken: "tok", refreshToken: "ref", expiresAt: "2026-11-03T13:00:00.000Z", accountName: "accounts/111", locationName: "locations/222" },
  config: { accountName: "accounts/111", locationName: "locations/222", languageCode: "en-GB", mapsUri: "https://maps.google.com/?cid=1" },
};

function input(over: Partial<PublishInput> = {}, options: Record<string, unknown> = {}): PublishInput {
  return { variantId: "v1", text: "Fresh pastries every morning", media: [], thread: [], idempotencyKey: "k1", options: options as PublishInput["options"], ...over };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}
let calls: Call[];
function route(handler: (url: URL, init: RequestInit) => Response) {
  fetchMock.mockImplementation(async (u, init = {}) => {
    const url = new URL(String(u));
    calls.push({ url, method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body: init.body });
    return handler(url, init);
  });
}

async function rejection(p: Promise<unknown>): Promise<ConnectorError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ConnectorError);
    return e as ConnectorError;
  }
  throw new Error("expected the promise to reject");
}

const connector = (opts: GoogleBusinessConnectorOptions = {}) => new GoogleBusinessConnector({ clientId: "cid", clientSecret: "secret", now: () => NOW, sleep: async () => undefined, ...opts });

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  calls = [];
});
afterEach(() => vi.unstubAllGlobals());

describe("google business connect", () => {
  it("asks for business.manage with offline access", () => {
    const u = new URL(connector().oauthAuthorizeUrl({ state: "s", codeChallenge: "c", redirectUri: "https://app/oauth/google_business/callback" }));
    expect(u.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/business.manage");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("redirect_uri")).toBe("https://app/oauth/google_business/callback");
  });

  it("is configured only with GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET", () => {
    expect(createGoogleBusinessConnectors({ GOOGLE_CLIENT_ID: "id" })[0]!.connectConfigured).toBe(false);
    const [c] = createGoogleBusinessConnectors({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" });
    expect(c).toMatchObject({ name: "google_business", networks: ["google_business"], connectConfigured: true });
  });

  it("connects every location of every account, paging and deduplicating, skipping unreadable accounts", async () => {
    route((url) => {
      if (url.host === "oauth2.googleapis.com") return json({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
      if (url.pathname === "/v1/accounts") {
        return url.searchParams.get("pageToken")
          ? json({ accounts: [{ name: "accounts/333", type: "LOCATION_GROUP" }, { name: "accounts/444", type: "ORGANIZATION" }] })
          : json({ accounts: [{ name: "accounts/111", type: "PERSONAL" }], nextPageToken: "p2" });
      }
      if (url.pathname === "/v1/accounts/111/locations") {
        expect(url.searchParams.get("readMask")).toContain("metadata");
        return url.searchParams.get("pageToken")
          ? json({ locations: [{ name: "locations/223", title: "Acme Roastery" }] })
          : json({ locations: [{ name: "locations/222", title: "Acme Coffee", languageCode: "en-GB", storefrontAddress: { locality: "Leeds" }, metadata: { placeId: "ChIJ1", mapsUri: "https://maps.google.com/?cid=1", hasVoiceOfMerchant: true } }], nextPageToken: "l2" });
      }
      if (url.pathname === "/v1/accounts/333/locations") return json({ locations: [{ name: "locations/222", title: "Acme Coffee" }] });
      if (url.pathname === "/v1/accounts/444/locations") return json({ error: { code: 403, status: "PERMISSION_DENIED", message: "denied" } }, 403);
      throw new Error(`unrouted ${url}`);
    });
    const accts = await connector().oauthConnect({ code: "c", codeVerifier: "v", redirectUri: "https://app/cb" });
    expect(accts.map((a) => a.identity)).toEqual([
      { externalId: "locations/222", handle: "Acme Coffee", displayName: "Acme Coffee (Leeds)" },
      { externalId: "locations/223", handle: "Acme Roastery", displayName: "Acme Roastery" },
    ]);
    expect(accts[0]!.auth).toEqual({ accessToken: "at", refreshToken: "rt", expiresAt: "2026-11-03T13:00:00.000Z", accountName: "accounts/111", locationName: "locations/222" });
    expect(accts[0]!.config).toEqual({ accountName: "accounts/111", locationName: "locations/222", languageCode: "en-GB", placeId: "ChIJ1", mapsUri: "https://maps.google.com/?cid=1", hasVoiceOfMerchant: true });
  });

  it("describes a location from its auth blob", async () => {
    route((url) => {
      expect(url.toString()).toMatch(/^https:\/\/mybusinessbusinessinformation\.googleapis\.com\/v1\/locations\/222\?readMask=/);
      return json({ name: "locations/222", title: "Acme Coffee" });
    });
    expect(await connector().describeAccount({ accessToken: "t", locationName: "locations/222" })).toEqual({ externalId: "locations/222", handle: "Acme Coffee", displayName: "Acme Coffee" });
  });

  it("refreshes tokens keeping the location", async () => {
    route(() => json({ access_token: "new", expires_in: 3600 }));
    expect((await connector().refreshAuth(acct))!.auth).toEqual({ accessToken: "new", refreshToken: "ref", expiresAt: "2026-11-03T13:00:00.000Z", accountName: "accounts/111", locationName: "locations/222" });
  });
});

describe("google business validate", () => {
  const c = connector();
  it("checks text, CTA link, photo-only media and event dates", () => {
    expect(c.validate(acct, input())).toEqual([]);
    expect(c.validate(acct, input({ text: " " }))[0]!.message).toMatch(/needs text/);
    expect(c.validate(acct, input({}, { callToAction: "BOOK" }))[0]!.message).toMatch(/options\.link/);
    expect(c.validate(acct, input({}, { callToAction: "CALL" }))).toEqual([]);
    expect(c.validate(acct, input({ media: [{ kind: "video", url: "https://m/v.mp4" }] }))[0]!.code).toBe("unsupported_media");
    expect(c.validate(acct, input({ media: [{ kind: "image", url: "https://m/i.gif", mime: "image/gif" }] }))[0]!.message).toMatch(/JPG or PNG/);
    expect(c.validate(acct, input({ media: [{ kind: "image", url: "https://m/i.png", width: 100, height: 100 }] }))[0]!.message).toMatch(/250x250/);
    expect(c.validate(acct, input({}, { googleBusiness: { topicType: "EVENT" } })).map((i) => i.message).join()).toMatch(/start and end date/);
    expect(c.validate(acct, input({}, { googleBusiness: { event: { startDate: "2026-12-01" } } }))[0]!.message).toMatch(/invalid/);
  });
});

describe("google business publish", () => {
  it("builds STANDARD, EVENT and OFFER bodies", () => {
    expect(buildLocalPost(input({ media: [{ kind: "image", url: "https://media.example/p.jpg" }] }, { callToAction: "ORDER", link: "https://acme.example/order" }), "en-GB")).toEqual({
      languageCode: "en-GB",
      topicType: "STANDARD",
      summary: "Fresh pastries every morning",
      callToAction: { actionType: "ORDER", url: "https://acme.example/order" },
      media: [{ mediaFormat: "PHOTO", sourceUrl: "https://media.example/p.jpg" }],
    });
    expect(buildLocalPost(input({}, { link: "https://acme.example" }), "en").callToAction).toEqual({ actionType: "LEARN_MORE", url: "https://acme.example" });
    expect(buildLocalPost(input({}, { callToAction: "CALL" }), "en").callToAction).toEqual({ actionType: "CALL" });
    expect(buildLocalPost(input({}, { title: "Latte art night", googleBusiness: { event: { startDate: "2026-12-01", endDate: "2026-12-01", startTime: "18:00", endTime: "21:30" } } }), "en")).toMatchObject({
      topicType: "EVENT",
      event: { title: "Latte art night", schedule: { startDate: { year: 2026, month: 12, day: 1 }, endDate: { year: 2026, month: 12, day: 1 }, startTime: { hours: 18, minutes: 0 }, endTime: { hours: 21, minutes: 30 } } },
    });
    const offer = buildLocalPost(input({}, { title: "20% off", callToAction: "SHOP", link: "https://acme.example", googleBusiness: { event: { startDate: "2026-12-01", endDate: "2026-12-24" }, offer: { couponCode: "XMAS20", termsConditions: "One per customer" } } }), "en");
    expect(offer).toMatchObject({ topicType: "OFFER", offer: { couponCode: "XMAS20", termsConditions: "One per customer" }, event: { title: "20% off" } });
    expect(offer.callToAction).toBeUndefined();
  });

  it("creates a local post, polls while PROCESSING, and is idempotent", async () => {
    let gets = 0;
    route((url, init) => {
      if (init.method === "POST") return json({ name: `${LOC}/localPosts/9`, state: "PROCESSING" });
      gets++;
      return json({ name: `${LOC}/localPosts/9`, state: gets < 2 ? "PROCESSING" : "LIVE", searchUrl: "https://local.google.com/place?id=1&use=posts&lpsid=9" });
    });
    const c = connector();
    const res = await c.publish(acct, input());
    expect(res).toMatchObject({ externalId: `${LOC}/localPosts/9`, url: "https://local.google.com/place?id=1&use=posts&lpsid=9", raw: { state: "LIVE" } });
    expect(calls[0]!.url.toString()).toBe(`https://mybusiness.googleapis.com/v4/${LOC}/localPosts`);
    expect(JSON.parse(String(calls[0]!.body))).toMatchObject({ languageCode: "en-GB", topicType: "STANDARD", summary: "Fresh pastries every morning" });
    expect(gets).toBe(2);
    await c.publish(acct, input());
    expect(calls.filter((x) => x.method === "POST")).toHaveLength(1);
  });

  it("maps a rejected post and refuses invalid input before calling", async () => {
    route(() => json({ name: `${LOC}/localPosts/10`, state: "REJECTED" }));
    expect((await rejection(connector().publish(acct, input()))).kind).toBe("rejected");
    calls = [];
    expect((await rejection(connector().publish(acct, input({ idempotencyKey: "k2" }, { callToAction: "BOOK" })))).kind).toBe("rejected");
    expect(calls).toHaveLength(0);
  });

  it("maps the 0-QPM (no API access) 429 to rate_limit with guidance", async () => {
    route(() => json({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for quota metric 'Requests'" } }, 429));
    const e = await rejection(connector().publish(acct, input()));
    expect(e).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(e.message).toMatch(/quota of 0/);
  });
});

describe("google business reviews", () => {
  it("maps reviews to comment activity with the rating, stopping at `since`", async () => {
    route((url) => {
      expect(url.pathname).toBe(`/v4/${LOC}/reviews`);
      expect(url.searchParams.get("orderBy")).toBe("updateTime desc");
      return json({
        reviews: [
          { name: `${LOC}/reviews/r2`, reviewer: { displayName: "Sam" }, starRating: "FIVE", comment: "Best flat white", createTime: "2026-11-02T08:00:00Z", updateTime: "2026-11-02T08:00:00Z" },
          { name: `${LOC}/reviews/r1`, reviewer: { isAnonymous: true, displayName: "A Google user" }, starRating: "TWO", createTime: "2026-11-01T08:00:00Z", updateTime: "2026-11-01T09:00:00Z" },
          { name: `${LOC}/reviews/r0`, starRating: "FOUR", createTime: "2026-10-01T08:00:00Z", updateTime: "2026-10-01T08:00:00Z" },
        ],
        nextPageToken: "next",
      });
    });
    const items = await connector().fetchActivity(acct, new Date("2026-10-15T00:00:00Z"));
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ network: "google_business", kind: "comment", externalId: `${LOC}/reviews/r2`, authorName: "Sam", authorHandle: null, text: "Best flat white", parentExternalId: "locations/222", url: "https://maps.google.com/?cid=1", occurredAt: "2026-11-02T08:00:00Z" });
    expect((items[1]!.raw as { rating: number }).rating).toBe(5);
    expect(items[0]).toMatchObject({ authorName: null, text: null });
    expect((items[0]!.raw as { rating: number }).rating).toBe(2);
    expect(calls).toHaveLength(1);
  });

  it("replies to a review with updateReply and deletes the reply", async () => {
    route((_url, init) => (init.method === "PUT" ? json({ comment: "Thank you, Sam!", updateTime: "2026-11-03T12:00:00Z" }) : json({})));
    const c = connector();
    const r = await c.reply(acct, { parentExternalId: `${LOC}/reviews/r2`, text: "Thank you, Sam!", idempotencyKey: "x" });
    expect(r.externalId).toBe(`${LOC}/reviews/r2/reply`);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url.toString()).toBe(`https://mybusiness.googleapis.com/v4/${LOC}/reviews/r2/reply`);
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ comment: "Thank you, Sam!" });
    await c.moderate(acct, { externalId: r.externalId, action: "delete" });
    expect(calls[1]).toMatchObject({ method: "DELETE" });
    expect(calls[1]!.url.pathname).toBe(`/v4/${LOC}/reviews/r2/reply`);
  });

  it("refuses replies to posts and moderation other than deleting a reply", async () => {
    const c = connector();
    expect((await rejection(c.reply(acct, { parentExternalId: `${LOC}/localPosts/9`, text: "hi", idempotencyKey: "x" }))).kind).toBe("rejected");
    expect((await rejection(c.moderate(acct, { externalId: `${LOC}/reviews/r2`, action: "hide" }))).kind).toBe("rejected");
    expect(calls).toHaveLength(0);
  });
});

describe("google business metrics", () => {
  it("sums Performance API series into canonical account metrics and exposes the surface breakdown", async () => {
    route((url) => {
      expect(url.host).toBe("businessprofileperformance.googleapis.com");
      expect(url.pathname).toBe("/v1/locations/222:fetchMultiDailyMetricsTimeSeries");
      expect(url.searchParams.getAll("dailyMetrics")).toContain("CALL_CLICKS");
      expect(url.searchParams.get("dailyRange.startDate.month")).toBe("10");
      expect(url.searchParams.get("dailyRange.startDate.day")).toBe("6");
      expect(url.searchParams.get("dailyRange.endDate.day")).toBe("2");
      const s = (dailyMetric: string, values: (string | undefined)[]) => ({ dailyMetric, timeSeries: { datedValues: values.map((value, i) => ({ date: { year: 2026, month: 11, day: i + 1 }, ...(value ? { value } : {}) })) } });
      return json({
        multiDailyMetricTimeSeries: [
          {
            dailyMetricTimeSeries: [
              s("BUSINESS_IMPRESSIONS_DESKTOP_MAPS", ["10", "5"]),
              s("BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", ["20", undefined]),
              s("BUSINESS_IMPRESSIONS_MOBILE_MAPS", ["30"]),
              s("BUSINESS_IMPRESSIONS_MOBILE_SEARCH", ["40"]),
              s("CALL_CLICKS", ["3"]),
              s("WEBSITE_CLICKS", ["4", "1"]),
              s("BUSINESS_DIRECTION_REQUESTS", ["2"]),
              s("BUSINESS_CONVERSATIONS", ["1"]),
            ],
          },
        ],
      });
    });
    const c = connector();
    const rows = await c.fetchAccountMetrics(acct);
    expect(Object.fromEntries(rows.map((r) => [r.metric, r.value]))).toEqual({ impressions: 105, link_clicks: 5, clicks: 10, engagements: 11 });
    expect(rows.every((r) => r.entityType === "social_account" && r.entityId === "acc-gbp")).toBe(true);
    const p = await c.fetchPerformance(acct, { startDate: "2026-10-06", endDate: "2026-11-02" });
    expect(p).toMatchObject({ impressionsBySurface: { desktopMaps: 15, desktopSearch: 20, mobileMaps: 30, mobileSearch: 40 }, calls: 3, websiteClicks: 5, directionRequests: 2 });
    expect(await c.fetchMetrics()).toEqual([]);
  });

  it("maps auth and server errors", async () => {
    route(() => json({ error: { code: 401, status: "UNAUTHENTICATED" } }, 401));
    expect((await rejection(connector().fetchActivity(acct, null))).kind).toBe("auth");
    route(() => json({ error: { code: 503, status: "UNAVAILABLE" } }, 503));
    expect(await rejection(connector().fetchActivity(acct, null))).toMatchObject({ kind: "network", retryable: true });
    expect((await rejection(connector().fetchActivity({ ...acct, auth: null, config: {} }, null))).kind).toBe("auth");
  });
});
