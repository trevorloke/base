# VK (VKontakte)

Connector `vk` · networks `["vk"]` · `packages/connectors/src/vk.ts` · factory `createVkConnectors(env)`

## What works
- **Connect** (`connectMethod: "oauth"`, VK ID OAuth 2.1, authorization code + PKCE S256).
  Authorize `https://id.vk.com/authorize`, token `https://id.vk.com/oauth2/auth` (exchange and refresh carry VK ID's
  `device_id`, and `state` when known). `oauthConnect` returns **the user's own wall plus every community they manage**
  (`groups.get filter=admin,editor extended=1`): one account per wall, externalId = owner_id (`42` for the user, `-777` for a
  community), handle = screen name (`club777` fallback), config `{ ownerId, kind: "user" | "group", groupId, adminLevel }`.
  If the token lacks group access, the user's wall still connects. `connectConfigured` needs only `VK_CLIENT_ID` (PKCE);
  `VK_CLIENT_SECRET` is sent when set.
- **Refresh**: VK ID access tokens last about an hour; refresh tokens are single-use. All walls of one login share the token,
  so a rotated refresh token is remembered in-process (old → new) and sibling accounts reuse it.
- **API calls**: `POST https://api.vk.com/method/<name>` form-encoded with `v=5.199` and `access_token`.
- **Publish** `wall.post` (kinds `post`, `link`, `carousel`, `video`): `owner_id`, `from_group=1` on community walls, `message`,
  `attachments` (comma-separated, ≤ 10, a link counts as one):
  - photos: `photos.getWallUploadServer` (`group_id` for communities) → multipart upload (`photo` field) →
    `photos.saveWallPhoto` (`server`, `photo`, `hash`, alt text as `caption`) → `photo<owner>_<id>`;
  - video: `video.save` (`group_id`, `name` from `options.title`, `wallpost=0`) → upload (`video_file`) → `video<owner>_<id>`;
  - `options.link` → the URL as an attachment.
  externalId `<owner>_<post>`, url `https://vk.com/wall<owner>_<post>`. Idempotent in-process.
- **Inbox**: `wall.get` (20 most recent posts) → `wall.getComments` (`extended=1`, `thread_items_count=10`, newest first) for posts
  with comments. Each comment (including thread replies) → kind `comment`, or `reply` when it answers a comment by the account;
  the account's own comments are skipped. externalId `<owner>_<post>_<comment>`, parentExternalId = the post or the parent
  comment, author handle/name from the extended profiles/groups, url `https://vk.com/wall<owner>_<post>?reply=<comment>`.
- **Reply** `wall.createComment` on a post (`<owner>_<post>`) or a comment (`reply_to_comment`); on community walls the reply is
  posted as the community (`from_group`).
- **Moderate**: `delete` → `wall.deleteComment` (or `wall.delete` for a post id); `like`/`unlike` → `likes.add`/`likes.delete`
  (`type=comment` or `post`). `hide`/`unhide` are refused (VK has no hide).
- **Metrics** `wall.getById` (100 posts per call): `views.count` → impressions, `likes.count` → likes, `reposts.count` → reposts,
  `comments.count` → replies, engagements = likes + reposts + comments. **Account**: community → `groups.getMembers count=0` → `count`;
  user → `users.getFollowers count=0` → `count`; both → followers_total.
- **Errors**: VK answers most errors with HTTP 200 and `{ error: { error_code, error_msg } }`. Mapping: 5 → auth (token
  invalid; reconnect), 7/17/18/27/28/200/203 → auth; 6/9/29 → rate_limit retryable; 14 (captcha) → rejected; 15, 100, 113,
  212–214, 219–224 → rejected; 1/10 → network retryable; other codes → unknown. HTTP-level failures use the shared mapping.

## What Base Air can and cannot see
Base Air sees comments (and comment threads) on the 20 most recent posts of each connected wall, with the commenters'
public names. It does not see private messages, community chats, comments on older posts, or other people's walls.

## Setup
1. Create an app at https://id.vk.com/about/business/go (VK ID business account) → "Web" platform.
2. Trusted redirect URL: `${BASE_AIR_PUBLIC_URL}/oauth/vk/callback`; base domain = your Base Air domain.
3. Request access to the API scopes below in the app's settings.
4. Copy the app ID (client id) and, if issued, the protected key (client secret).
- Scopes requested: `vkid.personal_info wall photos video groups stats`.
- Webhook URL: none (VK's Callback API exists for communities but is not used; the inbox polls).
- Env vars: `VK_CLIENT_ID`, `VK_CLIENT_SECRET` (optional with PKCE), `VK_API_VERSION` (optional override, default `5.199`).

## Core change
Done: the OAuth callback passes every query parameter to `oauthConnect` as `callbackParams`, so `device_id` reaches the token exchange.

## Review and access requirements
- VK ID apps must be created by a verified business/developer account. Access to `wall`, `groups`, `photos`, `video` and `stats`
  for API calls may need to be requested and approved in the VK ID cabinet (TODO(verify) process and timeline).
- Posting to community walls needs the user to be an admin or editor of the community.
- Before approval, only the basic profile (`vkid.personal_info`) is granted and wall/group calls fail with error 7 or 15.

## Limits and quotas
- 3 requests per second per user token (error 6); per-method daily quotas (error 29); flood control on repeated identical
  actions (error 9). All are mapped to rate_limit retryable.
- `wall.post`: up to 10 attachments; about 50 posts per day per wall (TODO(verify)); captcha (error 14) when posting too fast.
- Message length up to about 16,000 characters.

## Unverified
- `TODO(verify)`: VK ID requires `device_id` (and `state`) in the code exchange; VK ID access tokens are accepted by
  `api.vk.com` methods (wall.*, photos.*, groups.*) without a separate legacy OAuth token.
- `TODO(verify)`: VK ID scope names for API access (`wall`, `photos`, `video`, `groups`, `stats`) and whether they need extended-access approval.
- `TODO(verify)`: latest VK API version (5.199 assumed; overridable with `VK_API_VERSION`).
- `TODO(verify)`: `video.save` parameters for community walls (`group_id`, `wallpost=0`) and the upload response shape.
- `TODO(verify)`: `wall.getById` returns `{ items }` in 5.199 (older versions a bare array); both are handled.
- Posting quotas and the approval timeline above.

## Questions for the owner
- Should editors' communities be connected too (today: admin and editor), or admins only?
- Should community posts be signed with the author's name (`signed=1`)?
- Do you want community messages (requires a community token and the Callback API / Long Poll), which this connector does not cover?
