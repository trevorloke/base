# WeChat (Official Account / 公众号)

Connector `wechat` · networks `["wechat"]` · `packages/connectors/src/wechat.ts` (+ `wechat-crypto.ts`) · factory `createWeChatConnectors(env)`

Uses the official WeChat Official Account platform API (`api.weixin.qq.com`) only. No personal-account automation, no web-client scraping, no itchat/wechaty "puppets".

## What Starsign can and cannot see
- **Starsign sees the messages people send to your Official Account**: text, plus short summaries of images, voice messages (with WeChat's speech-to-text when it is there), videos, locations and shared links. It also sees new followers. It can answer a person by customer service message for 48 hours after their last message.
- **Starsign cannot see personal chats or WeChat groups (群聊).** No official WeChat API lets anyone read personal chats or group chats, and Starsign will not pretend otherwise. The tools that claim to do this ("puppet" / hook / web-protocol bots that log in as a personal WeChat) are unofficial. WeChat detects them and **restricts or permanently bans the accounts** that use them. Starsign does not use them.
- **The official route to monitor groups is WeCom (企业微信)**, not WeChat. A business that runs its customer groups as WeCom **customer groups (客户群)** can, with the paid **会话内容存档 (conversation content archive)** add-on and the members' consent notices, read those group messages through WeCom's official API. That would be a separate, later Starsign connector (`wecom`). It covers groups created by your WeCom staff, not arbitrary WeChat groups.
- Starsign does not see comments under your articles (留言 has no general API for self-developed accounts), Moments (朋友圈), Channels (视频号), or anything about people beyond the opaque openid WeChat gives for each follower.

## What works
- **Connect** (`connectMethod: "api_key"`): inputs `appId` (AppID), `appSecret` (secret), `originalId` (the account's original ID `gh_…`, which is the `ToUserName` of every message), `token` (secret; the Token you typed in the server configuration) and `encodingAesKey` (secret; 43 characters, needed for safe mode). EncodingAESKey is optional: leave it empty when the account uses plaintext mode. `connectWithInputs` validates formats (without echoing values), then calls `POST /cgi-bin/stable_token` to prove the AppID/AppSecret and that the server's IP is allowed. Account externalId and handle = original ID; displayName is null (self-developed accounts have no API returning their own nickname). Auth blob: `{ appId, appSecret, originalId, token, encodingAesKey? }`. Config: `{ appId, mode: "safe" | "plaintext", webhookUrl }` where `webhookUrl` is the exact server URL to paste into WeChat.
- **Access token**: `stable_token` (normal mode), cached in memory per AppID with its expiry (~7200 s) and renewed 5 minutes early; concurrent requests share one fetch. On 40001/40014/42001 the cache is dropped and the call retried once with a fresh token; if `stable_token` hands back the same rejected token, the connector asks once with `force_refresh: true` (WeChat limits forced refreshes to about 20 a day).
- **Webhooks** (per-account Token and AES key):
  - `route`: `?account=<gh id>` from the URL; for POST bodies, falls back to the XML `ToUserName` (present in plaintext and in the encrypted envelope).
  - `challengeAccount` (GET server check): `signature == sha1(sort([token, timestamp, nonce]).join(""))` compared in constant time → returns `echostr`.
  - `verifyAccount`: plaintext mode checks the same `signature`; safe/compatible mode (`encrypt_type=aes` or an `Encrypt` element) checks `msg_signature == sha1(sort([token, timestamp, nonce, Encrypt]))`. Timestamps more than 5 minutes off are rejected (replay protection).
  - `decodeAccount`: parses the XML (own small parser: CDATA, entities, nested elements; no dependency) and, in safe mode, decrypts `Encrypt`: AES-256-CBC, key = base64(EncodingAESKey + "="), IV = key[0..16], PKCS#7 padding to 32 bytes, plaintext = 16 random bytes + 4-byte big-endian length + XML + AppID; the trailing AppID must equal the account's AppID.
  - `ack`: plain text `success` (WeChat shows "该公众号暂时无法提供服务" to the person for any other non-XML body).
  - `parse`: `text` → `dm`; `image` → `[image] <PicUrl>`; `voice` → `[voice] <Recognition>` or `[voice message]`; `video`/`shortvideo` → `[video]`; `location` → `[location] <Label> (x, y)`; `link` → `[link] <Title> <Description> <Url>`; other types → `[<type>]`. Event `subscribe` → `follow` (QR scene noted); `unsubscribe` and other events are ignored. conversation `{ id: openid, type: "direct" }`, authorHandle = openid, authorName null, externalId `<openid>:<MsgId>` (or `<openid>:<CreateTime>` without MsgId), occurredAt from CreateTime, accountExternalId = ToUserName (so a delivery verified with one account's Token cannot inject items into another account).
- **reply**: customer service message `POST /cgi-bin/message/custom/send` `{ touser: openid, msgtype: "text", text: { content } }` with the openid taken from the parent's external id. Idempotent in-process. The API returns no message id, so the reply's externalId is `<openid>:reply:<idempotencyKey>`. 45015 → `rejected` ("WeChat only allows replies within 48 hours of the person's last message, or they unfollowed").
- **Account metrics**: `followers_total` from `GET /cgi-bin/user/get` (`total`). If the account is not permitted (48001/50001/50002) nothing is returned.
- **Not supported**: `publish` (throws `rejected`, capability false), `moderate`, per-post metrics, `fetchActivity` (returns `[]`: WeChat only pushes; there is no API to read messages back).
- **Errors**: WeChat answers HTTP 200 with `errcode`. -1 → network (retryable); 40164 → rejected with "add this server's outbound IP to the API IP whitelist" (kept `rejected` so core shows the message and does not ask to reconnect); 89501/89503 → rejected (admin must approve the IP); 40001/40014/42001 → auth (after one refresh); 40013/40125/41002/41004/40243 → auth (AppID/AppSecret rejected or frozen); 45009/45011 → rate_limit (retryable); 45015, 45047, 43004, 48001, 40003 → rejected with explanations. AppSecret, Token, EncodingAESKey and access tokens are never put in errors (error text is scrubbed; URLs are never included).

## Setup
1. Have an Official Account. For replies, it must be a **verified service account (已认证服务号)**: the customer service message API is not available to unverified accounts or (in most cases) subscription accounts.
2. In the **WeChat Developer Platform** (微信开发者平台, developers.weixin.qq.com/platform; older accounts: mp.weixin.qq.com → 设置与开发 → 基本配置), open the Official Account and:
   - copy the **AppID**, enable/reset the **AppSecret** (it is shown once);
   - in **API IP 白名单**, add the **outbound IP(s)** of the Starsign server(s) that call `api.weixin.qq.com` (single IPs or ranges; no ports). Wait a few minutes.
   - find the **original ID (原始ID, gh_…)** in the account information.
3. In Starsign, connect WeChat with AppID, AppSecret, original ID, a Token you choose (3–32 letters/digits) and, for safe mode, an EncodingAESKey (generate it in the next step first; leave it empty for plaintext mode).
4. Back in the platform's **消息推送 / 服务器配置**: URL = `${STARSIGN_PUBLIC_URL}/webhooks/wechat?account=<gh_id>` (shown in the account's config as `webhookUrl`), Token = the same Token, EncodingAESKey = the same key, 消息加解密方式 = **安全模式** (recommended) or 明文模式. Submit: WeChat calls the URL with `echostr`, Starsign answers if the Token matches. Then **enable** the server configuration. Note: enabling it turns off the platform's own auto-replies and custom menu configured in the web console.
- Redirect URI: none (not OAuth).
- Webhook URL: `${STARSIGN_PUBLIC_URL}/webhooks/wechat?account=<gh_id>`. Must be a public domain on port 80/443 (http or https); intranet hosts and IP addresses are refused by WeChat.
- Env vars: `STARSIGN_PUBLIC_URL`; optional `WECHAT_API_BASE` (e.g. `https://api2.weixin.qq.com` disaster-recovery domain, or a regional `sh.`/`sz.`/`hk.api.weixin.qq.com`).

## Review and access requirements
- **Verification (微信认证)** of the service account (annual fee, business documents; usually a few days to two weeks) unlocks the customer service message API and the user list. Before verification, Starsign still receives messages (the server configuration works for every account) but cannot reply or count followers.
- No app review by WeChat beyond that; the API IP whitelist and AppSecret are controlled by the account's administrator (who confirms changes by scanning with WeChat).
- **Mainland-China realities**: Official Accounts are registered by a mainland entity (or an overseas entity through the overseas registration process). The webhook must answer within **5 seconds** from WeChat's servers in China, so the Starsign endpoint should be reachable and fast from mainland China (a mainland or Hong Kong region helps; a server in mainland China needs an **ICP filing (备案)** for its domain). Starsign's outbound calls to `api.weixin.qq.com` must come from fixed IPs on the whitelist: serverless or autoscaled hosts with changing egress IPs need a NAT/egress gateway with static IPs. `api.weixin.qq.com` is reachable globally but latency from outside China varies; `api2.weixin.qq.com` is the fallback domain.

## Limits and quotas
- Access token: valid up to 7200 s; `stable_token` force refresh ~20/day with ≥30 s between calls; daily call quotas per API (e.g. `stable_token`), errcode 45009 when exceeded.
- Customer service messages: only within **48 hours** of the person's last interaction (message, menu click, follow, scan…); no per-message quota inside the window, but a per-user downlink cap (45047) applies.
- User list: up to 10,000 openids per `user/get` page (Starsign reads only `total`).
- Messages: WeChat retries a webhook delivery 3 times if no answer within 5 s; core deduplicates on `(network, externalId)`.
- Text content: `NETWORK_LIMITS.wechat.maxText` is 600 in Starsign; the customer service API accepts longer text (limit not confirmed).

## What a later article-publishing step needs
Broadcasting on an Official Account is articles, not posts: (1) upload the cover and inline images (`/cgi-bin/material/add_material` for the cover → `thumb_media_id`; `/cgi-bin/media/uploadimg` for images inside the article body, which must be WeChat-hosted URLs), (2) create a draft (`/cgi-bin/draft/add` with `articles[]`: title, author, digest, content HTML, content_source_url, thumb_media_id, comment settings), (3) publish it with `/cgi-bin/freepublish/submit` and poll `/cgi-bin/freepublish/get` (or the `PUBLISHJOBFINISH` event) for the `article_id`/URL. Freepublish articles do not push a notification to followers; a pushed broadcast is mass send (`/cgi-bin/message/mass/sendall`), which subscription accounts may do once a day and service accounts a few times a month. Per-article metrics come from the 数据统计 (datacube) APIs with a one-day delay. Starsign would need a `kind: "article"` variant with a title, cover image and HTML body.

## Unverified
- `// TODO(verify)` 89501/89503 meaning (IP pending admin confirmation when no whitelist is set) and mapping.
- `// TODO(verify)` 45047 is the customer service per-user downlink cap.
- `// TODO(verify)` voice `Recognition` field availability (speech recognition in pushed messages has been reported as being phased out).
- `// TODO(verify)` no API returns a self-developed Official Account's own nickname (only third-party platforms via `api_get_authorizer_info`); displayName is null.
- `// TODO(verify)` the server URL check (GET with `echostr`) uses plain `signature` and an unencrypted `echostr` in every mode for Official Accounts.
- The exact console path for AppSecret / IP whitelist / server configuration after the move to the WeChat Developer Platform.
- Whether `user/get` requires verification for subscription accounts (the doc lists permission sets 2 and 100 for third parties only).
- Exact customer service text length limit.
- developers.weixin.qq.com could not be fetched from the build sandbox; endpoints and codes were confirmed through search results of the official pages (`stable_token`, `message/custom/send` with the 48-hour window, `user/get` fields, the encryption guide, the API IP whitelist page and 40164) and the community forum, not by reading every page in full.

## Questions for the owner
- Which Official Account(s): service account or subscription account, and is it **verified**? (Replies need a verified service account.)
- What are the **static outbound IPs** of the Starsign servers to add to the API IP whitelist?
- Safe mode or plaintext mode? (Safe mode recommended.)
- Is anything else already using this account's server configuration (another platform's auto-replies, a menu, a CRM)? Only one server URL can be active; Starsign would replace it, and enabling it disables the console's auto-replies and menu.
- Where will Starsign be hosted for China traffic (5-second webhook answer from mainland), and is an ICP filing in place if hosted in mainland China?
- Do you need group monitoring? If yes, are your customer groups run in **WeCom**, and would you buy 会话内容存档 for a later WeCom connector?
- Do you want article publishing (drafts + freepublish) later, and should it ever use mass send with its tight quotas?
