# Meta: Facebook Pages and Instagram

Connector `meta`, networks `facebook` and `instagram`. Code: `packages/connectors/src/meta.ts`. Tests:
`packages/connectors/test/meta.test.ts`. Factory: `createMetaConnectors(env)`.

The connector calls the Graph API at `https://graph.facebook.com/{version}`. The default version is **v26.0**, released
2026-07-29 with no expiry date announced yet. Set `META_GRAPH_VERSION` to pin another one. Instagram uses the "Instagram API
with Facebook Login" path: the same host, authenticated with the linked Page's access token. The other path, "Business Login
for Instagram" (`graph.instagram.com`, `instagram_business_*` permissions), is a separate permission family and is not used here.

## What works

| Area | Facebook Page | Instagram professional account |
|---|---|---|
| Connect | Yes. One Facebook Login for Business connects **every Page** the person picks (`externalId` = Page id, handle = Page username or id)… | …and **every Instagram professional account linked** to those Pages (`externalId` = IG user id, `config.pageId` = the Page it rides on). |
| Text post | `POST /{page}/feed` | No (Instagram requires media) |
| Link post (`options.link`, or kind `link`) | `POST /{page}/feed` with `link` | No |
| Single photo | `POST /{page}/photos` (`url`, `caption`) | Container (`image_url`, `caption`, `alt_text`) → poll → `media_publish` |
| Several photos | Each `POST /{page}/photos` with `published=false`, then one `POST /{page}/feed` with `attached_media` | Carousel: 2–10 child containers (`is_carousel_item`, images and videos can be mixed), then `media_type=CAROUSEL` |
| Video | `POST /{page}/videos` with `file_url`. Videos larger than 1 GiB (`media.bytes`) use the Resumable Upload API: an `/{app-id}/uploads` session, then `fbuploader_video_file_chunk` | Single videos publish as Reels (`media_type=REELS`, `share_to_feed=true`, `cover_url` from `options.thumbnailUrl`) |
| Reel (kind `reel`) | `POST /{page}/video_reels` start → rupload.facebook.com pulls the file by URL (`file_url` header) → finish with `video_state=PUBLISHED` → a short status poll that surfaces processing errors | `media_type=REELS` |
| Story (kind `story`) | Photo: an unpublished photo, then `/{page}/photo_stories`. Video: `/{page}/video_stories` start/rupload/finish | `media_type=STORIES` (image or video) |
| First comment (`options.firstComment`) | Core calls `reply` after publishing → `POST /{post}/comments` | Core calls `reply` → `POST /{media}/comments` |
| Async processing | Reels and video stories: up to 5 status polls; `error` → `rejected` | Every container is polled on `status_code` until `FINISHED` (`maxPolls`, default 20 × 3 s). `ERROR` → `rejected`, and the next attempt makes a new container. `EXPIRED` → retryable, new container. Still `IN_PROGRESS` → retryable `network` error, and the retry reuses the same container |
| Publishing quota check | n/a | `GET /{ig}/content_publishing_limit` before each new container. A spent quota → `rate_limit` (retryable) with no container made |
| Inbox (`fetchActivity`) | The 25 most recent posts (`own_post`) plus up to 50 newest comments on each (`comment`, `filter(stream)`, so replies come with `parent`). The Page's own comments are skipped. Posts that tag the Page (`/tagged`) come in as `mention` | The 25 most recent media (`own_post`) plus comments (`comment`) and their replies (`reply`). The account's own comments are skipped. Media the account is tagged in (`/tags`) come in as `mention` |
| Reply | `POST /{post-or-comment}/comments` | Comment → `POST /{comment}/replies`. Media → `POST /{media}/comments`. Media published by this process go straight to `/comments`; otherwise the connector tries `/replies` and falls back when Graph answers code 100 |
| Moderate | hide/unhide (`is_hidden`), delete, like/unlike as the Page (`/{id}/likes`) | hide/unhide (`hide`), delete. Like/unlike → `rejected` (the API cannot like) |
| Post metrics | `likes` (reactions total), `replies` (comments total), `shares`, `impressions` ← `post_media_view`, `reach` ← `post_total_media_view_unique`, `clicks` ← `post_clicks`, `link_clicks` ← `post_clicks_by_type["link clicks"]`, `video_views` ← `post_video_views`, `watch_time_seconds` ← `post_video_view_time`/1000, `engagements` = likes + replies + shares | The metric set depends on `media_product_type`. `impressions` ← `views` (also `video_views` for Reels and videos), `reach`, `likes`, `replies` ← `comments`, `shares`, `saves` ← `saved`, `engagements` ← `total_interactions`, `profile_visits`, `follows`, `watch_time_seconds` ← `ig_reels_video_view_total_time`/1000 |
| Account metrics | `followers_total` ← `followers_count` (falls back to `fan_count`). Day `page_media_view` → `impressions`, `page_total_media_view_unique` → `reach`, `page_post_engagements` → `engagements` | `followers_total` ← `followers_count`. Day `total_value`: `reach`, `views` → `impressions`, `total_interactions` → `engagements`, `profile_links_taps` → `link_clicks` |
| Webhooks | `feed` changes: comment adds and visitor posts. `mention` changes. Routed by Page id | `comments` (a reply when `parent_id` is set) and `mentions` (ids only). Routed by IG user id |
| Token refresh | `refreshAuth` re-extends the long-lived user token, then re-derives the Page token from it. It returns null (so core asks for reconnection) when no user token is stored or the user token is dead | Same |

