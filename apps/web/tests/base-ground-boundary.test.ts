// What reaches base ground ("the desk"), and from where. Sign-up forms forward
// the person; an RSVP, a paid shop order and a confirmed promise follow
// forward a tag only; a withdrawal (unsubscribe, STOP, preference change,
// deletion) goes to the consent endpoint; a supporter's own portal edit
// forwards their details. Money never does: donations, monthly gifts, fees,
// order totals and items, and gift amounts are logged at the desk by the
// treasurer, where the contribution limits are checked. Admin edits to a
// supporter never do either, and a withdrawal that came from base ground is never
// sent back. This test reads the import graph of each code path and fails if
// one of them can reach the outbox through anything but its own forward.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const src = (p: string) => path.join(root, "src", p);
const rel = (p: string) => path.relative(root, p);

const BASE_GROUND = src("lib/server/base-ground.ts");
const OUTBOX = src("lib/server/base-ground-outbox.ts");
const FORWARD = src("lib/server/base-ground-forward.ts");

type Edge = { target: string; names: string[] | "*" };

function resolve(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = src(spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const candidate = base + ext;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** The value imports (and re-exports) of a file; `import type` doesn't count. */
function edges(file: string): Edge[] {
  const code = readFileSync(file, "utf8");
  const out: Edge[] = [];
  const add = (spec: string, names: string[] | "*") => {
    const target = resolve(file, spec);
    if (target) out.push({ target, names });
  };
  for (const m of code.matchAll(/(?:^|\n)\s*(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g)) {
    if (m[2]) continue;
    const clause = m[3];
    const braces = /\{([\s\S]*)\}/.exec(clause);
    const names = braces
      ? braces[1]
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s && !s.startsWith("type "))
          .map((s) => s.split(/\s+as\s+/)[0])
      : "*";
    if (Array.isArray(names) && names.length === 0 && !/^\s*\w/.test(clause.replace(/\{[\s\S]*\}/, ""))) continue;
    add(m[4], clause.includes("*") || !braces || /^\s*\w+\s*,/.test(clause) ? "*" : names);
  }
  for (const m of code.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) add(m[1], []);
  for (const m of code.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) add(m[1], "*");
  return out;
}

type Allowance = (from: string, edge: Edge) => boolean;

/** The path from `entry` to a base ground module that `allowed` doesn't excuse, or null. */
function reachesBaseGround(entry: string, allowed: Allowance): string[] | null {
  const seen = new Set<string>();
  const stack: string[][] = [[entry]];
  while (stack.length) {
    const trail = stack.pop()!;
    const file = trail[trail.length - 1];
    if (seen.has(file)) continue;
    seen.add(file);
    for (const edge of edges(file)) {
      if (edge.target === BASE_GROUND || edge.target === OUTBOX || edge.target === FORWARD) {
        if (allowed(file, edge)) continue;
        return [...trail, edge.target].map(rel);
      }
      if (!seen.has(edge.target)) stack.push([...trail, edge.target]);
    }
  }
  return null;
}

const only = (names: string[] | "*", allowedNames: string[]) => names !== "*" && names.every((n) => allowedNames.includes(n));

/** The modules that forward something, and the only forwards each may call. */
const FORWARDS: Record<string, string[]> = {
  // A membership that became active (never the fee).
  "lib/server/payments.ts": ["forwardMembership"],
  // ...and, after the webhook commits, the "Bought merch" tag for a paid order.
  "lib/server/webhooks.ts": ["forwardMembership", "forwardOrder"],
  // Engagement tags.
  "app/api/events/[slug]/rsvp/route.ts": ["forwardRsvp"],
  "lib/server/tracker.ts": ["forwardFollow"],
  // Withdrawals, and the supporter's own edits in the portal.
  "lib/server/newsletter.ts": ["forwardConsentWithdrawal"],
  "lib/server/comms.ts": ["forwardConsentWithdrawal"],
  "lib/server/supporters.ts": ["forwardConsentWithdrawal"],
  "app/api/preferences/route.ts": ["forwardConsentWithdrawal"],
  "app/me/(portal)/preferences/actions.ts": ["forwardConsentWithdrawal", "forwardPortalEdit"],
};
const designated: Allowance = (from, edge) => edge.target === FORWARD && only(edge.names, FORWARDS[path.relative(src(""), from)] ?? []);

// Money paths, engagement paths and consent paths: each may reach the outbox
// only through the forwards listed above for the module that calls them.
const DESIGNATED_ONLY = [
  "app/api/donations/checkout/route.ts",
  "app/api/shop/checkout/route.ts",
  "app/api/stripe/webhook/route.ts",
  "app/api/me/billing-portal/route.ts",
  "app/api/events/[slug]/rsvp/route.ts",
  "app/api/tracker/follow/route.ts",
  "app/api/tracker/follow/confirm/route.ts",
  "app/api/preferences/route.ts",
  "app/api/preferences/request/route.ts",
  "app/api/newsletter/unsubscribe/route.ts",
  "app/api/newsletter/unfollow/route.ts",
  "app/api/sms/inbound/route.ts",
  "app/me/(portal)/preferences/actions.ts",
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe("what is forwarded to base ground, and from where", () => {
  it.each(DESIGNATED_ONLY)("%s reaches the outbox only through its own forwards", (file) => {
    const entry = src(file);
    expect(existsSync(entry), `${file} exists`).toBe(true);
    expect(reachesBaseGround(entry, designated)).toBeNull();
  });

  it("nothing in the admin forwards a person; it may only read, deliver, retry or skip", () => {
    // The outbox's own admin functions; never enqueueBaseGround, never a forward*
    // except through the modules above (an anonymized supporter's withdrawal).
    const ADMIN_OUTBOX = ["deliverOutbox", "retryOutboxRow", "skipOutboxRow", "outboxStats", "listOutbox", "outboxForPerson", "parseOutboxFilters", "OUTBOX_KINDS", "OUTBOX_STATUSES", "OUTBOX_PAGE_SIZE"];
    const ADMIN_CLIENT = ["ping", "baseGroundUrlProblem", "NOT_SUPPORTED_YET"];
    const adminAllowed: Allowance = (from, edge) =>
      designated(from, edge) || (edge.target === OUTBOX && only(edge.names, ADMIN_OUTBOX)) || (edge.target === BASE_GROUND && only(edge.names, ADMIN_CLIENT));
    const files = [...walk(src("app/admin")), ...walk(src("app/api/admin")), ...walk(src("components/admin"))];
    expect(files.length).toBeGreaterThan(20);
    const leaks = files.map((f) => reachesBaseGround(f, adminAllowed)).filter(Boolean);
    expect(leaks).toEqual([]);
  });

  it("a withdrawal that came from base ground is never sent back", () => {
    // The inbound endpoint may read base ground's channel and reason names, nothing else.
    const constantsOnly: Allowance = (_from, edge) => edge.target === BASE_GROUND && only(edge.names, ["CONSENT_CHANNELS", "CONSENT_REASONS"]);
    expect(reachesBaseGround(src("app/api/in/consent/route.ts"), constantsOnly)).toBeNull();
  });

  it("the forwards never read money", () => {
    const forward = readFileSync(FORWARD, "utf8");
    // The only tables they read: the membership snapshot, an order's buyer, and the person.
    const schemaImport = /import\s*\{([^}]*)\}\s*from\s*"@\/lib\/db\/schema"/.exec(forward)?.[1] ?? "";
    expect(schemaImport.split(",").map((s) => s.trim()).filter(Boolean).sort()).toEqual(["memberships", "orders", "people"]);
    const orderForward = forward.slice(forward.indexOf("export async function forwardOrder"), forward.indexOf("export async function forwardFollow"));
    expect(orderForward).toMatch(/columns: \{ email: true, personId: true, status: true \}/);
    expect(orderForward).not.toMatch(/cents|amount|total|items|stripe/i);
    const baseGround = readFileSync(BASE_GROUND, "utf8");
    for (const builder of ["rsvpPerson", "orderPerson", "followPerson", "portalPerson", "consentPayload"]) {
      const start = baseGround.indexOf(`export function ${builder}(`);
      expect(start, builder).toBeGreaterThan(0);
      const signature = baseGround.slice(start, baseGround.indexOf("{\n", start));
      expect(signature, builder).not.toMatch(/cents|amount|total|fee|stripe|guests|items/i);
    }
  });

  it("the import check sees a real forward (so the tests above can fail)", () => {
    expect(reachesBaseGround(src("app/api/signatures/route.ts"), designated)).toEqual(["src/app/api/signatures/route.ts", "src/lib/server/base-ground-forward.ts"]);
    expect(reachesBaseGround(src("app/api/volunteer/signup/route.ts"), designated)).not.toBeNull();
    // The webhook may forward memberships and orders, but not with nothing allowed.
    const strict: Allowance = (from, edge) => edge.target === FORWARD && from === src("lib/server/webhooks.ts") && only(edge.names, []);
    expect(reachesBaseGround(src("app/api/stripe/webhook/route.ts"), strict)).not.toBeNull();
    // A module can't borrow another's forward: payments may not tag an order, a route may not forward a membership.
    expect(designated(src("lib/server/payments.ts"), { target: FORWARD, names: ["forwardOrder"] })).toBe(false);
    expect(designated(src("app/api/stripe/webhook/route.ts"), { target: FORWARD, names: ["forwardMembership"] })).toBe(false);
  });
});
