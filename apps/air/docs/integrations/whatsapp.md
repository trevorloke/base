# WhatsApp

Connector `whatsapp` · networks `["whatsapp"]` · `packages/connectors/src/whatsapp.ts` · factory `createWhatsAppConnectors(env)`

Built only on Meta's official **WhatsApp Business Platform (Cloud API)**. No WhatsApp Web automation, no unofficial
libraries (whatsapp-web.js, Baileys and similar): they break WhatsApp's terms and get numbers banned.

## What Starsign can and cannot see
- **Starsign sees** messages that people send to the business's own WhatsApp number (1:1 chats), and messages in
  **groups the business created itself through Meta's Groups API**, where people joined through the business's invite link.
- **Starsign cannot see** personal WhatsApp chats, personal WhatsApp groups, or groups created by anyone else, even when
  the business owner is a member. No official API offers that, for any app. Tools that claim to do it log into a
  personal WhatsApp account through WhatsApp Web; WhatsApp detects them and bans the number. Starsign will not do it.
- Starsign cannot read older messages: only messages that arrive after the number is connected, as they arrive.
- WhatsApp Channels (the one-to-many broadcast feature) have no API, so Starsign can neither post to nor read them.

## What works
- **Connect** (`connectMethod: "api_key"`): inputs `phoneNumberId`, `wabaId` (WhatsApp Business Account ID) and
  `accessToken` (secret; a System User permanent token). `connectWithInputs` calls
  `GET /{phone-number-id}?fields=display_phone_number,verified_name,quality_rating` and returns one account:
  externalId = phone number ID, handle = display phone number, displayName = verified business name. It then calls
  `POST /{waba-id}/subscribed_apps` so the deployment's Meta app receives that WABA's webhooks; a failure is reported as
  a clear error ("the phone number is valid, but subscribing this app ... failed") and nothing is connected.
  Auth blob: `{ accessToken, phoneNumberId, wabaId }`. Config: `phoneNumberId`, `wabaId`, `displayPhoneNumber`,
  `verifiedName`, `qualityRating`, `webhooksSubscribed`, and optionally `defaultGroupId` (see Publish).
  `describeAccount` re-reads the phone number. `connectConfigured` is false until an app secret is set, because without
  it no webhook delivery can be verified and nothing would arrive.
- **Inbox (webhook only)**: the Cloud API has **no endpoint to read messages**, so `fetchActivity` returns `[]` and
  `capabilities.fetchActivity` is false; messages appear in the live feed only through the webhook. `webhook.parse` reads
  `entry[].changes[]` with `field: "messages"`, routes by `value.metadata.phone_number_id`, and maps `value.messages[]`:
  - 1:1 → kind `dm`, conversation `{ id: <wa_id>, type: "direct" }`.
  - Group (message carries `group_id`) → kind `message`, conversation `{ id: <group id>, name, type: "group" }`; a group
    message that replies to one of the business's messages → `reply`; one containing `@<business number>` → `mention`.
    The business's own messages echoed in a group are dropped.
  - Text → `text.body`; image/video/document → caption; interactive button/list replies → the chosen title; template
    quick-reply buttons → button text; location → name and address; audio/sticker/contacts/order → no text (raw kept).
  - Reactions → kind `like` with the emoji as text and the reacted message as parent; removed reactions are skipped.
  - `context.id` → `parentExternalId`. `statuses` (sent/delivered/read/failed), `system` and `unsupported` messages are
    not activities and are ignored.
  - `authorName` comes from `value.contacts[].profile.name`, and is left empty when that name is itself a phone number.
    `authorHandle` is the sender's `wa_id` (the number the business replies to) or, when WhatsApp withholds the number
    (usernames), the business-scoped user id (BSUID).
  - External ids: `<wa_id or BSUID>:<wamid>` for 1:1, `group:<group id>:<wamid>` for groups. The wamid alone does not
    say whom an answer goes to, so the conversation is part of the id; `reply`/`moderate` also accept a bare wamid that
    this process saw by webhook.
- **reply**: `POST /{phone-number-id}/messages` with `messaging_product: "whatsapp"`, `recipient_type` `individual` or
  `group`, `to` (wa_id or group id), `type: "text"`, `text: { body, preview_url }` and `context: { message_id }`.
  Error 131047 (and legacy 470) becomes a `rejected` error: "outside the 24-hour window; WhatsApp only allows an
  approved template now". **Template sending is out of scope** for this connector.
- **Publish**: WhatsApp has no public feed. `publish` sends to the account's **`defaultGroupId`** (a group created with
  the Groups API): text (with `options.link` appended, link previews on), or one image/video/document by URL (`link`)
  with the text as caption (a caption over 1024 characters is sent as a follow-up text). Without a group, `validate`
  returns "WhatsApp posts go to a group; set one up first" and `publish` refuses. `capabilities.publish` is true only in
  this sense. Idempotent in-process. GIFs, polls, threads and multiple media are flagged by `validate`.
  Set it with the optional "Group to post to" field when connecting; creating groups and invite links through
  the Groups API is a later step.
- **moderate**: `like` sends a 👍 reaction message to the message; `unlike` sends an empty-emoji reaction (removes it).
  hide/unhide/delete are refused: a business cannot hide or delete other people's WhatsApp messages.
- **Metrics**: none. There are no per-message reach or engagement numbers (delivery/read receipts are per recipient), and
  a business number has no followers. `fetchMetrics` and `fetchAccountMetrics` return nothing; `accountMetrics` is false.
