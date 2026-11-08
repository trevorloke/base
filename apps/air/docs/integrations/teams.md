# Microsoft Teams

Connector `teams` · networks `["teams"]` · `packages/connectors/src/teams.ts` · factory `createTeamsConnectors(env)`

Post-only through a **Teams Workflows webhook** (Power Automate), the replacement for the retired Office 365
connectors ("Incoming Webhook"). One base air account = one workflow (externalId = the workflow id from the URL).

## What works
- **Connect** (`connectMethod: "webhook_url"`): input `webhookUrl` (secret). Accepted: `https://` URLs on
  `*.environment.api.powerplatform.com` (flows created since mid-2025) or `*.logic.azure.com` (older flows), port 443
  or none, path `…/workflows/<id>/triggers/<trigger>/paths/invoke`, with a `sig=` query parameter (the credential).
  Legacy `*.webhook.office.com/webhookb2/…` URLs are refused with a migration hint. Only the URL is checked
  (posting a test card would spam the channel); a broken flow shows up on the first publish.
- **publish**: `POST` the documented envelope
  `{ type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content }] }`
  with an Adaptive Card **1.4**: a bold title TextBlock (`options.title`), the text in a wrapped TextBlock (Teams
  renders its Markdown subset: `**bold**`, `_italic_`, lists, `[text](url)`), an Image (`media[0].url`, public HTTPS,
  alt text) and an `Action.OpenUrl` "Open link" button for `options.link`; `msteams.width: "Full"`.
  The workflow answers **202 Accepted** with no message id: externalId = `<workflow id>:<x-ms-workflow-run-id>` when
  that header is present, else `<workflow id>:k-<hash of idempotency key>`; `url` null. Idempotent per key in-process.
- **validate**: not empty; no threads; at most one image (image/gif kinds, HTTPS URL); card JSON ≤ ~28 KB.
- No inbox, reply, moderation or metrics: `fetchActivity` / `fetchMetrics` return `[]`.
- **Errors**: 429 → `rate_limit` (retryable, `Retry-After`); 401/403/404, 409 `WorkflowDisabled` → `auth`
  (flow deleted, off, or URL changed); other 4xx → `rejected`; 5xx and transport errors → retryable `network`. The
  `sig` (raw or encoded) is scrubbed from error messages.

## What base air can and cannot see
- **Can see**: nothing. The workflow only posts cards.
- **Cannot see**: channel messages, replies to base air's cards, reactions, members. A 202 means the flow accepted
  the request, not that the card reached the channel (failures appear in the flow's run history in Power Automate).
  Reading channels needs Microsoft Graph with tenant admin consent, and Microsoft's protected-API approval for
  reading message content (a later step).

## Setup
1. In Teams, open the channel → **⋯ → Workflows** (or the Workflows app) → template **"Send webhook alerts to a
   channel"** (trigger "When a Teams webhook request is received", action "Post card in a chat or channel"). Pick the
   team and channel, create it, and copy the URL shown.
2. Optional: in Power Automate, restrict who can trigger the flow (the default is "Anyone" with the signed URL).
3. In base air, connect Teams with that URL.
- Redirect URI: none. Webhook URL (inbound to base air): none.
- Env vars: none.

## Review and access requirements
None for the workflow webhook itself, but: the flow runs as the person who created it (it stops if they leave the
organization or lose their license), the "Flow bot" posts only in channels it can reach (standard channels; not
private/shared channels in some tenants), and tenant admins can block Power Automate or the Teams connector. Reading
messages later through Graph needs an Entra app registration, admin consent for `ChannelMessage.Read.All` (or RSC
permissions), and Microsoft's protected API approval.

## Limits and quotas
- Adaptive Card payloads up to about 28 KB; Workflows render schema 1.4 reliably (1.5 cards were reported not to
  render).
- Power Automate limits flow runs per plan (requests per 24 h per user/flow) and throttles bursts with 429.
- Office 365 connector webhooks (`webhook.office.com`) were retired in 2025–2026; URLs on `logic.azure.com` from
  before the 2025 URL change may also stop working, so prefer a freshly created workflow URL.

## Unverified
- `// TODO(verify)` the host list (`*.logic.azure.com`, `*.environment.api.powerplatform.com`): Microsoft does not
  publish one; both shapes were seen in third-party docs.
- `// TODO(verify)` `x-ms-workflow-run-id` on the 202 response (a Logic Apps header; Power Platform direct URLs may
  not send it).
- `// TODO(verify)` error codes for a turned-off or deleted flow (`WorkflowNotFound` 404 / `WorkflowDisabled` 409)
  and a bad signature (401).
- The 28 KB and card 1.4 limits, and the exact retirement dates of Office 365 connectors, come from search summaries
  that disagree on dates.

## Questions for the owner
- Who in your tenant owns the workflow (it breaks if that person leaves)? A shared service account is safer.
- Do you want to plan the Graph-based reader (admin consent + protected API request), or is posting enough?
