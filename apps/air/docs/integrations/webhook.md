# Custom webhook (in and out)

Connector `webhook` · network `webhook` · `packages/connectors/src/webhook.ts` · factory `createWebhookConnectors(env)`

The universal connector. It links Base Air to Zapier, Make, n8n, IFTTT, Pipedream or your own code, in both directions:

- **Out**: every post Base Air publishes to this account is POSTed as JSON to a URL you choose. From there your Zap,
  scenario or workflow can post it anywhere Base Air has no native connector (a CMS, a newsletter tool, Slack, a
  spreadsheet, an SMS gateway).
- **In**: anything you POST to the account's inbound URL lands in Base Air's live feed and is scanned by the tracker:
  form entries, reviews, support tickets, app store comments, messages from networks Base Air does not cover.

## What works
- **Connect** (`connectMethod: "webhook_url"`). Three inputs, all optional, but you need at least one of the last two:
  - **Name for this endpoint**: the account's handle in Base Air (default "Webhook to <host>" or "Inbound webhook").
  - **Outbound URL**: where Base Air POSTs published posts. Must be `https://` and a public host. On connect,
    Base Air sends one `ping` delivery in the same shape as a real post (this proves the URL works and gives Zapier,
    Make and n8n a sample to map fields from). If the ping does not get a 2xx answer, the connection fails with the reason.
  - **Signing secret**: 16 to 512 characters you choose (for example `openssl rand -base64 32`). It signs outbound
    deliveries and checks inbound ones. **Leave it empty and inbound is off** (outbound deliveries are then unsigned).
  - Base Air generates the account id (`wh_` + 16 random characters). Auth: `{ accountId, name, outboundUrl?, secret? }`
    (encrypted like every credential). Config (visible, not secret): `{ name, outboundHost, inboundEnabled, inboundUrl, signing }`.
    The outbound URL itself is kept in auth only, because a catch-hook URL is a secret: whoever has it can post to your Zap.
  - The secret is the one you typed. Base Air does not show it again, so keep it in your password manager; to change
    it, reconnect the endpoint (it gets a new account id and inbound URL).
- **Publish** (outbound): `POST <outbound URL>` with `content-type: application/json` and this body:

  ```json
  {
    "event": "post.published",
    "id": "<idempotency key, stable across retries>",
    "text": "Launch day",
    "thread": ["second segment"],
    "media": [{ "url": "https://…/a.jpg", "kind": "image", "mime": "image/jpeg", "alt": "A rocket" }],
    "options": { "link": "https://acme.example.com", "title": "…" },
    "replyTo": null,
    "account": { "id": "wh_…", "name": "Zapier → Slack" },
    "network": "webhook",
    "sentAt": "2026-11-06T12:00:00.000Z"
  }
  ```

  Headers: `X-Base-Air-Event`, `X-Base-Air-Delivery` (= `id`), `X-Base-Air-Timestamp` (unix seconds), and, when the
  endpoint has a secret, `X-Base-Air-Signature: sha256=<hex>` (see Signing). `User-Agent: Base-Air-Webhook/1`.
  Any 2xx is success. If the response is JSON with `id` (string or number) and/or `url` (http/https), they become the
  post's external id and link in Base Air; otherwise the external id is the idempotency key. Redirects are not followed
  (a 3xx fails with "use the final URL"). Timeout 15 s. Idempotent within a process (`IdempotencyCache`), and `id` lets
  the receiver drop duplicates across restarts.
  Media are public URLs from Base Air's media library; nothing is uploaded.
- **Errors** (outbound): 5xx, 408 and transport errors/timeouts → `network`, retryable. 429 → `rate_limit`, retryable,
  with `Retry-After` in the error cause. 401/403 → `auth` ("the receiving system refused the delivery"). 404/410 →
  `auth` ("the URL no longer accepts deliveries; was the Zap turned off?"), so the account shows as needing attention.
  Other 4xx and 3xx → `rejected`. The outbound URL never appears in error messages (only its host).
