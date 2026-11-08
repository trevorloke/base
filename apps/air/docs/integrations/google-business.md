# Google Business Profile

Connector `google_business` (network `google_business`), in `packages/connectors/src/google-business.ts`, with shared
Google plumbing in `packages/connectors/src/google-oauth.ts`. Factory: `createGoogleBusinessConnectors(env)`.

APIs used:

| API | Base | Used for |
|---|---|---|
| My Business Account Management API v1 | `https://mybusinessaccountmanagement.googleapis.com/v1` | `accounts.list` |
| My Business Business Information API v1 | `https://mybusinessbusinessinformation.googleapis.com/v1` | `accounts.locations.list`, `locations.get` |
| Google My Business API v4 (still current for these resources) | `https://mybusiness.googleapis.com/v4` | `localPosts.create/get`, `reviews.list`, `reviews.updateReply`, `reviews.deleteReply` |
| Business Profile Performance API v1 | `https://businessprofileperformance.googleapis.com/v1` | `locations.fetchMultiDailyMetricsTimeSeries` |

## What works

| Area | Behaviour |
|---|---|
| Connect | Google OAuth (PKCE, `access_type=offline`, `prompt=consent`), scope `business.manage`. `oauthConnect` walks every account (`accounts.list`, paged) and every location of each (`locations.list`, paged) and returns one account per location, deduplicated when a location is reachable through several accounts. One unreadable account (403) does not hide the others. `externalId` = location resource name `locations/{id}`; handle = location title; display name adds the locality. Auth blob: `{accessToken, refreshToken, expiresAt, scope, accountName, locationName}`. Config: `accountName`, `locationName`, `languageCode`, `placeId`, `mapsUri`, `hasVoiceOfMerchant`. `describeAccount` reads the location; `refreshAuth` refreshes the token. `connectConfigured` needs `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. |
| Publish | Local posts via v4 `localPosts.create`. The post text becomes `summary` (at most 1,500 characters, enforced by the generic limits). `languageCode` comes from the location. The `topicType` options are listed in the next three rows. While Google reports `PROCESSING`, the connector polls `localPosts.get` (3 × 2 s). `REJECTED` → `rejected` error. Still processing after the wait → success with `raw.state`. Idempotent per key. Result: `externalId` = `accounts/…/locations/…/localPosts/…`, `url` = `searchUrl`. |
| `STANDARD` ("What's new") | The default topic type. Needs text. |
| `EVENT` | Needs `options.title` (or `event.title`) and `options.googleBusiness.event` = `{startDate, endDate, startTime?, endTime?}` (`YYYY-MM-DD`, `HH:MM`). |
| `OFFER` | Same event dates, plus `options.googleBusiness.offer` = `{couponCode?, redeemOnlineUrl?, termsConditions?}`. |
| Call to action | `options.callToAction` (BOOK, ORDER, SHOP, LEARN_MORE, SIGN_UP, CALL) plus `options.link`. `CALL` needs no link (Google uses the listing's phone number). The others need `options.link`, which `validate()` enforces. A link without a CTA becomes `LEARN_MORE`. OFFER posts get no CTA button. |
| Photo | One photo: `media[0]` must be an image, JPG/PNG, 10 KB–5 MB, at least 250×250 when the metadata is known. Sent as `{mediaFormat: "PHOTO", sourceUrl}` (pull-style: Google fetches the public URL from Base Air's media library). Video is refused. |
| Inbox | `fetchActivity` lists reviews (`orderBy=updateTime desc`, 50 per page, up to 4 pages) and stops at `since`. Each review becomes `kind: "comment"`, `externalId` = review resource name, `parentExternalId` = location, `authorName` = reviewer (null when anonymous), `text` = comment (null for a rating-only review), `url` = the location's Maps URL, `raw` = the review plus `rating` (1–5). |
| Reply | Only to reviews: `PUT …/reviews/{id}/reply` with `{comment}` (at most 4,096 bytes). The call creates the reply or replaces the existing one, so it is naturally idempotent. Returns `externalId` = `…/reviews/{id}/reply`. Local posts cannot be replied to, so core's first-comment step records a clear error if `options.firstComment` is set. |
| Moderate | `delete` on a review or reply id → `DELETE …/reviews/{id}/reply` (removes the business's reply). Google offers no API to hide or delete reviews themselves, so every other action → `rejected`. |
| Metrics | Per-post insights are not available: the v4 `reportInsights` and local-post insights methods were retired. `fetchMetrics` returns `[]` and the capability is false. |
| Account metrics | `fetchAccountMetrics` sums the Performance API's daily series over a trailing 28-day window ending yesterday (the data lags). It maps them to `impressions` (desktop/mobile × Maps/Search), `link_clicks` (WEBSITE_CLICKS), `clicks` (CALL_CLICKS + WEBSITE_CLICKS + BUSINESS_DIRECTION_REQUESTS) and `engagements` (clicks + BUSINESS_CONVERSATIONS + BUSINESS_BOOKINGS + BUSINESS_FOOD_ORDERS). `fetchPerformance(account, {startDate, endDate})` is public and returns the full breakdown (`impressionsBySurface`, `calls`, `websiteClicks`, `directionRequests`, every raw total), because `MetricName` has no per-surface, calls or directions names. |
| Webhooks | Not implemented (`webhooks: false`). Google delivers review notifications through Cloud Pub/Sub (`mybusinessnotifications` v1), not a plain HTTPS webhook. Reviews are polled. |
| Errors | Same mapper as YouTube. 429 / `RESOURCE_EXHAUSTED` → `rate_limit`, retryable, with a hint that a project without approved API access has a quota of 0. 401 and credential-reason 403s → `auth`. Other 403s on writes → `rejected`. 400/404 → `rejected`. 5xx and transport errors → `network`, retryable. |

Capabilities: `publish`, `fetchActivity`, `reply`, `moderate`, `accountMetrics`; `fetchMetrics: false`, `video: false`,
`webhooks: false`, `kinds: ["post"]`.

## Setup

1. In Google Cloud Console (the same project and OAuth client as YouTube works), enable:
   - My Business Account Management API
   - My Business Business Information API
   - Google My Business API (v4: posts and reviews)
   - Business Profile Performance API
2. **Request API access** (see the next section). Until Google approves it, the quotas read 0 and every call returns 429.
3. OAuth consent screen: as for YouTube, add the scope `https://www.googleapis.com/auth/business.manage`.
4. OAuth client (Web application): add the redirect URI `${BASE_AIR_PUBLIC_URL}/oauth/google_business/callback`.
5. Env vars (shared with YouTube): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
6. Webhook URL: not used (`${BASE_AIR_PUBLIC_URL}/webhooks/google_business` is not registered).

