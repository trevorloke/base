# Mailchimp

Connector `mailchimp` · networks `["mailchimp"]` · `packages/connectors/src/mailchimp.ts` · factory `createMailchimpConnectors(env)` · shared text→HTML helper `packages/connectors/src/html.ts`

## What works
- **Connect** (`connectMethod: "api_key"`): inputs `apiKey` (secret, `<32 hex>-<dc>`), optional `audienceId`, optional `fromName`, optional `replyTo`. The data center suffix picks the host `https://<dc>.api.mailchimp.com/3.0`; requests use HTTP Basic (`any-user:<key>`). `connectWithInputs` calls `GET /ping`, then `GET /lists/<audienceId>` or, without one, the oldest audience (`GET /lists?count=1&sort_field=date_created&sort_dir=ASC`). The sender comes from the inputs or the audience's `campaign_defaults` (`from_name`, `from_email`). externalId = audience id, handle/displayName = audience name. Auth blob `{ apiKey }`; config `{ dc, listId, listName, fromName, replyTo }`.
- **Publish** = a regular campaign to the whole audience, sent immediately (base air already handles scheduling):
  1. `POST /campaigns { type: "regular", recipients: { list_id }, settings: { subject_line, title, from_name, reply_to } }`. Subject = `options.title`, else the post's first line (plain text). Sender = account config, else the audience's campaign defaults read at publish time; missing → rejected.
  2. `PUT /campaigns/<id>/content { html }`: a full HTML email (640px column) with the post text rendered to safe HTML, `options.link`, and images by their **public base air media URLs**. A footer with `*|LIST:ADDRESSLINE|*`, `*|UNSUB|*` and `*|UPDATE_PROFILE|*` is added unless the text already contains `*|UNSUB|*`.
  3. `GET /campaigns/<id>/send-checklist`: when `is_ready` is false the publish fails as `rejected` with Mailchimp's error items (the draft campaign stays in Mailchimp).
  4. `POST /campaigns/<id>/actions/send` (204).
  - Returns `externalId` = campaign id, `url` = `long_archive_url` (else `archive_url`). Idempotent in-process; a retry after a failure continues the same campaign from the step that failed instead of creating a second one.
- **validate**: subject present and ≤ 150 characters; the account has a From name and reply-to (from the audience defaults or connect inputs); no video/document attachments; no polls.
- **Metrics**: `fetchMetrics` reads `GET /reports/<campaign id>`: `reach` = `emails_sent`, `impressions` = `opens.opens_total`, `clicks` = `clicks.clicks_total`, `link_clicks` = `clicks.unique_subscriber_clicks`, `shares` = `forwards.forwards_count`. Campaigns without a report (still sending, deleted) are skipped. `fetchAccountMetrics`: `followers_total` = audience `stats.member_count` (subscribed members).
- **Inbox**: none (`fetchActivity` returns `[]`, `capabilities.fetchActivity` false). Replies to campaigns go to the reply-to mailbox.
- **Errors**: Mailchimp problem documents (`title: detail` plus field errors) go into the message. 401/403 → auth; 400/404 → rejected; 429 (more than 10 simultaneous connections) → rate_limit with `Retry-After` when sent; 5xx/transport → retryable. Messages never contain the key.

## Setup
1. Mailchimp → **Profile → Extras → API keys → Create A Key**; copy it (the `-usX` suffix is part of the key).
2. Make sure the audience has defaults: **Audience → Settings → Audience name and defaults** (From name, From email) and a physical address (required by Mailchimp for sending).
3. Optional: the audience id is under **Audience → Settings → Audience name and defaults → Audience ID**.
4. In base air, connect Mailchimp with the key (and optionally the audience id, From name and reply-to).
- Redirect URI: none today. Mailchimp OAuth 2 (for connecting many clients' accounts without handling keys) is a **later step**: authorize at `https://login.mailchimp.com/oauth2/authorize`, token at `https://login.mailchimp.com/oauth2/token`, data center from `https://login.mailchimp.com/oauth2/metadata`; redirect URI would be `${BASE_AIR_PUBLIC_URL}/oauth/mailchimp/callback`.
- Webhook URL: none (audience webhooks report subscribes/unsubscribes, not needed yet).
- Env vars: none.

## Review and access requirements
None for API keys. Sending requires a verified/authenticated sending domain for the From email (Mailchimp blocks free-mail From addresses like gmail.com under DMARC) and an account in good standing; new accounts may be put under compliance review after their first sends. OAuth apps need registration but no review.

## Limits and quotas
- 10 simultaneous connections per API key; extra requests get 429. Requests time out after 120 seconds.
- Sends count against the plan's monthly email send limit; the Free plan has daily/monthly caps and limited audience size.
- Subject lines up to 150 characters.

## Unverified
- The 150-character subject limit.
- Whether Mailchimp still auto-appends a compliance footer to custom HTML missing `*|UNSUB|*`; base air adds its own footer to be safe.
- `mailchimp.com/developer` was not reachable from the sandbox; endpoint paths and fields come from the long-stable Marketing API v3 (unchanged for years).

## Questions for the owner
- Connect only the first audience (current behaviour), or one base air account per audience?
- Should campaigns go to a segment or tag instead of the whole audience?
- Should base air use a saved Mailchimp template (`template.id` with `mc:edit` sections) instead of its plain HTML layout?
- Is `options.title` the subject line you want, or should there be a separate preview text?
