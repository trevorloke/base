# LinkedIn

Connector `linkedin`, network `linkedin`. Code: `packages/connectors/src/linkedin.ts`. Tests: `packages/connectors/test/linkedin.test.ts`.
Factory: `createLinkedInConnectors(env)`.

It uses LinkedIn's versioned REST API (`https://api.linkedin.com/rest/...`). Every call sends `LinkedIn-Version: <YYYYMM>` and
`X-Restli-Protocol-Version: 2.0.0`. Sign-in uses OpenID Connect (`/v2/userinfo`).

## What works

| Area | Member (person) | Organization (company page) |
|---|---|---|
| Connect | Yes. One login connects the member (`externalId` = `urn:li:person:{sub}`)… | …plus every page where the member is an approved `ADMINISTRATOR` (`organizationAcls`). `externalId` = `urn:li:organization:{id}`, handle = vanity name. |
| Publish: text | Yes | Yes |
| Publish: link (article card, `options.link` + `options.title`, optional image as the thumbnail) | Yes | Yes |
| Publish: single image (Images API `initializeUpload` + PUT, wait until `AVAILABLE`) | Yes | Yes |
| Publish: multi-image, 2–20 images (`multiImage`) | Yes | Yes |
| Publish: video (Videos API: `initializeUpload`, multi-part PUTs, `finalizeUpload` with ETags, status polling, optional thumbnail from `options.thumbnailUrl`) | Yes | Yes |
| Publish: document / PDF carousel (Documents API, title from `options.title`) | Yes | Yes |
| Publish: poll (`options.poll`, question from `options.title`) | Yes | Yes |
| First comment (core calls `reply` with `options.firstComment`) | Yes | Yes |
| Reply to a post or comment (nested comment) | Yes | Yes |
| Moderate: like / unlike (Reactions API), delete comment or post | Yes | Yes |
| Moderate: hide / unhide | No: the API has no hide action, so the call fails with `rejected` | No |
| Inbox (`fetchActivity`) | Empty: reading a member's posts and comments needs `r_member_social`, which LinkedIn keeps closed | Recent posts (`own_post`) plus top-level comments on the 10 most recent posts (`comment` / `reply`) |
| Webhooks | No | Yes: organization social action notifications (comments, mentions, likes, reshares), with challenge, HMAC verify and parse |
| Post metrics | `memberCreatorPostAnalytics`: impressions, reach, likes, replies, reposts, engagements. Needs `r_member_postAnalytics`; without it you get none and no error | `organizationalEntityShareStatistics`: impressions, reach (unique impressions), likes, replies, reposts, clicks, engagement_rate, engagements |
| Account metrics | `followers_total` from `memberFollowersCount` (needs member analytics consent; empty otherwise) | `followers_total` from `networkSizes` (`COMPANY_FOLLOWED_BY_MEMBER`) |
| Token refresh | Only with programmatic refresh tokens (approved partners). Otherwise `refreshAuth` returns null and core marks the account `reauth_required` | Same token as the member |

Other behavior:

- **Text escaping.** Post commentary uses LinkedIn's "little" text format. The connector escapes `\ | { } @ [ ] ( ) < > * _ ~` so
  the text is not truncated. It leaves `#` alone so hashtags still work.
- **Links that cannot be a card.** If a post has a link and also a video, document or several images, the link is appended to
  the text.
- **Idempotency.** Posts and comments are deduplicated per idempotency key within the process. Uploaded media URNs are
  remembered per key. If video processing times out (retryable error), the retry polls again instead of uploading again.
- **Media bytes** come from `this.media.fetch` (Starsign storage). When that is unset, the connector downloads `media.url`.
- **Errors.**
  - 401 and 403 → `auth`.
  - 426 (version sunset) → `rejected`, with a hint to update `LINKEDIN_API_VERSION`.
  - 429 → `rate_limit`, retryable. LinkedIn sends no reset header, so the message names the next midnight UTC, or uses
    `Retry-After` when present.
  - 5xx and transport failures → `network`, retryable.

