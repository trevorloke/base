import "server-only";
import { randomBytes } from "node:crypto";
import { eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { people } from "@/lib/db/schema";

type PersonInsert = typeof people.$inferInsert;
export type PersonFields = Partial<Omit<PersonInsert, "id" | "email" | "createdAt" | "updatedAt" | "referralCode" | "referredById" | "stripeCustomerId" | "stripeCustomerMode">>;
export type Person = typeof people.$inferSelect;

// Flags where "yes" from any form should stick.
const OR_FIELDS = new Set<keyof PersonFields>(["student", "interestVolunteer", "interestLawnSign"]);
// Fields public forms never set; the portal and admin use updatePerson for them.
// (A language preference is only filled in when blank, like every other field.)
const PUBLIC_IGNORED = new Set<keyof PersonFields>(["tags"]);

function clean(fields: PersonFields): Partial<PersonInsert> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== "")) as Partial<PersonInsert>;
}

/**
 * The person for an email address, created if new. Used by every public
 * form. Anyone can submit a public form with anyone's email, so an existing
 * person's details are never overwritten: blank fields are filled, "yes"
 * flags are kept once set, and the earliest consent timestamp stands.
 * Authenticated updates (the supporter portal, the admin) use updatePerson.
 */
export async function findOrCreatePerson(db: Db, email: string, fields: PersonFields = {}, options: { source?: string; referredByCode?: string | null } = {}): Promise<Person> {
  const normalized = email.trim().toLowerCase();
  const values = clean(fields);
  for (const key of PUBLIC_IGNORED) delete values[key];
  const insert: PersonInsert = { email: normalized, ...values, source: options.source ?? values.source };

  const set: Record<string, SQL> = { updatedAt: sql`now()` };
  for (const key of Object.keys(values) as (keyof PersonFields)[]) {
    const column = people[key as keyof typeof people] as unknown as { name: string };
    const excluded = sql`excluded.${sql.identifier(column.name)}`;
    const current = sql.identifier(column.name);
    set[key] = OR_FIELDS.has(key) ? sql`${sql.identifier("people")}.${current} or ${excluded}` : sql`coalesce(${sql.identifier("people")}.${current}, ${excluded})`;
  }
  if (options.source) set.source = sql`coalesce(people.source, excluded.source)`;

  const [row] = await db.insert(people).values(insert).onConflictDoUpdate({ target: people.email, set }).returning();

  if (options.referredByCode && !row.referredById) {
    const referrer = await findPersonByReferralCode(db, options.referredByCode);
    if (referrer && referrer.id !== row.id) {
      await db.update(people).set({ referredById: referrer.id }).where(eq(people.id, row.id));
      row.referredById = referrer.id;
    }
  }
  return row;
}

/** @deprecated Use findOrCreatePerson. Kept so older callers keep the safe fill-blank behaviour. */
export const upsertPerson = findOrCreatePerson;

/** Overwrite details. Only for the signed-in supporter's own record or an admin. */
export async function updatePerson(db: Db, id: string, fields: PersonFields): Promise<Person | undefined> {
  const values = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Partial<PersonInsert>;
  const [row] = await db
    .update(people)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(people.id, id))
    .returning();
  return row;
}

export async function findPersonByEmail(db: Db, email: string): Promise<Person | undefined> {
  return db.query.people.findFirst({ where: eq(people.email, email.trim().toLowerCase()) });
}

export async function findPersonByReferralCode(db: Db, code: string): Promise<Person | undefined> {
  const normalized = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{6,12}$/.test(normalized)) return undefined;
  return db.query.people.findFirst({ where: eq(people.referralCode, normalized) });
}

// No 0/O/1/I so codes survive being read aloud or handwritten on a flyer.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** The person's share code, created on first use. */
export async function ensureReferralCode(db: Db, personId: string): Promise<string> {
  const existing = await db.query.people.findFirst({ where: eq(people.id, personId), columns: { referralCode: true } });
  if (existing?.referralCode) return existing.referralCode;
  for (let attempt = 0; attempt < 5; attempt++) {
    const bytes = randomBytes(8);
    const code = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
    try {
      const [row] = await db.update(people).set({ referralCode: code }).where(eq(people.id, personId)).returning({ referralCode: people.referralCode });
      if (row?.referralCode) return row.referralCode;
    } catch (err) {
      if ((err as { code?: string }).code !== "23505") throw err;
    }
  }
  throw new Error("Could not allocate a referral code.");
}