Other behavior:

- **Metric name churn.** Meta keeps retiring insight metrics. Instagram replaced `impressions`, `plays` and `video_views` with
  `views` (removed on 2025-04-21). Pages replaced `page_impressions` with `page_media_view` (2025-11-15), and
  `*_impressions_unique` with `*_total_media_view_unique` (June 2026 / v26.0). The connector asks for all metrics in one call.
  If Graph refuses with code 100, it asks one metric at a time, skips the refused ones, and remembers them for the rest of the
  process. A retired metric therefore costs at most one extra round of calls and never fails the whole fetch.
- **Webhook subscription.** At connect, the connector calls `POST /{page-id}/subscribed_apps` with
  `subscribed_fields=feed,mention` for each Page. This is best effort, and the result is saved as
  `config.webhooksSubscribed`. Page webhooks fire only for Pages that installed the app this way. Instagram comment and
  mention webhooks also depend on the linked Page's installation.
- **Mentions without a tag.** A caption @mention with no photo tag reaches base air only through the `mentions` webhook. The
  payload carries `media_id` (and `comment_id` for comment mentions) but no text. Text could be fetched later with
  `GET /{ig-user-id}?fields=mentioned_media.media_id(...)` / `mentioned_comment.comment_id(...)` (not implemented).
- **Idempotency.** Results are cached per idempotency key, and Instagram progress (child containers, container, published
  media id) is kept per key. A retry after a timeout or a transient error resumes instead of posting twice. As in every
  connector, this memory is per process.
- **Security.** Graph calls send the token as `Authorization: Bearer`, plus `appsecret_proof` (HMAC-SHA256 of the token with
  the app secret), so "Require App Secret" can be turned on in the app settings.
- **Errors.** The Graph error code decides the kind:
  - Throttling codes 4, 17, 32, 613, 80001–80014, HTTP 429, and the Instagram publishing-limit error 9/2207042 → `rate_limit`
    (retryable). The wait comes from `X-Business-Use-Case-Usage.estimated_time_to_regain_access`.
  - Codes 190, 102, 10 and 200–299 → `auth`.
  - `is_transient`, codes 1 and 2, and HTTP 5xx → `network` (retryable).
  - Everything else (100, 506 duplicate, and so on) → `rejected`.
- **Validation.**
  - Instagram: media required; no threads; no GIF or document; images JPEG only; feed images between 4:5 and 1.91:1;
    carousels of 2–10 items; one video per reel, 3 s to 15 min; stories take one item, with video up to 60 s; at most 30
    hashtags and 20 @mentions.
  - Facebook: one video per post, with no photos alongside it; reels take one video of 3–90 s; stories take one item; no
    documents.

## Setup

1. **Create the app.** At developers.facebook.com → My Apps → Create app, choose the **Business** app type (Facebook Login
   for Business is only offered to Business apps). Connect it to your Business portfolio.
2. **Add products and use cases.** Add *Facebook Login for Business*, *Instagram* (the "API setup with Facebook login" option)
   and *Webhooks*. Under Pages, enable the "Manage everything on your Page" use case.
3. **Facebook Login for Business → Settings.**
   - Valid OAuth Redirect URI: `${BASE_AIR_PUBLIC_URL}/oauth/meta/callback`
   - Turn on Client OAuth login, Web OAuth login and Enforce HTTPS.
   - Optional: create a *Configuration* (login variation "General", token type **User access token**, the assets Pages and
     Instagram accounts, and the permissions below). Put its id in `META_LOGIN_CONFIG_ID`; the connector then sends it as
     `config_id`.
