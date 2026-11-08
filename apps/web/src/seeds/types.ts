import type { Brand, PresetId } from "@/lib/brand";

/**
 * Everything that makes a deployment one client's site rather than another's:
 * its starting look and, as more moves here, its starting copy and content.
 * A deployment picks one with BASE_WEB_CLIENT (src/seeds/index.ts).
 */
export type ClientSeed = {
  id: string;
  label: string;
  /** The look before anything is saved in Admin → Brand. */
  brand: { preset: PresetId } & Partial<Pick<Brand, "name" | "logoUrl" | "logoOnDarkUrl">>;
};
