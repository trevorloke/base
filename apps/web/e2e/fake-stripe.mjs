// A stand-in for the outside services the site calls, so the end-to-end
// suites run without accounts: the Stripe API endpoints (point the site at it
// with STRIPE_API_BASE=http://localhost:<port>), Starbase's website API
// (STARBASE_URL=http://localhost:<port>) and Cloudflare Turnstile's siteverify
// (TURNSTILE_VERIFY_URL=http://localhost:<port>/turnstile/siteverify).
//
// Besides the Stripe endpoints it has three test-only ones: GET /__log lists
// every call made to it; POST /__objects (JSON) registers an invoice or
// subscription for the site to retrieve by id, or a refund (as if made from
// the dashboard) for GET /v1/refunds to list; POST /__refunds {"fail":true}
// makes POST /v1/refunds fail like an outage until {"fail":false}.
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import { z } from "zod";

const port = Number(process.env.PORT ?? 12111);
const sessions = new Map();
const objects = new Map();
const refunds = [];
const calls = [];
let n = 0;
let refundsFail = false;

function parseForm(body) {
  const out = {};
  for (const [k, v] of new URLSearchParams(body)) {
    const path = k.replace(/\]/g, "").split("[");
    let o = out;
    path.forEach((p, i) => {
      if (i === path.length - 1) o[p] = v;
      else o = o[p] ??= {};
    });
  }
  return out;
}

// ── Fake Starbase: GET /in/v1/ping, POST /in/v1/people, /in/v1/consent ───
// The same rules as Starbase's server/ext/intake/index.js: a Bearer website
// key, JSON only, the same strict field schema and limits, and
// Idempotency-Key replays (same key + same body → the first answer with
// replayed: true; same key + another body → 409). POST /in/v1/consent (the
// consent withdrawals the website sends) answers 404, as a Starbase without
// the endpoint does, until it is switched on. Test-only endpoints:
// GET /__starbase lists every request; POST /__starbase/fail {status, times,
// path?} answers the next `times` requests (to `path`, if given) with
// `status`; POST /__starbase/key {key} changes the accepted key (as if the
// old one were revoked); POST /__starbase/consent {supported} switches the
// consent endpoint on or off; POST /__starbase/reset clears it all.
// The key the site is given (run.mjs sets STARBASE_KEY for both).
const STARBASE_TEST_KEY = process.env.STARBASE_KEY || "sbk_e2eTestKey0123456789abcdefABCDEF";
const starbaseInitial = () => ({ key: STARBASE_TEST_KEY, requests: [], fail: { status: 0, times: 0, path: null }, idem: new Map(), people: new Map(), consentSupported: false });
const starbase = starbaseInitial();
const str = (max) => z.string().trim().max(max).optional().nullable();
const personIn = z
  .object({
    name: str(300),
    first_name: str(150),
    last_name: str(150),
    email: z.string().trim().toLowerCase().email().max(320).optional().nullable(),
    phone: str(40),
    address: str(1000),
    unit: str(40),
    city: str(120),
    postal: str(20),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    newsletter: z.boolean().optional(),
    volunteer: z.boolean().optional(),
    note: str(2000),
    source: str(80),
  })
  .strict()
  .refine((v) => v.email || v.phone, { message: "an email or a phone" })
  .refine((v) => v.name || v.first_name || v.last_name || v.email, { message: "a name" });
const consentIn = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320).optional(),
    phone: str(40),
    channel: z.enum(["email", "sms"]),
    action: z.literal("withdraw"),
    reason: z.enum(["unsubscribe", "stop", "preference", "deletion"]),
    at: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine((v) => v.email || v.phone, { message: "an email or a phone" });

