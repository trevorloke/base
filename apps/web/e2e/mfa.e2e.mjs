// Two-factor sign-in for staff, end to end, against a second server started
// with the requirement on (the other suites run with ADMIN_MFA_REQUIRED=0).
// Codes are computed here from the setup key the account page shows.
//   ADMIN_EMAIL=admin@example.com npm run e2e -- mfa
import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import path from "node:path";
import { chromium } from "playwright";
import { ADMIN_PASSWORD, BASE as MAIN, finish, ok, sql } from "./helpers.mjs";

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL ?? "admin@example.com").toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── A server with two-factor sign-in required ─────────────────────────────
const root = path.resolve(import.meta.dirname, "..");
const port = Number(process.env.E2E_MFA_PORT ?? Number(process.env.E2E_PORT ?? 3100) + 2);
const BASE = `http://localhost:${port}`;
const server = spawn("npx", ["next", "start", "-p", String(port)], {
  cwd: root,
  env: { ...process.env, ADMIN_MFA_REQUIRED: "1", NEXT_PUBLIC_SITE_URL: BASE },
  stdio: ["ignore", "ignore", "inherit"],
  detached: true,
});
const stopServer = () => {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {}
};
process.on("exit", stopServer);
let up = false;
for (const until = Date.now() + 60_000; Date.now() < until && !up; ) {
  try {
    up = (await fetch(BASE + "/admin/login")).status === 200;
  } catch {}
  if (!up) await sleep(500);
}
ok(up, "a second server starts with two-factor sign-in required");

// ── TOTP, computed the way an authenticator app does ──────────────────────
function base32(text) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of text.replace(/\s/g, "").toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
function hotp(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32(secret)).update(msg).digest();
  const o = mac[mac.length - 1] & 15;
  return String((((mac[o] & 127) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3]) % 1e6).padStart(6, "0");
}
const stepNow = () => Math.floor(Date.now() / 30_000);
const lastStep = new Map();
/** A code the site hasn't seen yet: now or the next step (both inside its window), else wait for time to move on. */
async function freshCode(secret) {
  for (;;) {
    const now = stepNow();
    for (const s of [now, now + 1]) {
      if (s > (lastStep.get(secret) ?? -1)) {
        lastStep.set(secret, s);
        return hotp(secret, s);
      }
    }
    await sleep(1000);
  }
}
/** The code from a step already used (a replay). */
const usedCode = (secret) => hotp(secret, lastStep.get(secret));
/** A six-digit code that matches no step near now. */
function wrongCode(secret) {
  const near = new Set([-2, -1, 0, 1, 2, 3].map((d) => hotp(secret, stepNow() + d)));
  for (let n = 123456; ; n = (n + 7919) % 1e6) {
    const c = String(n).padStart(6, "0");
    if (!near.has(c)) return c;
  }
}