- **Inbound**: `POST ${BASE_AIR_PUBLIC_URL}/webhooks/webhook?account=<account id>` (shown in the account's config as
  `inboundUrl`). The webhook handler uses `route` (reads `?account=`) and `verifyAccount` (that account's secret), so
  one endpoint's secret can never post into another endpoint. Accepted bodies:

  ```json
  {
    "items": [
      {
        "id": "ticket-881",
        "kind": "message",
        "text": "Where is my order?",
        "author": { "handle": "jane@shop", "name": "Jane" },
        "url": "https://help.example.com/tickets/881",
        "occurredAt": "2026-11-06T11:58:00Z",
        "conversation": { "id": "support", "name": "Support desk", "type": "channel" },
        "lang": "en",
        "parentId": "ticket-880"
      }
    ]
  }
  ```

  A bare array of items, or a single item object, works too.
  - Required: `id` (string or number, up to 256 characters) and `text` (non-empty; cut at 10,000 characters).
  - `kind`: one of `mention` (default), `comment`, `message`, `dm`, `reply`, `repost`, `quote`, `like`, `follow`, `own_post`, case-insensitive.
  - `author`: `{ handle, name }` or just a handle string.
  - `url`: http/https only, else dropped.
  - `occurredAt`: ISO 8601 or unix seconds/milliseconds. If it is missing or unreadable, the time of receipt is used.
  - `conversation.type`: `group`, `channel` (default) or `direct`.
  - `lang`: a BCP 47 tag such as `en` or `pt-BR`; invalid values are ignored, and Base Air detects the language itself.
  - `parentId`: the `id` of another item from the same endpoint.

  Each item is validated with zod. Invalid items are dropped while the rest are kept, and at most **500 items** per delivery are read. External ids are stored as `<account id>:<id>`, so two endpoints that both send `"1"` do not collide, and re-sending the same `id` does not create a duplicate. Items go into the live feed with network `webhook` and the original item in `raw`. Base Air answers `{"accepted":true,"items":<new items>}`. A bad signature gets 403. An unknown or malformed `?account=` gets an error, and bodies over 5 MB are refused.
- **Not available**: reply, moderate, metrics and follower counts (`capabilities`: publish and webhooks true, everything
  else false). `fetchActivity` returns [] because inbound items arrive by push.

## Signing
One scheme in both directions, close to Stripe's:

```
X-Base-Air-Timestamp: 1762430400
X-Base-Air-Signature: sha256=<lowercase hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
```

- The signed text is the timestamp header value, a dot, and the exact raw body bytes. The timestamp is signed, so a captured delivery cannot be replayed later with a new timestamp.
- Base Air refuses inbound deliveries whose timestamp is more than **5 minutes** off its clock, either way. Milliseconds are accepted. Comparison is constant-time.
- Several comma-separated signatures are accepted. This helps when the sending side rotates its secret.
- **Bearer alternative**: tools that cannot compute an HMAC (IFTTT, a no-code Zapier or Make step) may send `Authorization: Bearer <secret>` instead. This is a plain shared secret over HTTPS with no replay protection. Replays only re-send items Base Air already has (they are deduplicated by `id`). Prefer the signature when you can.
- **Verifying Base Air's outbound deliveries** is optional. The catch-hook URL is already a secret. To check them, use the same formula on the raw body you received and compare with `X-Base-Air-Signature`. In code you can call the exported `verifyWebhookRequest(secret, headers, rawBody)` from `packages/connectors/src/webhook.ts`; `signWebhookPayload(secret, ts, body)` produces a signature.

## Setup
- Env vars: `BASE_AIR_PUBLIC_URL` (needed to show a full inbound URL). `BASE_AIR_ALLOW_PRIVATE_URLS=1` lets outbound URLs use `http://` and private or loopback hosts. Use it only for a self-hosted Base Air that talks to a self-hosted n8n on the same network (for example `http://n8n:5678/webhook/…`). Leave it off on shared deployments.
- Webhook URL (inbound): `${BASE_AIR_PUBLIC_URL}/webhooks/webhook?account=<account id>`. Redirect URI: none.
- No developer app and no review: you create the endpoint in Base Air (Accounts → Connect → Custom webhook).

### Test with curl
Inbound, signed (bash, OpenSSL):

```sh
SECRET='your-signing-secret'
URL='https://air.example.com/webhooks/webhook?account=wh_XXXXXXXXXXXXXXXX'
BODY='{"items":[{"id":"test-1","kind":"mention","text":"Hello from curl","author":{"handle":"me"}}]}'
TS=$(date +%s)
SIG=$(printf '%s' "$TS.$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.*= //')
curl -sS -X POST "$URL" -H 'content-type: application/json' \
  -H "X-Base-Air-Timestamp: $TS" -H "X-Base-Air-Signature: sha256=$SIG" --data-raw "$BODY"
# → {"accepted":true,"items":1}
```

Inbound with the bearer secret:

```sh
curl -sS -X POST "$URL" -H 'content-type: application/json' -H "Authorization: Bearer $SECRET" \
  --data-raw '{"id":"test-2","text":"Hello again"}'
```

Simulate an outbound delivery against your own receiver, to check its signature verification:

```sh
BODY='{"event":"post.published","id":"idem-1","text":"Launch day","thread":[],"media":[],"options":{},"replyTo":null,"account":{"id":"wh_x","name":"test"},"network":"webhook","sentAt":"2026-11-06T12:00:00.000Z"}'
TS=$(date +%s)
SIG=$(printf '%s' "$TS.$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.*= //')
curl -sS -X POST 'https://your-receiver.example.com/hook' -H 'content-type: application/json' \
  -H 'X-Base-Air-Event: post.published' -H "X-Base-Air-Timestamp: $TS" -H "X-Base-Air-Signature: sha256=$SIG" --data-raw "$BODY"
```

To see exactly what Base Air sends, point an endpoint at a request inspector (for example webhook.site), connect it, and look at the `ping`.

### Zapier
**Base Air posts → anywhere (outbound)**
1. Create a Zap. For the trigger, choose **Webhooks by Zapier** → **Catch Hook**, then copy the custom webhook URL (`https://hooks.zapier.com/hooks/catch/…`).
2. In Base Air, connect a **Custom webhook**: give it a name, paste the URL as the outbound URL, and optionally add a signing secret.
3. Base Air sends the `ping` at once. In Zapier, click **Test trigger** and pick the ping. Fields such as `text`, `media[]url` and `options__link` can now be mapped.
4. Add a filter step **Only continue if `event` exactly matches `post.published`**, so later pings are skipped. Then add your action (Slack, WordPress, Google Sheets, Buffer, …).
5. In Base Air, schedule posts to the webhook account like any other account.
6. Optional signature check: use **Catch Raw Hook** instead (it keeps the raw body; max 2 MB) and add a **Code by Zapier** (JavaScript) step:

   ```js
   const crypto = require('crypto');
   const want = 'sha256=' + crypto.createHmac('sha256', 'your-secret').update(inputData.ts + '.' + inputData.raw).digest('hex');
   if (want !== inputData.sig) throw new Error('bad signature');
   return JSON.parse(inputData.raw);
   ```

   Map `raw` to the raw body, `ts` to `X-Base-Air-Timestamp` and `sig` to `X-Base-Air-Signature`.

**Anything → Base Air (inbound)**
1. Pick a trigger (new Typeform entry, new Trustpilot review, new Zendesk ticket, …).
2. Action: **Webhooks by Zapier** → **Custom Request** (or POST). Method POST, URL = the account's inbound URL, data pass-through off.
3. Set the data to raw JSON, for example `{"id":"{{entry_id}}","kind":"comment","text":"{{answer}}","author":{"name":"{{name}}"},"url":"{{link}}"}`, with header `Content-Type: application/json` and header `Authorization: Bearer <your secret>`.
4. Test the step. The item appears in Base Air's live feed.

### Make
**Outbound**: create a scenario that starts with **Webhooks** → **Custom webhook**. Click **Add**, copy the address and paste it into Base Air as the outbound URL. While Make is "listening", connect (or reconnect) the endpoint so the `ping` sets up the data structure. Then add a filter `event = post.published` and your modules.

**Inbound**: add an **HTTP** → **Make a request** module with:
- URL = the inbound URL
- Method POST
- Body type Raw, content type JSON (application/json)
- Request content built from your fields (`{"id":"{{1.id}}","text":"{{1.text}}"}`)
- Header `Authorization` = `Bearer <your secret>`

To sign instead, compute the signature in Make with its HMAC function over `<timestamp>.<body>`, then send both headers.

### n8n
**Outbound**: add a **Webhook** node, set the HTTP method to POST and copy its Production URL. Paste that into Base Air as the outbound URL and activate the workflow. To check signatures:
1. In the Webhook node, turn on **Raw Body**.
2. Add a **Crypto** node: action Hmac, type SHA256, encoding hex, with secret = your secret and value = `{{$json.headers["x-base-air-timestamp"]}}.{{ raw body }}`.
3. Add an **IF** node that compares the result with the signature header (minus the `sha256=` prefix).

If the n8n Webhook node uses Basic Auth, put the credentials in the URL (`https://user:pass@n8n.example.com/webhook/…`). Base Air sends them as an `Authorization: Basic` header and never in the request line.

**Inbound**: add an **HTTP Request** node with:
- Method POST
- URL = the inbound URL
- Send Body: JSON
- Send Headers: `Authorization: Bearer <secret>`

You can also use a **Code** node that signs with `require('crypto')` (the same code as the Zapier step) and sends `X-Base-Air-Timestamp` / `X-Base-Air-Signature`.

### IFTTT
Use the **Webhooks** service action **Make a web request**:
- URL = the inbound URL
- Method POST
- Content type `application/json`
- Additional headers `Authorization: Bearer <secret>`
- Body such as `{"id":"{{OccurredAt}}-{{EntryUrl}}","text":"{{EntryTitle}}","url":"{{EntryUrl}}"}`

For outbound, use the IFTTT Webhooks trigger **Receive a web request with a JSON payload** and paste `https://maker.ifttt.com/trigger/<event>/json/with/key/<key>` as the outbound URL.

## What Base Air can and cannot see
- **Can see**: only what your Zap/scenario/workflow or your code POSTs to the inbound URL, signed with the endpoint's secret. It sees the fields listed above, and the whole item is kept as `raw`.
- **Cannot see**: anything else in the connected tools. Base Air gets no access to your Zapier, Make or n8n account and does not read any source system. Outbound, Base Air sends only the posts you publish to this account.
- Be careful what you forward: personal data you POST (names, e-mail addresses in `author`) is stored like any other activity.

## Review and access requirements
None. An endpoint works as soon as it is connected. The plan of the automation tool may limit you. For example, Webhooks by Zapier and IFTTT web requests may need a paid plan (check yours).

## Limits and quotas
- Inbound: 500 items per delivery, 5 MB per body, 10,000 characters of text per item, 5-minute timestamp window. API-level request rate limits apply as for every Base Air webhook.
- Outbound: one POST per published post, 15 s timeout, no redirects. Retries follow Base Air's normal publish retry policy for `network`/`rate_limit` errors, and the receiver can deduplicate on `id`.
- Outbound destinations must be public `https://` hosts. Hostnames are resolved and refused if they point to a private address. A host that changes its DNS answer between that check and the request (DNS rebinding) is not caught. On shared deployments, also keep the API workers' outbound network away from internal services.
- Catch-hook limits on the other side, such as Zapier's raw-body size, apply.

## Unverified
- The click paths and labels in the Zapier, Make, n8n and IFTTT recipes (for example Zapier "Catch Raw Hook", Make's "Custom webhook" / "Make a request", n8n's Webhook "Raw Body" option and Crypto node fields, IFTTT "Make a web request") are from current docs and community answers. They have not been tested end to end from this sandbox. In particular, Make's custom webhook may parse the body before you can HMAC it; use the bearer header with Make if that happens.
- Whether each tool's plan includes the webhook and HTTP steps used here.
- Zapier's Catch Hook answers with a JSON body that includes an `id`. If it does, that id (a Zapier request id) becomes the post's external id, which is harmless but is not a post id.

## Questions for the owner
- Should Base Air also generate a secret for people who leave the field empty (shown once at connect)? Today the person picks the secret so they can paste the same value into the other tool.
- Should inbound items from a webhook be able to claim another network (for example `network: "trustpilot"`) once such networks exist? Today every item is filed under `webhook`.
- Do you want delivery logs (last 20 outbound attempts with status) shown on the account page?
- Is the bearer-secret option acceptable for your security posture, or should inbound require the HMAC signature only?