4. **Permissions** (requested as `scope` and, when used, chosen in the configuration):
   `pages_show_list, pages_manage_posts, pages_read_engagement, pages_manage_engagement, pages_read_user_content,
   pages_manage_metadata, read_insights, instagram_basic, instagram_content_publish, instagram_manage_comments,
   instagram_manage_insights, business_management`.
   `pages_manage_metadata` is needed for the webhook subscription (`subscribed_apps`). `business_management` makes Pages
   owned through a Business portfolio appear.
5. **Webhooks** (App Dashboard → Webhooks):
   - Object **Page**: callback URL `${BASE_AIR_PUBLIC_URL}/webhooks/meta`, verify token = `META_WEBHOOK_VERIFY_TOKEN`.
     Subscribe the fields `feed` and `mention`.
   - Object **Instagram**: the same callback and verify token. Subscribe the fields `comments` and `mentions`.
   - Meta signs deliveries with the **app secret** (`X-Hub-Signature-256`). The connector verifies them with
     `META_CLIENT_SECRET`.
6. **Settings → Basic.** Add a Privacy Policy URL, Terms URL, a data deletion URL or instructions, an app icon and a category.
   All are required before going Live and for App Review.
7. **Environment:**

| Variable | Required | Meaning |
|---|---|---|
| `META_CLIENT_ID` | yes | App ID. Without it (or without the secret), `connectConfigured` is false |
| `META_CLIENT_SECRET` | yes | App secret. Used for the token exchange, `appsecret_proof` and webhook signatures |
| `META_WEBHOOK_VERIFY_TOKEN` | for webhooks | Any random string; the same value goes in the dashboard |
| `META_GRAPH_VERSION` | no | Default `v26.0` |
| `META_LOGIN_CONFIG_ID` | no | Facebook Login for Business configuration id |

Each account's stored auth blob holds `pageAccessToken`, `pageId`, `igUserId` (Instagram only), `userAccessToken` (long-lived,
about 60 days), `userId` and `userTokenExpiresAt`. It deliberately has no `expiresAt`: Page tokens derived from a long-lived
user token do not expire, so core should not refresh them on a timer. On an auth error, core calls `refreshAuth`.

## Review and access requirements

- **Development mode (before review).** Every permission works with **Standard Access**, but only for people who have a role
  on the app (admin, developer or tester) and for Pages and Instagram accounts those people manage. Webhooks are delivered
  only for data from those people. This is enough to build and to record the App Review screencasts.
- **Advanced Access, through App Review**, is needed for any customer outside the app's roles. Submit every permission
  above. For each one, the reviewer expects:
  - a written explanation of how base air uses it;
  - a screencast showing the full flow: logging in with Facebook, choosing Pages and IG accounts in the dialog, then the
    feature using that permission. For example: publishing a post and a reel (`pages_manage_posts`,
    `instagram_content_publish`); reading and replying to, hiding and deleting a comment (`pages_read_user_content`,
    `pages_manage_engagement`, `instagram_manage_comments`); the analytics screen (`read_insights`,
    `instagram_manage_insights`); the Page picker (`pages_show_list`, `business_management`).
  - working test credentials, or a test Page/IG account the reviewer can use. Reviewers want a real Instagram professional
    account, not a developer test user.
- **Business Verification** of the Business portfolio that owns the app is required before Advanced Access for these
  permissions is granted. It is often the slowest step, from days to a few weeks. Start it first.
- **Webhooks:** the Instagram `comments` and `mentions` fields require Advanced Access on `instagram_manage_comments`.
- **Live mode.** Switch the app to Live after review. The privacy policy and data deletion URL must resolve.
- **Typical timeline:** Business Verification takes days to two weeks. Each App Review round takes about 1–2 weeks, and
  rejections asking for a clearer screencast are common.
- **Ongoing duties:** annual Data Use Checkup, plus keeping the Graph version current. Versions live about 2 years, and calls
  to an expired version are silently upgraded.

## Limits and quotas

- **Instagram publishing:** a rolling 24-hour cap on API-published posts per account. Meta's docs state 100; a carousel counts
  as one post. The connector reads the real number from `content_publishing_limit` and refuses before making a container.
  Containers expire after 24 hours.
