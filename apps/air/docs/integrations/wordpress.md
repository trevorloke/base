# WordPress

Connector `wordpress` · networks `["wordpress"]` · `packages/connectors/src/wordpress.ts` · factory `createWordPressConnectors(env)` · shared text→HTML helper `packages/connectors/src/html.ts`

## What works
- **Connect** (`connectMethod: "app_password"`): inputs `siteUrl`, `username`, `applicationPassword` (secret). `connectWithInputs` normalizes the URL (adds `https://`, drops trailing slashes), strips the spaces WordPress shows in Application Passwords and calls `GET /wp-json/wp/v2/users/me?context=edit` with HTTP Basic auth. When `/wp-json` is not routed (sites without pretty permalinks) it retries through `/?rest_route=/wp/v2/users/me` and remembers `restMode: "plain"`. Users whose `capabilities.publish_posts` is false (Contributors, Subscribers) are refused. The site index (`GET /wp-json/`) supplies the site name. externalId and handle = site key `host[/path]`; config keeps `siteUrl`, `userId`, `userName`, `siteName`, `roles`. Auth blob: `{ siteUrl, username, applicationPassword, restMode }`. Plain `http://` is refused except for localhost (WordPress disables Application Passwords without HTTPS).
- **Publish** (`POST /wp/v2/posts`):
  - `title` = `options.title` (required: `validate` reports it and `publish` refuses without it).
  - `content` = the post text rendered to safe HTML (escaped; paragraphs, line breaks, `#` headings, lists, quotes, bold/italic/code, `[label](url)` and bare links); `options.link` is appended when the text does not contain it.
  - `excerpt` = the first paragraph (plain text, ≤ 300 chars) when the body has more than one paragraph; otherwise WordPress generates it.
  - `status` from visibility: `public` / unset → `publish`; `private` (or `privacy: "private" | "self"`) → `private` (WordPress's native private post, visible to logged-in editors); `unlisted` / `direct` → `draft` (saved for review, not public).
  - `tags`: each `options.tags` name (leading `#` dropped, de-duplicated case-insensitively) is resolved with `GET /wp/v2/tags?search=` (exact, case-insensitive, entity-decoded match), else created with `POST /wp/v2/tags`; a `term_exists` error yields its `term_id`. Ids are cached per site.
  - Media: every image/GIF/video is uploaded with `POST /wp/v2/media` (raw bytes from `this.media.fetch`, `Content-Type` and `Content-Disposition: attachment; filename="…"`, `alt_text` as a query parameter). The first image becomes `featured_media`; other uploads are placed after the text (`<img>` / `<video controls>`). With no image, `options.thumbnailUrl` is downloaded and uploaded as the featured image. Documents are refused by `validate`.
  - `options.firstComment` is posted as a comment on published posts (best effort, the result is in `raw.firstComment`).
  - Returns `externalId` = post id, `url` = `link`. Idempotent in-process; uploads are reused when a retry follows a failed post creation.
- **Inbox**: `fetchActivity` reads `GET /wp/v2/comments?status=approve` and `?status=hold` (held comments only when the user may moderate; a 401/403 on that query is skipped), `after=<since UTC>`, `orderby=date_gmt&order=asc`, 100 per page, up to 5 pages each. Comments written by the connected user are skipped. Mapping: kind `comment`, externalId `<site key>#comment-<id>`, `parentExternalId` = post id (as returned by `publish`), `authorName` = `author_name`, `authorHandle` = the commenter's website URL when given, text = rendered content as plain text, `url` = comment permalink, `raw` = the comment.
- **reply**: parent `…#comment-<id>` → reads the comment for its post, then `POST /wp/v2/comments { post, parent, content }`; a numeric parent is treated as a post id (top-level comment).
- **moderate**: `hide` → `POST /wp/v2/comments/<id> { status: "hold" }`; `unhide` → `{ status: "approve" }`; `delete` → `DELETE /wp/v2/comments/<id>` (moves to trash, no `force`); `like`/`unlike` refused (core has no likes).
- **Metrics**: none. Core REST has no per-post statistics; `capabilities.fetchMetrics` is false and there is no `fetchAccountMetrics`. Jetpack Stats (`/wpcom/v2` or the WordPress.com stats API) is a later step.
- **Errors**: 401 → auth ("check the username and Application Password"); 403 → auth (role lacks the capability); 404/400 → rejected (WordPress `code: message` in the text); 429 → rate_limit with `Retry-After`; 5xx and transport failures → retryable network. Messages never contain the password.

## What Base Air can and cannot see
Base Air sees comments on the site's posts that are approved or waiting for moderation (when the connected user may moderate), with the commenter's display name, website and comment text. It does not read commenter email addresses or IP addresses, spam or trashed comments, private messages, or anything outside the REST API.

## Setup
1. Use WordPress 5.6+ over HTTPS. On the site, sign in as the user Base Air should post as (Author, Editor or Administrator).
2. **Users → Profile → Application Passwords**: name it "Base Air", click *Add New Application Password*, copy the password.
3. In Base Air, connect WordPress with the site URL, the username and that password.
- If the REST API is blocked by a security plugin or host firewall, allow `/wp-json/wp/v2/*` (or `?rest_route=`) for authenticated requests.
- WordPress.com: only Business/Commerce plans (plugins enabled, "Application Passwords" available) work with this connector. Other WordPress.com plans need WordPress.com OAuth (`https://public-api.wordpress.com/oauth2/authorize`, REST at `public-api.wordpress.com/wp/v2/sites/<site>/…`), which is a **later step**: redirect URI would be `${BASE_AIR_PUBLIC_URL}/oauth/wordpress/callback`.
- Redirect URI: none today (not OAuth). Webhook URL: none (WordPress core does not push events; polling is used).
- Env vars: none.

## Review and access requirements
None. Application Passwords work as soon as the user creates one. Some managed hosts disable Application Passwords or the REST API for unauthenticated users; Base Air authenticates every call, but hosts that strip the `Authorization` header (some Apache/CGI setups) need the usual `.htaccess` fix (`SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1`).

## Limits and quotas
- Core WordPress has no API rate limit; hosts, CDNs and security plugins may impose one (429 is handled as a retryable rate limit).
- Upload size is the site's `upload_max_filesize`/`post_max_size` (often 2–128 MB) and allowed mime types.
- `per_page` ≤ 100 on collection endpoints.

## Unverified
- `alt_text` passed as a query parameter on the binary `POST /wp/v2/media` upload is applied to the attachment (it is a documented create argument; query-parameter delivery on a raw-body upload is assumed).
- `after` on `/wp/v2/comments` is compared against `comment_date_gmt`, so sending a UTC timestamp is correct.
- The WordPress developer documentation site could not be fetched from the sandbox; endpoint shapes come from long-standing core REST behaviour (stable since WordPress 4.7/5.6).

## Questions for the owner
- Is `unlisted`/`direct` → **draft** the right mapping, or should those variants be refused?
- Should Base Air also read comments in the `spam` queue for moderation, or leave spam to Akismet?
- Is the Jetpack/WordPress.com Stats integration (views per post) wanted for analytics, and are the sites on Jetpack?
- Should the excerpt be left to WordPress (or the theme) instead of the first paragraph?
