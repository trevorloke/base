import "server-only";
import { getDb, type Db } from "@/lib/db";
import { siteBrand } from "@/lib/db/schema";
import { brandFromPreset, brandSchema, isPresetId, type Brand } from "@/lib/brand";
import { env } from "@/lib/env";
import { clientFor } from "@/seeds";
import { cached, invalidate, TAGS } from "./cache";
import { buildingWithoutDatabase } from "./render-time";

/**
 * The look before anything is saved in Admin → Brand: the client's seed
 * (BASE_WEB_CLIENT), with its colours, font and corners from
 * BASE_WEB_BRAND_PRESET when that names a preset.
 */
export function defaultBrand(clientId = env.client, presetSetting = env.brandPreset): Brand {
  const seed = clientFor(clientId).brand;
  if (presetSetting && !isPresetId(presetSetting)) console.error(`BASE_WEB_BRAND_PRESET="${presetSetting}" isn't a preset; using the client's.`);
  return brandFromPreset(isPresetId(presetSetting) ? presetSetting : seed.preset, { name: seed.name, logoUrl: seed.logoUrl, logoOnDarkUrl: seed.logoOnDarkUrl });
}

/** A stored brand, or null when there is none or it no longer fits the schema (logged). */
export function parseStoredBrand(value: unknown): Brand | null {
  const parsed = brandSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  console.error("site_brand holds a brand that no longer fits; using the default look", parsed.error.issues);
  return null;
}

/** The saved brand, else the default. Cached; dropped when the brand is saved. */
export const getBrand = cached("site-brand", [TAGS.brand], async (): Promise<Brand> => {
  const [row] = await getDb().select({ value: siteBrand.value }).from(siteBrand).limit(1);
  return (row && parseStoredBrand(row.value)) || defaultBrand();
});

/** For the page shell: a database outage (or a build without one) falls back to the default look. */
export async function shellBrand(): Promise<Brand> {
  try {
    return await getBrand();
  } catch (err) {
    if (!buildingWithoutDatabase()) console.error("The brand could not be loaded; using the default look", err);
    return defaultBrand();
  }
}

/** Store the brand and refresh every public page. Call from a server action. */
export async function saveBrand(db: Db, brand: Brand, userId: string | null): Promise<void> {
  await db
    .insert(siteBrand)
    .values({ id: 1, value: brand, updatedById: userId })
    .onConflictDoUpdate({ target: siteBrand.id, set: { value: brand, updatedById: userId, updatedAt: new Date() } });
  invalidate(TAGS.brand);
}
