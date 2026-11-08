# Pinterest

Connector `pinterest`, network `pinterest`. Code: `packages/connectors/src/pinterest.ts`. Tests: `packages/connectors/test/pinterest.test.ts`.
Factory: `createPinterestConnectors(env)`. Helper for the room's board picker: `listBoards(account)` (exported function, and
also a method on `PinterestConnector`).

It uses Pinterest API v5 (`https://api.pinterest.com/v5`).

## What works

| Area | Status |
|---|---|
| Connect | OAuth 2.0 code flow. The token endpoint uses HTTP Basic auth. One account per login (`GET /user_account`): `externalId` = user id (or username), handle = username |
| Boards | `listBoards(account)` lists every board (id, name, description, privacy) so the room can fill `options.boardId` |
| Publish: image Pin | Pull-style: `media_source.source_type = image_url` with the Base Air media URL. Sends title (`options.title`), description (post text), link (`options.link`), alt text (first media `alt`) and board (`options.boardId`, required) |
| Publish: carousel | 2–5 images, `multiple_image_urls`. Each card carries the title and link, and the image alt text as its description |
| Publish: video Pin | `POST /media` registers the upload. The connector then POSTs the file to the returned S3 `upload_url` with `upload_parameters`, polls `GET /media/{id}` until `succeeded`, and creates the Pin with `video_id`. The cover is `options.thumbnailUrl`, or else the first frame |
| Validation | Board required; media required; no documents; one video alone; at most 5 carousel images; title ≤ 100; description ≤ 800; alt text ≤ 500; video 4 s–15 min and ≤ 2 GB |
| Inbox | `fetchActivity` returns the account's own Pins only (`own_post`) |
| Comments, replies, moderation | **Not available.** Pinterest API v5 has no comment endpoints. `capabilities` declares `reply: false`, `moderate: false`, and the connector does not implement `reply` or `moderate` |
| Webhooks | None for organic content |
| Pin metrics | `GET /pins/{id}/analytics` summed over the last 90 days. Maps IMPRESSION → impressions, SAVE → saves, PIN_CLICK → clicks, OUTBOUND_CLICK → link_clicks, VIDEO_MRC_VIEW → video_views, VIDEO_V50_WATCH_TIME → watch_time_seconds, TOTAL_REACTIONS → likes, TOTAL_COMMENTS → replies, plus a computed engagements total. If Pinterest refuses the video metric types (400), the connector retries with the base four |
| Account metrics | `followers_total` from `/user_account`. impressions, engagements, saves, clicks and link_clicks are **trailing 30-day sums** from `/user_account/analytics` (business accounts; skipped quietly when unavailable) |
| Token refresh | `refreshAuth` uses the refresh token and stores the new one Pinterest returns |

Other behavior:

- **Idempotency.** Pins are created once per idempotency key. A registered video `media_id` is remembered per key, so a retry
  after a processing timeout keeps polling instead of uploading again.
- **Errors.**
  - 401 → `auth`.
  - 403 → `auth` on reads and `rejected` on creates. A Trial access refusal gets a message explaining Standard access and the
    sandbox.
  - 429 → `rate_limit`, retryable, using `Retry-After` / `X-RateLimit-Reset`.
  - 5xx and transport failures → `network`, retryable.

## Setup

1. Create an app at https://developers.pinterest.com/apps/. This needs a Pinterest **business** account, and the app gets
   **Trial access** first.
2. Under **Configure → Redirect URIs**, add `${BASE_AIR_PUBLIC_URL}/oauth/pinterest/callback`.
3. Scopes the connector requests (comma-separated): `boards:read,boards:write,pins:read,pins:write,user_accounts:read`.
   - `user_accounts:read` covers the profile and account analytics, and `pins:read` covers Pin analytics.
   - `ads:read` is **not** needed for organic analytics, so the connector does not request it.
4. No webhook URL: Pinterest has no organic webhooks. `${BASE_AIR_PUBLIC_URL}/webhooks/pinterest` is unused.
5. Environment variables:

| Variable | Required | Meaning |
|---|---|---|
| `PINTEREST_CLIENT_ID` | yes | App id. Without it, `connectConfigured` is false |
| `PINTEREST_CLIENT_SECRET` | yes | App secret (Basic auth at the token endpoint) |
| `PINTEREST_API_BASE_URL` | no | Set to `https://api-sandbox.pinterest.com/v5` while the app has Trial access. Token exchange still goes to production |

