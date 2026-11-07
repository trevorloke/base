import "server-only";
import { eq } from "drizzle-orm";
import { getDb, type Db } from "@/lib/db";
import { siteSettings } from "@/lib/db/schema";
import { defaultSettings, parseSection, SECTION_KEYS, type SectionKey, type SectionValue, type Settings } from "@/lib/settings";
import { cached, invalidate, TAGS } from "./cache";

/**
 * All site settings, cached. Database rows override the code defaults; a row
 * that no longer matches its schema is ignored (and logged) rather than
 * taking the site down.
 */
export const getSettings = cached("site-settings", [TAGS.settings], async (): Promise<Settings> => {
  const settings = defaultSettings();
  const rows = await getDb().select().from(siteSettings);
  for (const row of rows) {
    const key = row.key as SectionKey;
    if (!SECTION_KEYS.includes(key)) continue;
    try {
      (settings as Record<string, unknown>)[key] = parseSection(key, row.value);
    } catch (err) {
      console.error(`site_settings.${key} is invalid and was ignored`, err);
    }
  }
  return settings;
});

/** Validate and store one section, then refresh the public site. Call from a server action. */
export async function saveSection<K extends SectionKey>(db: Db, key: K, value: unknown, userId: string | null): Promise<SectionValue<K>> {
  const parsed = parseSection(key, value);
  await db
    .insert(siteSettings)
    .values({ key, value: parsed, updatedById: userId })
    .onConflictDoUpdate({ target: siteSettings.key, set: { value: parsed, updatedById: userId, updatedAt: new Date() } });
  invalidate(TAGS.settings);
  return parsed;
}

/** Remove the override so the section goes back to the code default. */
export async function resetSection(db: Db, key: SectionKey): Promise<void> {
  await db.delete(siteSettings).where(eq(siteSettings.key, key));
  invalidate(TAGS.settings);
}
