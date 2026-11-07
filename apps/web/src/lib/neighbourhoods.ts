// Neighbourhoods (Imagine Surrey: the six town centres), the postal-code
// finder and member rules. The places come from the client's profile
// (src/seeds/<client>/profile.ts); a client without any has no neighbourhood
// pages and no neighbourhood field. Pure, usable on server and client.
import { jurisdiction } from "@/lib/jurisdiction";
import { clientProfile } from "@/seeds/client";

const places = clientProfile.places;

export type Neighbourhood = string;
export type NeighbourhoodSlug = string;

export const NEIGHBOURHOODS: readonly string[] = places.names;
/** The choice for people who live elsewhere ("Outside Surrey"), or "" when the place doesn't matter. */
export const OUTSIDE_SURREY: string = places.outside;
export const CAMPUSES: readonly string[] = places.campuses;
/** True when this client has neighbourhoods at all. */
export const HAS_NEIGHBOURHOODS = NEIGHBOURHOODS.length > 0;

export function neighbourhoodForPostalCode(postal: string): string | undefined {
  return places.postalAreas[postal.toUpperCase().replace(/\s+/g, "").slice(0, 3)];
}

/** "v3t1a1" → "V3T 1A1" */
export function normalizePostalCode(postal: string): string {
  const raw = postal.toUpperCase().replace(/\s+/g, "");
  return raw.length === 6 ? `${raw.slice(0, 3)} ${raw.slice(3)}` : raw;
}

export const POSTAL_CODE_RE = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z] ?\d[ABCEGHJ-NPRSTV-Z]\d$/i;
/** Postal codes in the jurisdiction (BC's all start with V). */
export const BC_POSTAL_CODE_RE = jurisdiction.postalCode;

export function ageOn(birthdate: string, today: Date): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthdate);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  let age = today.getFullYear() - y;
  if (today.getMonth() + 1 < mo || (today.getMonth() + 1 === mo && today.getDate() < d)) age -= 1;
  return age;
}

export const MIN_MEMBER_AGE = 14;

// ── Neighbourhood pages ───────────────────────────────────────────────────
// Each neighbourhood has a page at /neighbourhoods/<slug>.

export const NEIGHBOURHOOD_SLUGS: readonly string[] = Object.keys(places.slugs);

export function isNeighbourhood(name: string | null | undefined): name is Neighbourhood {
  return NEIGHBOURHOODS.includes(name ?? "");
}

/** "South Surrey" → "south-surrey"; undefined for anything that is not a neighbourhood. */
export function neighbourhoodSlug(name: string | null | undefined): NeighbourhoodSlug | undefined {
  if (!name) return undefined;
  return Object.entries(places.slugs).find(([, n]) => n.toLowerCase() === name.trim().toLowerCase())?.[0];
}

/** "south-surrey" → "South Surrey"; undefined for an unknown slug. */
export function neighbourhoodFromSlug(slug: string | null | undefined): Neighbourhood | undefined {
  if (!slug) return undefined;
  const key = slug.trim().toLowerCase();
  return Object.hasOwn(places.slugs, key) ? places.slugs[key] : undefined;
}

/** The postal-code areas (first three characters) in each neighbourhood. */
export const NEIGHBOURHOOD_FSAS: Record<Neighbourhood, string[]> = Object.fromEntries(
  NEIGHBOURHOODS.map((name) => [
    name,
    Object.keys(places.postalAreas)
      .filter((fsa) => places.postalAreas[fsa] === name)
      .sort(),
  ]),
);

export function fsasForNeighbourhood(name: string): string[] {
  return isNeighbourhood(name) ? NEIGHBOURHOOD_FSAS[name] : [];
}

/**
 * May this member vote at member meetings? Imagine Surrey's bylaws: only
 * members who live in Surrey. A client with no place restriction: everyone.
 */
export function livesInPlace(neighbourhood: string | null | undefined, city: string): boolean {
  if (!clientProfile.place || !OUTSIDE_SURREY) return true;
  return neighbourhood !== OUTSIDE_SURREY && city.trim().toLowerCase() === clientProfile.place.toLowerCase();
}

/** A zod-friendly tuple of choices; never empty (zod enums need one value). */
export function choices(list: readonly string[], ...extra: string[]): [string, ...string[]] {
  const all = [...list, ...extra];
  return (all.length ? all : [""]) as [string, ...string[]];
}