Tokens:
- Access tokens last 30 days.
- Apps created on or after 2025-09-25 get **continuous refresh tokens**: 60 days, renewed on every refresh, so an account that
  keeps refreshing never has to reconnect.
- Older apps get a legacy refresh token with a hard 365-day limit, unless they pass `continuous_refresh=true` (see Unverified).

## Review and access requirements

**Trial access** (the default for a new app):
- OAuth, reading the user, boards and Pins, and analytics work.
- **Pins cannot be created in production.** Pinterest answers 403 ("Apps with Trial access may not create Pins in
  production"), and the connector reports it as `rejected` with an explanation.
- Pins and boards can be created against the **sandbox** (`api-sandbox.pinterest.com`). They are visible only to the
  creator, and video Pins reportedly cannot be created there.
- Rate limits are a daily cap per app: about 1,000 calls per day overall, plus stricter per-category caps.

**Standard access:**
- Production Pin creation and per-minute rate limits.
- Apply from the app's page in the developer portal ("Upgrade"). Pinterest asks for:
  - an approved Trial app that follows the Developer Guidelines;
  - a **video demo** showing the full OAuth flow and a real Pin being created through the app (developers report denials when
    either is missing);
  - a privacy policy URL and a description of the use case.
- Review typically takes a few days to a few weeks.

## Limits and quotas

- Title 100 characters. Description 800. Alt text 500. Link: one URL.
- Base Air's generic `NETWORK_LIMITS.pinterest` caps text at 500 characters and media at **1**. So core's generic validation
  rejects carousels before this connector sees them, even though the connector supports 2–5 images. Raising `maxMedia` to 5
  in `packages/schema/src/networks.ts` (not owned by this connector) would enable carousels end to end.
- Video Pins: MP4/MOV, 4 seconds to 15 minutes, up to 2 GB. Image Pins: PNG, JPEG or WEBP, 2:3 recommended.
- Standard access rate limits: per user per app, by category. The write category (Pins, boards) is about 100 per minute, and
  there is an overall cap of 100 per second. Trial access allows about 1,000 calls per day per app.
- Pin analytics serve at most the last 90 days, with up to about 48 hours of data latency.
- Video processing: the connector polls every 3 seconds, up to 40 times. If the video is still processing after that, it
  returns a retryable error.

## Unverified

Every `TODO(verify)` in `pinterest.ts`:

1. Which extra metric types pin analytics accepts for organic Pins (`VIDEO_MRC_VIEW`, `VIDEO_V50_WATCH_TIME`,
   `TOTAL_COMMENTS`, `TOTAL_REACTIONS`). The connector falls back to the base four on a 400.
2. Carousel size of 2–5 images.
3. Organic video limits: 4 seconds to 15 minutes, 2 GB.
4. `cover_image_key_frame_time: 0` as the cover when no `thumbnailUrl` is given.
5. Whether `/user_account` always returns a stable `id`. The connector falls back to the username as `externalId`.
6. Whether `VIDEO_V50_WATCH_TIME` is in milliseconds (the connector divides by 1,000).
7. Apps created before 2025-09-25 need `continuous_refresh=true` on refresh to get continuous tokens. The shared
   `OAuth2Client` does not send it, so those apps keep the legacy 365-day refresh token.
8. That 90 days is the longest pin analytics window. Older Pins then under-report lifetime totals.
9. Whether the sandbox accepts the OAuth user token, or only the sandbox token generated in the developer portal.

## Questions for the owner

1. Does Base Air's Pinterest app have **Standard access**? If not, should we apply now? Who records the demo video, and which
   business account and privacy policy should it use?
2. While on Trial, should deployments point `PINTEREST_API_BASE_URL` at the sandbox (Pins only the creator sees), or keep
   production and accept that publishing fails?
3. Was the app created before or after 2025-09-25? This decides whether refresh tokens are continuous.
4. Should we raise `NETWORK_LIMITS.pinterest.maxMedia` to 5 (and `maxText` to 800) in the schema package, so carousels and full
   descriptions pass core's generic validation?
5. Should the room require choosing a board for every Pin, or keep a per-account default board (for example in account
   `config.defaultBoardId`)?
