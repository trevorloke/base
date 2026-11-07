import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { pageViews } from "@/lib/db/schema";
import { cleanPath, isBotUserAgent, isUntrackedPath, referrerHost } from "@/lib/visits";
import { cleanRef, cleanSource } from "./attribution";

// The first-party visit counter. Each page view is one `page_views` row: the
// Pacific day, the path without its query string, the referring site's
// hostname, the ?source / ?ref the site already tracks for attribution, and a
// visitor hash. The hash is sha256(day salt + IP + user agent), cut short; the
// salt is random, changes every Pacific day and is deleted after a day, so a
// hash can't be traced back to an IP address and the same person counts as a
// new visitor each day. The IP address and user agent are never stored, and
// nothing is written to the visitor's browser.

/** Hex characters kept from the sha256: 128 bits, plenty to tell a day's visitors apart. */
export const VISITOR_HASH_LENGTH = 32;

/** Page views are kept this long, then deleted by the daily cron job. */
export const RETENTION_MONTHS = 13;

/** The visitor hash for one day: never stored with, or derivable back to, the IP or user agent. */
export function hashVisitor(salt: string, ip: string, userAgent: string): string {
  return createHash("sha256").update(`${salt}\n${ip}\n${userAgent}`).digest("hex").slice(0, VISITOR_HASH_LENGTH);
}

// The Pacific calendar day, worked out by the database: the dashboard counts
// weeks with the same clock and time-zone rules, so a view filed just after
// midnight is never counted in a different day (or week) than it was stored.
const PACIFIC_DAY = sql`(now() at time zone 'America/Vancouver')::date`;

/** Today's Pacific date (YYYY-MM-DD), by the database's clock. */
export async function visitDay(db: Db): Promise<string> {
  const [row] = (await db.execute(sql`select ${PACIFIC_DAY}::text as day`)) as unknown as { day: string }[];
  return row.day;
}

/**
 * Remembers the current day's salt in memory so a page view costs one insert,
 * not a salt lookup too. When the Pacific day changes it asks `load` again.
 */
export function saltStore(load: (day: string) => Promise<string>) {
  let current: { day: string; salt: Promise<string> } | null = null;
  return {
    get(day: string): Promise<string> {
      if (current?.day !== day) {
        const salt = load(day);
        current = { day, salt };
        // A failed load is retried on the next page view instead of being cached.
        salt.catch(() => {
          if (current?.salt === salt) current = null;
        });
      }
      return current.salt;
    },
  };
}

/**
 * The salt for a day: created (32 random bytes) if missing, the same one for
 * every server instance. Salts older than a day are deleted at the same time,
 * so yesterday's hashes can't be recomputed for long.
 */
export async function loadDaySalt(db: Db, day: string): Promise<string> {
  const fresh = randomBytes(32).toString("hex");
  await db.execute(sql`insert into visit_salts (day, salt) values (${day}::date, ${fresh}) on conflict (day) do nothing`);
  await db.execute(sql`delete from visit_salts where day < ${day}::date - 1`);
  const [row] = (await db.execute(sql`select salt from visit_salts where day = ${day}::date`)) as unknown as { salt: string }[];
  if (!row) throw new Error(`No visit salt for ${day}`);
  return row.salt;
}

const salts = new WeakMap<Db, ReturnType<typeof saltStore>>();
function saltFor(db: Db, day: string): Promise<string> {
  let store = salts.get(db);
  if (!store) {
    store = saltStore((d) => loadDaySalt(db, d));
    salts.set(db, store);
  }
  return store.get(day);
}

export type PageViewInput = {
  path: unknown;
  referrer: unknown;
  source: unknown;
  ref: unknown;
  /** Used for the hash only; never stored. */
  ip: string;
  /** Used for the bot check and the hash only; never stored. */
  userAgent: string;
  /** This site's hostnames: a referrer from one of them is stored as none. */
  ownHosts: string[];
};

/** The row a page view would be stored as, or null when it isn't counted. Pure apart from the salt. */
export function pageViewRow(input: PageViewInput, salt: string, day: string) {
  if (isBotUserAgent(input.userAgent)) return null;
  const path = cleanPath(input.path);
  if (!path || isUntrackedPath(path)) return null;
  return {
    day,
    path,
    referrerHost: referrerHost(input.referrer, input.ownHosts),
    source: cleanSource(input.source),
    ref: cleanRef(input.ref),
    visitorHash: hashVisitor(salt, input.ip, input.userAgent),
  };
}

/** Store one page view. Returns false when it was skipped (a bot, an admin or portal path, a bad path). */
export async function recordPageView(db: Db, input: PageViewInput): Promise<boolean> {
  if (isBotUserAgent(input.userAgent)) return false;
  const path = cleanPath(input.path);
  if (!path || isUntrackedPath(path)) return false;
  const day = await visitDay(db);
  const row = pageViewRow(input, await saltFor(db, day), day);
  if (!row) return false;
  await db.insert(pageViews).values(row);
  return true;
}

/** Delete page views older than RETENTION_MONTHS and salts older than a day. Run daily from the cron job. */
export async function pruneVisits(db: Db): Promise<{ deleted: number }> {
  const [row] = (await db.execute(sql`
    with gone as (delete from page_views where day < (${PACIFIC_DAY} - make_interval(months => ${RETENTION_MONTHS}::int))::date returning 1)
    select count(*)::int as n from gone
  `)) as unknown as { n: number }[];
  await db.execute(sql`delete from visit_salts where day < ${PACIFIC_DAY} - 1`);
  return { deleted: Number(row?.n ?? 0) };
}