// ── HTTP helpers that keep cookies ────────────────────────────────────────
function cookiesOf(res) {
  const out = {};
  for (const c of res.headers.getSetCookie()) {
    const [pair, ...attrs] = c.split(";");
    const i = pair.indexOf("=");
    const deleted = attrs.some((a) => /max-age=0\b/i.test(a.trim())) || pair.slice(i + 1) === "";
    out[pair.slice(0, i)] = deleted ? null : pair.slice(i + 1);
  }
  return out;
}
const ip = () => `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function password(email, pw, base = BASE) {
  const res = await fetch(base + "/api/admin/login", { method: "POST", body: new URLSearchParams({ email, password: pw }), redirect: "manual", headers: { "x-forwarded-for": ip() } });
  const c = cookiesOf(res);
  return { status: res.status, location: res.headers.get("location") ?? "", session: c.is_admin_session, pending: c.is_admin_mfa };
}
async function verify(pending, code) {
  const res = await fetch(BASE + "/api/admin/login/verify", { method: "POST", body: new URLSearchParams({ code }), redirect: "manual", headers: { cookie: `is_admin_mfa=${pending}`, "x-forwarded-for": ip() } });
  const c = cookiesOf(res);
  return { status: res.status, location: res.headers.get("location") ?? "", session: c.is_admin_session, pending: c.is_admin_mfa };
}
async function get(path, session, base = BASE) {
  const res = await fetch(base + path, { headers: session ? { cookie: `is_admin_session=${session}` } : {}, redirect: "manual" });
  return { status: res.status, location: res.headers.get("location") ?? "", text: (await res.text()).replace(/<!--.*?-->/g, "") };
}

const browser = await chromium.launch();
async function newPage() {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });
  page.on("dialog", (d) => d.accept());
  return page;
}
async function browserSignIn(page, email, pw) {
  await page.goto(BASE + "/admin/login");
  await page.fill("#email", email);
  await page.fill("#password", pw);
  await page.click('form[action="/api/admin/login"] button[type=submit]');
  await page.waitForURL(/\/admin(?!\/login)/);
}
/** On My account: start the set-up, read the key, confirm with a code. Returns the key and the recovery codes. */
async function enrol(page) {
  await page.click('button:has-text("Set up two-factor sign-in")');
  await page.locator("#totp-secret").waitFor();
  const secret = await page.locator("#totp-secret").getAttribute("data-secret");
  await page.fill("#confirm-code", await freshCode(secret));
  await page.click('button:has-text("Turn on two-factor sign-in")');
  await page.locator("#recovery-codes li").first().waitFor();
  const codes = await page.locator("#recovery-codes li").allTextContents();
  return { secret, codes };
}

// ── The switch: the main server (ADMIN_MFA_REQUIRED=0 under the runner) ────
let r = await password(ADMIN_EMAIL, ADMIN_PASSWORD, MAIN);
ok(r.status === 303 && r.session && (await get("/admin", r.session, MAIN)).status === 200, "with ADMIN_MFA_REQUIRED=0 under the e2e runner, the owner isn't asked to enrol");

// ── An owner is forced to enrol ───────────────────────────────────────────
r = await password(ADMIN_EMAIL, ADMIN_PASSWORD);
ok(r.status === 303 && Boolean(r.session) && !r.pending, "without two-factor set up, the password alone gives a session");
const unenrolled = r.session;
let p = await get("/admin", unenrolled);
ok([303, 307].includes(p.status) && p.location.includes("/admin/account?enrol=required"), `the dashboard sends an owner without two-factor sign-in to My account (${p.status} ${p.location})`);
p = await get("/admin/people", unenrolled);
ok(p.location.includes("/admin/account?enrol=required"), "so does every other admin page");
p = await get("/admin/users", unenrolled);
ok(p.location.includes("/admin/account?enrol=required"), "including Staff");
ok((await fetch(BASE + "/api/admin/export/people", { headers: { cookie: `is_admin_session=${unenrolled}` } })).status === 401, "admin API routes refuse them too");
p = await get("/admin/account", unenrolled);
ok(p.status === 200 && p.text.includes("Set up two-factor sign-in to continue") && p.text.includes("Two-factor sign-in"), "My account opens, with a banner saying why");
ok(!p.text.includes('href="/admin/people"') && !p.text.includes("Change password"), "only the set-up is offered: no other admin links, no other account forms");
ok(p.text.includes('action="/api/admin/logout"'), "sign-out stays available");

// ── Enrolment works ───────────────────────────────────────────────────────
const owner = await newPage();
await browserSignIn(owner, ADMIN_EMAIL, ADMIN_PASSWORD);
ok(owner.url().includes("/admin/account?enrol=required"), "signing in lands on the enrolment page");
await owner.click('button:has-text("Set up two-factor sign-in")');
await owner.locator("#totp-secret").waitFor();
const secret = await owner.locator("#totp-secret").getAttribute("data-secret");
const grouped = (await owner.locator("#totp-secret").textContent()).trim();
ok(/^[A-Z2-7]{32}$/.test(secret ?? "") && grouped === secret.replace(/(.{4})(?=.)/g, "$1 "), "the setup key is shown in groups of four");
ok((await owner.locator('svg[aria-label*="QR code"] path').count()) === 1, "with a QR code to scan");
ok((await owner.locator('button:has-text("Copy")').count()) >= 1, "and a copy button");
let row = (await sql`select totp_secret, totp_enabled_at from admin_users where email = ${ADMIN_EMAIL}`)[0];
ok(row.totp_secret?.startsWith("v1.") && !row.totp_secret.includes(secret) && row.totp_enabled_at === null, "the pending key is stored encrypted, not yet switched on");
await owner.fill("#confirm-code", wrongCode(secret));
await owner.click('button:has-text("Turn on two-factor sign-in")');
await owner.locator('[role="alert"]', { hasText: "highlighted" }).waitFor();
ok((await sql`select totp_enabled_at from admin_users where email = ${ADMIN_EMAIL}`)[0].totp_enabled_at === null, "a wrong code doesn't switch it on");
await owner.fill("#confirm-code", await freshCode(secret));
await owner.click('button:has-text("Turn on two-factor sign-in")');
await owner.locator("#recovery-codes li").first().waitFor();
const recovery = await owner.locator("#recovery-codes li").allTextContents();
ok(recovery.length === 10 && new Set(recovery).size === 10 && recovery.every((c) => /^[a-z2-9]{5}-[a-z2-9]{5}$/.test(c)), "ten recovery codes are shown once");
row = (await sql`select totp_enabled_at, recovery_codes from admin_users where email = ${ADMIN_EMAIL}`)[0];
const sha = (c) => createHash("sha256").update(c.replace(/[^a-z0-9]/gi, "").toLowerCase()).digest("hex");
ok(row.totp_enabled_at !== null && row.recovery_codes.length === 10 && recovery.every((c) => row.recovery_codes.includes(sha(c)) && !row.recovery_codes.includes(c)), "two-factor is on, and only sha256 hashes of the recovery codes are stored");
await owner.click('a:has-text("I\'ve saved them")');
await owner.waitForURL(BASE + "/admin");
ok((await owner.locator("h1").first().textContent()).length > 0 && !owner.url().includes("account"), "after enrolling, the dashboard opens");
ok((await get("/admin", unenrolled)).status === 200, "and the earlier session is let in too");
ok((await sql`select count(*)::int c from audit_log where action = 'account.2fa.enable' and user_email = ${ADMIN_EMAIL}`)[0].c === 1, "enrolment is audited");

// ── Sign-in needs the code ────────────────────────────────────────────────
await sql`delete from login_attempts`;
r = await password(ADMIN_EMAIL, ADMIN_PASSWORD);
ok(r.status === 303 && r.location === "/admin/login/verify" && Boolean(r.pending) && !r.session, "a correct password now leads to the code step, with no session yet");
ok((await get("/admin/login/verify")).location.includes("/admin/login"), "the code step needs the pending sign-in");
p = await fetch(BASE + "/admin/login/verify", { headers: { cookie: `is_admin_mfa=${r.pending}` } });
const verifyHtml = await p.text();
ok(p.status === 200 && verifyHtml.includes('name="code"') && verifyHtml.includes('action="/api/admin/login/verify"'), "the code step asks for the code");
const token = (await sql`select purpose, expires_at, used_at from auth_tokens where purpose = 'admin-mfa' and used_at is null order by created_at desc limit 1`)[0];
ok(token && Math.abs(new Date(token.expires_at).getTime() - Date.now() - 10 * 60_000) < 60_000, "the pending sign-in is an admin-mfa token that lasts 10 minutes");

// ── A wrong code fails ────────────────────────────────────────────────────
let v = await verify(r.pending, wrongCode(secret));
ok(v.status === 303 && v.location === "/admin/login/verify?error=code" && !v.session && Boolean(v.pending), "a wrong code is refused, with a fresh pending token to try again");
const retried = await verify(r.pending, await freshCode(secret));
ok(retried.location.includes("/admin/login?error=expired") && !retried.session, "each pending token works once, even with a right code");
lastStep.set(secret, lastStep.get(secret) - 1); // that code was never accepted, so it's still fresh
v = await verify(v.pending, await freshCode(secret));
ok(v.status === 303 && v.location === "/admin" && Boolean(v.session), "the right code signs in");
ok((await get("/admin", v.session)).status === 200, "and the session opens the admin");
let audit = await sql`select details from audit_log where action = 'signin' and user_email = ${ADMIN_EMAIL} order by at desc limit 1`;
ok(audit[0]?.details?.method === "password+totp", "the sign-in is audited as password+totp");
let failures = (await sql`select count(*)::int c from login_attempts where key = ${"email:" + ADMIN_EMAIL} and not success`)[0].c;
ok(failures === 1, `the wrong code counted toward the sign-in lockout (${failures})`);

// The same code can't be used twice.
r = await password(ADMIN_EMAIL, ADMIN_PASSWORD);
v = await verify(r.pending, usedCode(secret));
ok(v.location === "/admin/login/verify?error=code" && !v.session, "a code that was already used is refused (no replay)");
v = await verify(v.pending, await freshCode(secret));
ok(Boolean(v.session), "the next code works");

// ── A recovery code works once ────────────────────────────────────────────
await sql`delete from login_attempts`;
r = await password(ADMIN_EMAIL, ADMIN_PASSWORD);
v = await verify(r.pending, ` ${recovery[0].toUpperCase()} `);
ok(v.location === "/admin" && Boolean(v.session), "a recovery code signs in instead of an app code (case and spaces don't matter)");
audit = await sql`select details from audit_log where action = 'signin' and user_email = ${ADMIN_EMAIL} order by at desc limit 1`;
ok(audit[0]?.details?.method === "password+recovery-code", "audited as password+recovery-code");
row = (await sql`select recovery_codes from admin_users where email = ${ADMIN_EMAIL}`)[0];
ok(row.recovery_codes.length === 9 && !row.recovery_codes.includes(sha(recovery[0])), "the recovery code is used up");
r = await password(ADMIN_EMAIL, ADMIN_PASSWORD);
v = await verify(r.pending, recovery[0]);
ok(v.location === "/admin/login/verify?error=code" && !v.session, "the same recovery code doesn't work twice");

// ── An email link is a first step too ─────────────────────────────────────
const raw = `e2e-mfa-link-${Date.now()}`;
await sql`insert into auth_tokens (purpose, email, token_hash, data, expires_at) values ('admin-login', ${ADMIN_EMAIL}, ${createHash("sha256").update(raw).digest("hex")}, ${sql.json({ next: "/admin/users" })}, now() + interval '20 minutes')`;
let res = await fetch(`${BASE}/api/admin/magic-link?token=${raw}`, { redirect: "manual" });
let c = cookiesOf(res);
ok(res.headers.get("location") === "/admin/login/verify" && Boolean(c.is_admin_mfa) && !c.is_admin_session, "a sign-in link leads to the code step, not a session");
v = await verify(c.is_admin_mfa, await freshCode(secret));
ok(v.location === "/admin/users" && Boolean(v.session), "and the code finishes it, keeping where the link was going");
audit = await sql`select details from audit_log where action = 'signin' and user_email = ${ADMIN_EMAIL} order by at desc limit 1`;
ok(audit[0]?.details?.method === "email-link+totp", "audited as email-link+totp");

// ── Wrong codes lock the account like wrong passwords ─────────────────────
await sql`delete from login_attempts`;
r = await password(ADMIN_EMAIL, ADMIN_PASSWORD);
let pending = r.pending;
for (let i = 1; i <= 4; i++) {
  v = await verify(pending, wrongCode(secret));
  pending = v.pending;
}
ok(v.location === "/admin/login/verify?error=code", "four wrong codes: still asked for a code");
v = await verify(pending, wrongCode(secret));
ok(v.location === "/admin/login?error=locked" && !v.session && v.pending === null, "the fifth locks the sign-in and ends the pending step");
r = await password(ADMIN_EMAIL, ADMIN_PASSWORD);
ok(r.location.includes("error=locked"), "and the password is refused for now too");
await sql`delete from login_attempts`;

// ── New recovery codes, and turning it off, from My account ───────────────
// The browser's session from before enrolment is still good (a lockout doesn't sign anyone out).
await owner.goto(BASE + "/admin/account");
ok((await owner.locator("text=unused recovery code").count()) === 1 && (await owner.locator("#twofactor-title").count()) === 1, "My account shows two-factor sign-in is on, with the recovery codes left");
await owner.fill("#regen-code", await freshCode(secret));
await owner.click('button:has-text("New recovery codes")');
await owner.locator("#recovery-codes li").first().waitFor();
const recovery2 = await owner.locator("#recovery-codes li").allTextContents();
row = (await sql`select recovery_codes from admin_users where email = ${ADMIN_EMAIL}`)[0];
ok(recovery2.length === 10 && recovery2.every((x) => row.recovery_codes.includes(sha(x))) && !row.recovery_codes.includes(sha(recovery[1])), "new recovery codes replace the old ones");

// ── An owner resets another user ──────────────────────────────────────────
await owner.goto(BASE + "/admin/users");
await owner.fill("#invite-name", "Ada Admin");
await owner.fill("#invite-email", "ada@mfa.example");
await owner.selectOption("#invite-role", "admin");
await owner.click('button:has-text("Create account")');
const adaPw = (await owner.locator('[role="status"]', { hasText: "Account created" }).textContent()).match(/one-time password is (\S+) —/)?.[1];
await owner.fill("#invite-name", "Olu Organizer");
await owner.fill("#invite-email", "olu@mfa.example");
await owner.selectOption("#invite-role", "organizer");
await owner.click('button:has-text("Create account")');
const oluPw = (await owner.locator('[role="status"]', { hasText: "Account created for Olu" }).textContent()).match(/one-time password is (\S+) —/)?.[1];
r = await password("olu@mfa.example", oluPw ?? "");
ok(r.session && (await get("/admin", r.session)).status === 200, "an organizer isn't forced to enrol");
r = await password("ada@mfa.example", adaPw ?? "");
ok(r.session && (await get("/admin", r.session)).location.includes("enrol=required"), "an administrator is");
const ada = await newPage();
await browserSignIn(ada, "ada@mfa.example", adaPw);
const adaSetup = await enrol(ada);
ok(adaSetup.codes.length === 10, "the administrator enrols");
r = await password("ada@mfa.example", adaPw);
v = await verify(r.pending, await freshCode(adaSetup.secret));
const adaSession = v.session;
ok(adaSession && (await get("/admin", adaSession)).status === 200, "and signs in with a code");

await owner.goto(BASE + "/admin/users");
const adaRow = owner.locator(".staff", { hasText: "ada@mfa.example" });
ok((await adaRow.textContent()).includes("two-factor sign-in on"), "Staff shows who has two-factor sign-in on");
ok((await owner.locator(".staff", { hasText: ADMIN_EMAIL }).locator('button:has-text("Reset two-factor")').count()) === 0, "an owner has no reset button for their own two-factor");
await adaRow.locator('button:has-text("Reset two-factor")').click();
await adaRow.locator('[role="status"]', { hasText: "Two-factor sign-in was reset" }).waitFor();
row = (await sql`select totp_secret, totp_enabled_at, recovery_codes from admin_users where email = 'ada@mfa.example'`)[0];
ok(row.totp_secret === null && row.totp_enabled_at === null && row.recovery_codes.length === 0, "the reset clears the key and the recovery codes");
ok((await get("/admin", adaSession)).status !== 200 && (await sql`select count(*)::int c from admin_sessions s join admin_users u on u.id = s.user_id where u.email = 'ada@mfa.example' and s.revoked_at is null`)[0].c === 0, "and signs them out everywhere");
ok((await sql`select count(*)::int c from audit_log where action = 'staff.reset-2fa'`)[0].c === 1, "the reset is audited");
r = await password("ada@mfa.example", adaPw);
ok(r.session && !r.pending && (await get("/admin", r.session)).location.includes("enrol=required"), "they sign in with the password and must enrol again");

// ── Turning it off with a code ────────────────────────────────────────────
await owner.goto(BASE + "/admin/account");
await owner.fill("#disable-code", wrongCode(secret));
await owner.click('button:has-text("Turn off two-factor sign-in")');
await owner.locator('[role="alert"]', { hasText: "highlighted" }).waitFor();
ok((await sql`select totp_enabled_at from admin_users where email = ${ADMIN_EMAIL}`)[0].totp_enabled_at !== null, "a wrong code doesn't turn it off");
await owner.fill("#disable-code", recovery2[0]);
await owner.click('button:has-text("Turn off two-factor sign-in")');
// An owner must use it, so the page goes straight back to the set-up.
await owner.locator('[role="alert"]', { hasText: "Set up two-factor sign-in to continue" }).waitFor();
row = (await sql`select totp_secret, totp_enabled_at from admin_users where email = ${ADMIN_EMAIL}`)[0];
ok(row.totp_secret === null && row.totp_enabled_at === null, "a current code (here a recovery code) turns it off");
ok((await owner.locator('button:has-text("Set up two-factor sign-in")').count()) === 1, "and an owner is asked to set it up again straight away");
ok((await sql`select details from audit_log where action = 'account.2fa.disable'`)[0]?.details?.with === "recovery code", "turning it off is audited");

// ── On a phone ────────────────────────────────────────────────────────────
const mobile = await (await browser.newContext({ viewport: { width: 360, height: 800 } })).newPage();
await browserSignIn(mobile, "ada@mfa.example", adaPw);
await mobile.click('button:has-text("Set up two-factor sign-in")');
await mobile.locator("#totp-secret").waitFor();
const width = await mobile.evaluate(() => document.documentElement.scrollWidth);
ok(width <= 360, `the set-up page has no sideways scroll on a phone (${width}px)`);

await browser.close();
stopServer();
await finish();