The person connecting must be an owner or manager of the Business Profile(s). Only locations that are verified can publish posts (config `hasVoiceOfMerchant: true`).

## Review and access requirements

- **Business Profile API access request.** The Business Profile APIs are gated. After enabling them, the project's
  quota is **0 requests/minute** until Google approves it through the **GBP API contact form** ("Application for Basic API
  Access"). The form asks for the company, contact email, Cloud project number, and a use-case justification; the
  applicant should manage a verified Business Profile that has been active for 60+ days and use a business email on
  the business's domain. Third-party guides report about 14 days for review. Approval sets the default quota to
  300 QPM. Before approval, every call is answered with 429, which this connector maps to `rate_limit` with an
  explanatory hint.
- **OAuth verification.** `business.manage` is a sensitive scope. The same Google OAuth app verification as for YouTube
  applies, with the same Testing-mode limits: 100 test users, and refresh tokens that expire after 7 days.
- **Content policy.** Google moderates local posts. A post that breaks policy (phone numbers in the text, prohibited
  content) is `REJECTED`, which the connector reports as `rejected`.

## Limits and quotas

- 300 QPM per project per API after approval (0 before).
- Edits to a single location are also rate-limited, reportedly about 10 per minute.
- Post summary: 1,500 characters. Event title: 58 characters. One photo, JPG/PNG, 10 KB–5 MB, at least 250×250.
- Review reply: 4,096 bytes.
- Performance data is daily and lags by a few days; the 28-day window ends yesterday.
- `accounts.list` pages are 20; `locations.list` pages are 100.

## Unverified

1. **v4 still current for localPosts and reviews.** Search results show v4 reference pages updated in 2026, and
   changelog entries adding recurring posts and review reply state. I found no sunset notice. developers.google.com was
   not reachable from this sandbox, so the pages were not read in full.
2. **Access prerequisites** (a verified profile active for 60+ days, a business-domain email) are from memory of Google's
   prerequisites page and were not re-read. **Access form wording and timeline** (the "Application for Basic API Access" option, about 14 days) come from
   third-party guides. The 0 → 300 QPM behaviour appears in Google's Performance API reference snippet.
3. **The per-location edit limit** (about 10/min) has not been confirmed.
4. **CTA on OFFER posts** (`TODO(verify)` in `buildLocalPost`): the connector omits it.
5. **Photo requirements** (10 KB–5 MB, at least 250×250) and whether a STANDARD post may omit `summary` when it has a
   photo: the connector requires text.
6. **Whether `PROCESSING` is commonly returned** on create. The connector polls briefly either way.
7. **Performance API query format**: repeated `dailyMetrics` parameters and the `dailyRange.startDate.year`-style
   parameters, and whether `BUSINESS_FOOD_ORDERS` / `BUSINESS_BOOKINGS` are accepted for every location type. A
   location that does not support a metric may answer 400.

## Questions for the owner

1. **API access**: who submits the GBP API access form, and from which verified Business Profile and business-domain email? Which Cloud project number?
2. **EVENT/OFFER fields**: core's `VariantOptions` has no event dates or offer fields, and its zod schema strips unknown keys, so `options.googleBusiness` does not survive the public API today. Add `googleBusiness: {topicType, event, offer}` (or generic `event`/`offer` fields) to `VariantOptions`? Until then, only STANDARD posts (with a CTA) can be published end to end.
3. **Metrics shape**: `MetricName` has no names for calls, direction requests or per-surface impressions. Should the canon gain `calls`, `direction_requests` and surface-specific impressions, or is `fetchPerformance()` enough?
4. **First comment on Google Business**: should the composer hide `firstComment` for this network? Today core attempts it and records an error.
5. **Review notifications**: is a Pub/Sub topic acceptable for near-real-time review alerts? It needs a GCP topic, a push subscription to Base Air and OIDC token verification. Otherwise reviews are polled.