- **Errors**: 190 (and other OAuth/permission codes, 131005, 131031) → auth; 4, 80007, 130429, 131056, 131048 and HTTP
  429 → rate_limit (retryable); 131026 → rejected ("message undeliverable"); 131000, 131016, 1, 2 and 5xx/network →
  retryable; anything else through the shared Graph mapping in `meta.ts`. Tokens go in the Authorization header, never in
  URLs, and are scrubbed from error messages.

## Setup
1. In Meta for Developers, create (or reuse) a **Business** app and add the **WhatsApp** product. Link it to the
   business portfolio that owns the WhatsApp Business Account, and register the business phone number on the Cloud API
   (WhatsApp Manager → Phone numbers). Note the **Phone number ID** and **WhatsApp Business Account ID** shown on the
   app's WhatsApp → API setup page.
2. In Business Settings → Users → **System users**, create a system user (admin), assign it the app and the WhatsApp
   account (full control), and generate a token that **never expires** with `whatsapp_business_messaging` and
   `whatsapp_business_management`. This is the token pasted into Starsign.
3. In the app's WhatsApp → Configuration, set the webhook:
   - Callback URL: `${STARSIGN_PUBLIC_URL}/webhooks/whatsapp`
   - Verify token: the value of `WHATSAPP_VERIFY_TOKEN`
   - Subscribe the **`messages`** field.
4. Connect WhatsApp in Starsign with the three values. Starsign subscribes the app to the WABA (`subscribed_apps`).
- Redirect URI: none yet (not OAuth). **Embedded Signup** (Facebook Login for Business with the WhatsApp configuration,
  so a customer onboards their own number without copying IDs or tokens) is a later step; it needs the app to be a Tech
  Provider / Solution Partner.
- Env vars:

| Variable | Required | Meaning |
| --- | --- | --- |
| `WHATSAPP_APP_SECRET` | yes (or a fallback) | Meta app secret; verifies `X-Hub-Signature-256` on every delivery. Falls back to `META_APP_SECRET`, then `META_CLIENT_SECRET` when WhatsApp lives on the same Meta app as Facebook/Instagram |
| `WHATSAPP_VERIFY_TOKEN` | yes | Any random string; must match the verify token typed in the app's webhook settings |
| `WHATSAPP_GRAPH_VERSION` | no | Graph API version, default the same as `meta.ts` (`v26.0`) |
| `WHATSAPP_APPSECRET_PROOF` | no | `true` to send `appsecret_proof` (needed when the app has "Require App Secret" on) |
| `STARSIGN_PUBLIC_URL` | yes | Base of the webhook URL |

## Review and access requirements
- A Cloud API number can message right away in **development** with up to 5 test recipients. Production needs a
  verified business (Business Verification in the portfolio), an approved display name, and a payment method on the WABA.
- An app used only by the business that owns it (system user token from its own portfolio) does not need App Review.
  Serving other businesses' numbers needs Advanced Access to `whatsapp_business_messaging` and
  `whatsapp_business_management` through App Review, plus Tech Provider onboarding for Embedded Signup. Typical review
  time is days to a few weeks.
- **Groups API** is open to businesses with an **Official Business Account** (OBA, the verified badge) on the Cloud API
  (per Meta's Groups API page, updated June 2026). Older third-party guides cite a 100k-conversation tier instead.
  Numbers onboarded to Multi-solution Conversations reportedly cannot use it. Without OBA, Starsign still works for 1:1
  chats; group monitoring and publishing are unavailable.

## Limits and quotas
- **24-hour customer service window**: free-form replies are allowed only within 24 hours of the customer's last message.
  Outside it, only approved templates (not supported here) can be sent.
- **Pricing**: Meta charges for business messaging by message/conversation category (marketing, utility, authentication;
  service replies inside the window have been free), varying by country. Check current pricing on Meta's site before
  enabling sending at volume.
- Throughput: about 80 messages/second per number by default (130429 when exceeded); a per-user pair limit (131056)
  applies when sending many messages to the same person quickly; daily business-initiated messaging limits depend on the
  number's tier and quality rating.
- Text body up to 4096 characters; media captions up to 1024; one media item per message; media sent by public `link`.
- Groups API (third-party sources): up to 8 participants per group including the business; up to 10,000 groups per
  number; people join only through an invite link; calls, disappearing messages, view-once media, interactive buttons
  and catalog messages are not supported in groups.

## Unverified
- Group message payload: Meta's reference shows `group_id` on each `messages[]` item and a matching sender in `contacts[]`;
  no group name field was seen (the connector reads `group_subject` / `group_name` defensively). The developer site was
  not reachable from the sandbox, so field names come from search excerpts of Meta's docs and BSP mirrors.
- Group limits (8 participants, 10,000 groups), OBA-only eligibility details and whether media sends work in groups (Meta
  says media is supported; one BSP reports text only in practice).
- Whether business-sent messages are echoed to the webhook in groups (dropped if they are).
- BSUID rollout: field names `user_id` / `from_user_id`, and sending to a BSUID with `recipient` instead of `to`
  (from BSP docs, not Meta's reference).
- Error codes 131048 (spam rate limit), 131005, 131031, 131000, 131016 and the caption/text limits; 131047 also often
  arrives asynchronously as a `failed` status webhook, which this connector ignores (statuses are not activities), so a
  late window failure is not surfaced.
- Whether reactions are allowed in groups.

## Questions for the owner
- Does the business have (or plan to apply for) an **Official Business Account**? Without it, there are no groups.
- Which group should receive posts (`defaultGroupId`)? Should Starsign create groups and invite links itself?
- Should failed-delivery status webhooks (e.g. 131047 after a late reply) be shown in the inbox?
- Is WhatsApp on the same Meta app as Facebook/Instagram (shared secret) or a separate app?
- Should Starsign later send approved templates to re-open conversations (and accept the per-message cost)?