## Setup

1. Create an app at https://www.linkedin.com/developers/apps. It must be associated with a LinkedIn Page, and a Page admin has
   to verify that association.
2. Under **Products**, add:
   - **Sign In with LinkedIn using OpenID Connect**: `openid`, `profile`, `email`. Self-serve.
   - **Share on LinkedIn**: `w_member_social`. Self-serve.
   - **Community Management API**: page scopes and member analytics. Needs approval (see below).
3. Under **Auth → OAuth 2.0 settings**, add the redirect URL `${STARSIGN_PUBLIC_URL}/oauth/linkedin/callback`.
4. Scopes the connector requests by default:
   `openid profile email w_member_social w_organization_social r_organization_social rw_organization_admin r_organization_admin`.
   - Before Community Management approval, set `LINKEDIN_SCOPES="openid profile email w_member_social"`. Otherwise LinkedIn
     refuses the authorization with `unauthorized_scope_error`.
   - After approval, add `r_member_postAnalytics` (and the member follower analytics permission) for member analytics.
   - Add the `*_social_feed` scopes too if the app shows them (see Unverified).
5. Webhooks (page accounts only; needs Community Management):
   - In the app's **Webhooks** tab, register `${STARSIGN_PUBLIC_URL}/webhooks/linkedin`. LinkedIn validates it with a GET
     `?challengeCode=…`, and the connector answers with the HMAC-SHA256 of the code.
   - Subscribe each organization with `PUT /rest/eventSubscriptions/(developerApplication:…,user:…,entity:…,eventType:ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS)`.
     Starsign does not do this subscription step automatically yet.
6. Environment variables:

| Variable | Required | Meaning |
|---|---|---|
| `LINKEDIN_CLIENT_ID` | yes | App client id. Without it, `connectConfigured` is false |
| `LINKEDIN_CLIENT_SECRET` | yes | App client secret. Also the webhook HMAC key |
| `LINKEDIN_API_VERSION` | no | `YYYYMM`. Default `202610`, the latest release in November 2026, supported until about October 2027. Values that are not 6 digits are ignored |
| `LINKEDIN_SCOPES` | no | Space- or comma-separated override of the requested scopes |
| `LINKEDIN_API_BASE_URL` | no | Override `https://api.linkedin.com` (tests and proxies) |

## Review and access requirements

- **Self-serve, no review:** Sign In with OpenID Connect and Share on LinkedIn. With only these, Starsign can connect the
  member, publish every post kind as the member, comment and like as the member, and refresh nothing (60-day tokens).
- **Community Management API** (LinkedIn review; formerly Marketing Developer Platform) is needed for:
  - company pages: connecting organizations, posting as a page, reading page posts and comments, page analytics, followers;
  - webhooks;
  - member post analytics (`r_member_postAnalytics`).

  The application asks for a registered legal entity, a company website and privacy policy, a description of the use case,
  and often a screen recording of the integration. Third-party reports put review at about 1–4 weeks. LinkedIn grants a
  Development tier first (limited calls and test pages), then a Standard tier after a second review.
- **Programmatic refresh tokens** are enabled per app by LinkedIn, typically for approved Marketing/Community Management
  partners.
  - With them, access tokens last 60 days and the refresh token lasts 365 days from the original grant. Refreshing does not
    extend the refresh token.
  - Without them, members must reconnect every 60 days. `refreshAuth` returns null, and core flips the account to
    `reauth_required` on the first 401.
- **Before approval:** organization discovery quietly returns no pages (a 403 on `organizationAcls` is swallowed). Page
  scopes in the authorize URL make LinkedIn refuse the login, so use `LINKEDIN_SCOPES` (see Setup).

## Limits and quotas

