// Shared helpers for the end-to-end suites. Each suite is a plain script that
// prints PASS/FAIL lines and exits non-zero on any failure.
import { randomBytes, scryptSync } from "node:crypto";
import postgres from "postgres";
import Stripe from "stripe";

export const BASE = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.E2E_PORT ?? 3100}`;
export const STRIPE_BASE = process.env.STRIPE_API_BASE ?? `http://localhost:${process.env.E2E_STRIPE_PORT ?? 12111}`;
export const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_localtestsecret";
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@example.com";
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "local-admin-pw";

export const sql = postgres(process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/imagine_surrey_e2e", { max: 2 });

let failures = 0;
export function ok(cond, message) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${message}`);
  if (!cond) failures += 1;
}

export async function finish() {
  await sql.end();
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
}

/** POST JSON to the site from a fresh random IP, so the rate limiter never trips. */
export async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.${rand(250)}.${rand(250)}.${rand(250)}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const rand = (n) => 1 + Math.floor(Math.random() * n);

export async function fakeSession(id) {
  return (await fetch(`${STRIPE_BASE}/v1/checkout/sessions/${id}`)).json();
}

export async function stripeLog() {
  return (await fetch(`${STRIPE_BASE}/__log`)).json();
}

/** Register an invoice or subscription with the fake Stripe so the site can retrieve it by id. */
export async function stripeObject(object) {
  await fetch(`${STRIPE_BASE}/__objects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(object) });
}

const stripe = new Stripe("sk_test_x");
let eventNumber = 0;

/** Deliver a signed Stripe event to the site's webhook. `created` defaults to now (seconds). */
export async function stripeEvent(type, object, { created } = {}) {
  const payload = JSON.stringify({
    id: `evt_${Date.now()}_${++eventNumber}`,
    object: "event",
    type,
    created: created ?? Math.floor(Date.now() / 1000),
    data: { object },
  });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const r = await fetch(BASE + "/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": header, "content-type": "application/json" }, body: payload });
  return { status: r.status, body: await r.json(), payload };
}

export const sessionIdFromUrl = (url) => url.split("/").pop();

/**
 * Make sure the owner account exists with ADMIN_EMAIL and ADMIN_PASSWORD. The
 * site bootstraps it from the same variables; a runner that sets no
 * ADMIN_EMAIL gets one seeded here, in the same scrypt format the site uses.
 */
export async function ensureAdmin() {
  const salt = randomBytes(16);
  const key = scryptSync(ADMIN_PASSWORD, salt, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const hash = `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
  await sql`insert into admin_users (email, name, role, password_hash) values (${ADMIN_EMAIL.toLowerCase()}, 'Owner', 'owner', ${hash}) on conflict (email) do nothing`;
}

/** Sign in to /admin with Playwright (the bootstrap owner from ADMIN_EMAIL/ADMIN_PASSWORD). */
export async function adminLogin(page) {
  await ensureAdmin();
  await page.goto(BASE + "/admin/login");
  await page.fill("#email", ADMIN_EMAIL);
  await page.fill("#password", ADMIN_PASSWORD);
  await page.locator('form[action="/api/admin/login"] button[type=submit]').click();
  await page.waitForURL(/\/admin(?!\/login)/);
}

/** Sign in over HTTP and return the Cookie header value for fetch calls. */
export async function adminCookie() {
  const res = await fetch(BASE + "/api/admin/login", { method: "POST", body: new URLSearchParams({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }), redirect: "manual" });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error(`admin sign-in failed (${res.status})`);
  return cookie;
}