function fakeStarbase(req, res, url, raw) {
  const send = (status, o) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(o));
    return { status, body: o };
  };
  if (url.pathname === "/__starbase" && req.method === "GET") return send(200, starbase.requests);
  if (url.pathname.startsWith("/__starbase/")) {
    const p = raw ? JSON.parse(raw) : {};
    if (url.pathname === "/__starbase/fail") starbase.fail = { status: Number(p.status) || 0, times: Number(p.times) || 0, path: p.path ? String(p.path) : null };
    if (url.pathname === "/__starbase/key") starbase.key = String(p.key ?? STARBASE_TEST_KEY);
    if (url.pathname === "/__starbase/consent") starbase.consentSupported = p.supported === true;
    if (url.pathname === "/__starbase/reset") Object.assign(starbase, starbaseInitial());
    return send(200, { ok: true });
  }
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {}
  const record = {
    method: req.method,
    path: url.pathname,
    authorization: req.headers.authorization ?? null,
    contentType: req.headers["content-type"] ?? null,
    idempotencyKey: req.headers["idempotency-key"] ?? null,
    raw,
    body,
    at: new Date().toISOString(),
  };
  starbase.requests.push(record);
  const answer = (status, o) => {
    record.status = status;
    record.answer = o;
    return send(status, o);
  };
  if (starbase.fail.times > 0 && (!starbase.fail.path || starbase.fail.path === url.pathname)) {
    starbase.fail.times -= 1;
    return answer(starbase.fail.status, { error: `simulated ${starbase.fail.status}` });
  }
  const m = /^Bearer\s+(sbk_[A-Za-z0-9]{20,})$/.exec(req.headers.authorization || "");
  if (!m || m[1] !== starbase.key) return answer(401, { error: "a valid key goes in the Authorization header: Bearer sbk_…" });
  if (req.method === "GET" && url.pathname === "/in/v1/ping") return answer(200, { ok: true, campaign: "Imagine Surrey (test)", key: "Website" });
  const consent = url.pathname === "/in/v1/consent" && starbase.consentSupported;
  if (req.method !== "POST" || !(url.pathname === "/in/v1/people" || consent)) return answer(404, { error: "not found" });
  if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) return answer(415, { error: "send JSON (Content-Type: application/json)" });
  if (body === null) return answer(400, { error: "the body isn’t JSON" });
  const parsed = (consent ? consentIn : personIn).safeParse(body);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return answer(400, { error: `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}` });
  }
  const idem = String(req.headers["idempotency-key"] ?? "").trim().slice(0, 200);
  const hash = createHash("sha256").update(raw).digest("hex");
  if (idem && starbase.idem.has(idem)) {
    const prev = starbase.idem.get(idem);
    if (prev.hash !== hash) return answer(409, { error: "that Idempotency-Key was used with a different body" });
    return answer(200, { ok: true, ...prev.answer, replayed: true });
  }
  if (consent) {
    if (idem) starbase.idem.set(idem, { hash, answer: {} });
    return answer(200, { ok: true });
  }
  const who = parsed.data.email || `${parsed.data.name ?? ""}|${parsed.data.phone ?? ""}`;
  const personId = starbase.people.get(who) ?? randomUUID();
  starbase.people.set(who, personId);
  if (idem) starbase.idem.set(idem, { hash, answer: { person_id: personId } });
  return answer(200, { ok: true, person_id: personId });
}

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      if (url.pathname.startsWith("/in/v1/") || url.pathname === "/__starbase" || url.pathname.startsWith("/__starbase/")) return void fakeStarbase(req, res, url, body);
      // Fake Cloudflare Turnstile siteverify: only "ok-token" passes.
      if (req.method === "POST" && url.pathname === "/turnstile/siteverify") {
        const form = new URLSearchParams(body);
        const success = Boolean(form.get("secret")) && form.get("response") === "ok-token";
        calls.push({ method: req.method, path: url.pathname, params: { response: form.get("response"), remoteip: form.get("remoteip") } });
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ success, "error-codes": success ? [] : ["invalid-input-response"] }));
      }
      const isJson = (req.headers["content-type"] ?? "").includes("application/json");
      const params = isJson ? (body ? JSON.parse(body) : {}) : parseForm(body);
      calls.push({ method: req.method, path: url.pathname, params, idem: req.headers["idempotency-key"] });
      const send = (o, s = 200) => {
        res.writeHead(s, { "content-type": "application/json" });
        res.end(JSON.stringify(o));
      };
      const notFound = (what) => send({ error: { type: "invalid_request_error", code: "resource_missing", message: `No such ${what}` } }, 404);

      if (url.pathname === "/__log") return send(calls);
      if (req.method === "POST" && url.pathname === "/__objects") {
        objects.set(params.id, params);
        if (params.object === "refund") refunds.push({ status: "succeeded", metadata: {}, ...params });
        return send({ ok: true });
      }
      if (req.method === "POST" && url.pathname === "/__refunds") {
        refundsFail = params.fail === true;
        return send({ ok: true });
      }

      if (req.method === "POST" && url.pathname === "/v1/checkout/sessions") {
        if (params.customer === "cus_missing") {
          return send({ error: { type: "invalid_request_error", code: "resource_missing", param: "customer", message: "No such customer: 'cus_missing'" } }, 400);
        }
        const id = `cs_test_${++n}`;
        const items = Object.values(params.line_items ?? {});
        const amount_total = items.reduce((s, li) => s + Number(li.price_data.unit_amount) * Number(li.quantity), 0);
        const s = { id, object: "checkout.session", url: `https://checkout.stripe.test/${id}`, mode: params.mode, metadata: params.metadata ?? {}, amount_total, status: "open", params };
        sessions.set(id, s);
        return send(s);
      }
      let m = url.pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)$/);
      if (m) {
        const s = sessions.get(m[1]);
        return s ? send({ ...s, status: "complete", payment_status: "paid", payment_intent: `pi_${s.id}` }) : notFound("session");
      }
      m = url.pathname.match(/^\/v1\/(invoices|subscriptions)\/([^/]+)$/);
      if (m) {
        const o = objects.get(m[2]);
        return o ? send(o) : notFound(m[1].slice(0, -1));
      }
      if (req.method === "GET" && url.pathname === "/v1/refunds") {
        const pi = url.searchParams.get("payment_intent");
        return send({ object: "list", has_more: false, data: refunds.filter((r) => !pi || r.payment_intent === pi) });
      }
      if (url.pathname === "/v1/refunds") {
        if (refundsFail) {
          res.writeHead(503, { "content-type": "application/json", "stripe-should-retry": "false" });
          return res.end(JSON.stringify({ error: { type: "api_error", message: "Simulated outage" } }));
        }
        const refund = { id: `re_${++n}`, object: "refund", status: "succeeded", amount: Number(params.amount), payment_intent: params.payment_intent, metadata: params.metadata ?? {} };
        refunds.push(refund);
        return send(refund);
      }
      if (url.pathname === "/v1/invoice_payments") {
        return send({
          object: "list",
          has_more: false,
          data: [{ id: "inpay_1", object: "invoice_payment", status: "paid", payment: { type: "payment_intent", payment_intent: `pi_for_${url.searchParams.get("invoice")}` } }],
        });
      }
      send({ error: { message: `unhandled ${req.method} ${url.pathname}` } }, 404);
    });
  })
  .listen(port, () => console.log(`fake stripe on ${port}`));