- **Facebook Reels:** 30 API-published reels per Page per rolling 24 hours, enforced at the finish/publish call.
- **Graph rate limits:**
  - Page-token calls fall under the Business Use Case (BUC) limit, roughly 4800 × engaged users per 24 h per Page.
  - Instagram calls fall under a BUC limit of about 4800 × impressions per 24 h.
  - User-token calls fall under the app-level limit of 200 × users per hour.
  - Throttled calls return codes 4, 17, 32, 613 or 80001+ with `X-Business-Use-Case-Usage` / `X-App-Usage` headers. The
    connector maps these to retryable `rate_limit`.
- **Media:**
  - Instagram images: JPEG, up to 8 MB, aspect ratio 4:5 to 1.91:1.
  - Instagram Reels: 3 s to 15 min, up to 300 MB through `video_url`.
  - Instagram stories: video up to 60 s.
  - Carousels: up to 10 items.
  - Facebook `file_url` videos: up to 1 GB, after which the connector switches to resumable upload. Reels: 3–90 s.
- **Insights:**
  - Instagram media insights can lag up to 48 h.
  - Story insights exist only for 24 h.
  - Accounts with fewer than 100 followers get no follower-based demographic metrics.
  - A missing value comes back as an empty data set, not 0, so the connector emits no row.

## Unverified

Every `TODO(verify)` in `meta.ts`, plus facts the sandbox could not confirm (developers.facebook.com was unreachable, so only
search snippets were available):

- With `config_id` (Login for Business configuration), Meta takes permissions from the configuration and ignores `scope`.
  The connector sends both.
- Re-exchanging a still-valid long-lived user token with `fb_exchange_token` returns a fresh 60-day token. Meta documents
  the exchange for short-lived tokens. If it is refused, `refreshAuth` keeps the old user token and still re-derives the
  Page token.
- Whether data-access expiry (90 days after the person last used the app) also invalidates Page tokens derived from that
  user's token.
- The Instagram publishing-limit error code (code 9, subcode 2207042) and the cap itself (100 posts per 24 h; one
  third-party source says 25).
- `alt_text` on Instagram image and carousel-item containers, and `alt_text_custom` on unpublished Facebook photos.
- Instagram reel watch-time metric names `ig_reels_video_view_total_time` / `ig_reels_avg_watch_time`. Only third-party
  sources list them; the per-metric fallback drops them if they are wrong.
- Whether `post_video_views`, `post_video_view_time` and `post_clicks` survived v26.0's "video impressions" deprecation
  (also handled by the fallback).
- Whether the IG account metric `profile_links_taps` works with `metric_type=total_value` on `period=day`.
- The Graph error code for `POST /{media-id}/replies` (assumed 100) that triggers the `/comments` fallback.
- The resumable upload host. Some Meta samples still use `graph-video.facebook.com`; the connector uses
  `graph.facebook.com/{version}/{upload-session}` and `/{page}/videos`. The 1 GiB `file_url` threshold is also unverified.
- The Facebook reel and video-story status shape (`status.video_status`, `processing_phase.status`), and whether `finish`
  returns a `post_id`. When it does not, the connector uses the video id as `externalId`, and post insights on a video id
  may come back partially.
- Facebook reel length limits (3–90 s) and Page photo/video stories via `photo_stories` / `video_stories` on v26.0.
- Instagram `comments` webhook payload under Facebook Login. One Meta example shows only `from.id` and
  `media_product_type`. The parser also reads `id`, `text`, `from.username`, `media.id` and `parent_id` when present.
- The Page `mention` webhook value fields (`sender_name`, `post_id`, `comment_id`).

## Questions for the owner

1. Which **Business portfolio** owns the Meta app, and is it already Business Verified? Who can upload the verification
   documents?
2. Should we use a **Login for Business configuration** (`META_LOGIN_CONFIG_ID`) or plain `scope`? A configuration gives a
   cleaner consent screen and is Meta's recommended path.
3. Do you want **Facebook Page stories and reels** in the first App Review? They need the same permissions, but the
   screencasts must show them.
4. Which **test Page and Instagram professional account** can reviewers use, and who records the screencasts?
5. Is **instagram_manage_messages / pages_messaging** (DM inbox) in scope later? It is not requested now and would need its
   own review.
6. Should base air keep requesting **`business_management`**? It is only needed when Pages are owned by a Business portfolio
   rather than a person, and it adds review scrutiny.
7. Should the Graph version be **pinned per deployment** (`META_GRAPH_VERSION`), and who watches Meta's deprecation
   notices?