- Text: 3,000 characters of commentary. Comments: 1,250 characters.
- Media:
  - Images: up to 20 per multi-image post. JPG, PNG or GIF.
  - Video: 3 seconds to 30 minutes, MP4, 75 KB to 5 GB (multi-part upload).
  - Documents: PDF, PPT(X) or DOC(X), up to 100 MB / 300 pages.
  - One video or one document per post, and neither can be mixed with other media.
  - Starsign's generic limit for LinkedIn video is 900 seconds (`NETWORK_LIMITS`), which is stricter than LinkedIn's.
- Polls: question up to 140 characters, 2–4 options of up to 30 characters, duration 1 day, 3 days, 1 week or 2 weeks. The
  connector rounds `durationMinutes` up to the next allowed value.
- Rate limits are per app and per member, per day, and reset at midnight UTC. LinkedIn does not publish fixed numbers; the
  app's Analytics tab in the developer portal shows them. Development tier limits are much lower than Standard.
- Asset processing: the connector polls every 2 seconds, up to 30 times. If the asset is still processing after that, it
  returns a retryable error.
- Versions are released monthly and supported for at least a year. A sunset version answers 426.

## Unverified

Every `TODO(verify)` in `linkedin.ts`:

1. Whether plain `#tag` in commentary still renders as a hashtag, or must be written as `{hashtag|\#|tag}`.
2. Maximum video size for multi-part uploads (75 KB to 5 GB is assumed).
3. Document limits (100 MB / 300 pages comes from LinkedIn Help, not the API reference).
4. The poll content schema `{ question, options[{text}], settings{duration} }`.
5. Nested replies: they are only listed through `socialActions/{commentUrn}/comments`, so the poll-based inbox reads top-level
   comments only. Webhooks are expected to deliver replies.
6. The maximum number of `shares`/`ugcPosts` in one `organizationalEntityShareStatistics` call. The connector uses chunks of 20.
7. The `memberCreatorPostAnalytics` entity syntax `(share:urn…)` / `(ugc:urn…)`, and the `count` field in its elements.
8. The `networkSizes` `edgeType` spelling in versioned APIs (`COMPANY_FOLLOWED_BY_MEMBER` vs legacy `CompanyFollowedByMember`).
9. The permission `memberFollowersCount` needs (reported as `r_member_profileAnalytics`).
10. The webhook signature input. Microsoft documents `"hmacsha256=" + body`; some guides sign the bare body. The connector
    accepts either; both need the client secret.
11. Notification field names (`action`, `organizationalEntity`, `sourcePost`, `generatedActivity`, `actor`,
    `decoratedGeneratedActivity`, `lastModifiedAt`, `notificationId`) against a real delivery.
12. Whether comments and reactions also need the June-2023 feed scopes (`r_organization_social_feed`,
    `w_organization_social_feed`, `w_member_social_feed`).
13. Whether the Reactions API accepts a comment URN as `root`, for liking comments.
14. Whether LinkedIn accepts the challenge JSON when Starsign's API serves it as `text/plain`. `apps/api` returns `c.text(...)`;
    if LinkedIn insists on `application/json`, the GET route needs a content-type change, which is outside this connector.

Also not implemented:
- video views for page videos (`videoAnalytics`);
- reading member comment author names (needs profile permissions LinkedIn does not grant). Author handles are person URNs.

## Questions for the owner

1. Has Starsign's LinkedIn app been approved for the **Community Management API**? Which tier: Development or Standard?
   Until it is, deploy with `LINKEDIN_SCOPES="openid profile email w_member_social"`.
2. Is the app enabled for **programmatic refresh tokens**? If not, members will be asked to reconnect every 60 days.
3. Which LinkedIn Page is the developer app associated with, and who is the Page admin who can verify it?
4. Should Starsign subscribe page webhooks automatically when a page connects (needs an `eventSubscriptions` call and the app's
   developer application id)?
5. Should we request member analytics permissions (`r_member_postAnalytics`, follower analytics) in the default scopes once
   they are granted?
6. Who is the contact for LinkedIn's partner review, and what legal entity and privacy policy URL should the application use?
