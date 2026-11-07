export const NEIGHBOURHOODS = ["Newton", "Whalley", "Fleetwood", "Cloverdale", "Guildford", "South Surrey"] as const;
export type Neighbourhood = (typeof NEIGHBOURHOODS)[number];
export const OUTSIDE_SURREY = "Outside Surrey";

export const CAMPUSES = ["Kwantlen Cloverdale", "Kwantlen Newton", "SFU Surrey", "Another campus"] as const;

// Forward sortation areas (first three characters of a postal code) to town centres.
const FSA_TO_NEIGHBOURHOOD: Record<string, (typeof NEIGHBOURHOODS)[number]> = {
  V3T: "Whalley",
  V3V: "Whalley",
  V3R: "Guildford",
  V4N: "Fleetwood",
  V3W: "Newton",
  V3X: "Newton",
  V3S: "Cloverdale",
  V3Z: "South Surrey",
  V4A: "South Surrey",
  V4P: "South Surrey",
};

export function neighbourhoodForPostalCode(postal: string): string | undefined {
  return FSA_TO_NEIGHBOURHOOD[postal.toUpperCase().replace(/\s+/g, "").slice(0, 3)];
}

/** "v3t1a1" → "V3T 1A1" */
export function normalizePostalCode(postal: string): string {
  const raw = postal.toUpperCase().replace(/\s+/g, "");
  return raw.length === 6 ? `${raw.slice(0, 3)} ${raw.slice(3)}` : raw;
}

export const POSTAL_CODE_RE = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z] ?\d[ABCEGHJ-NPRSTV-Z]\d$/i;
// BC postal codes all start with V.
export const BC_POSTAL_CODE_RE = /^V\d[A-Z] ?\d[A-Z]\d$/i;

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
// Each town centre has a page at /neighbourhoods/<slug>.

export const NEIGHBOURHOOD_SLUGS = ["newton", "whalley", "fleetwood", "cloverdale", "guildford", "south-surrey"] as const;
export type NeighbourhoodSlug = (typeof NEIGHBOURHOOD_SLUGS)[number];

const SLUG_TO_NAME: Record<NeighbourhoodSlug, Neighbourhood> = {
  newton: "Newton",
  whalley: "Whalley",
  fleetwood: "Fleetwood",
  cloverdale: "Cloverdale",
  guildford: "Guildford",
  "south-surrey": "South Surrey",
};

export function isNeighbourhood(name: string | null | undefined): name is Neighbourhood {
  return (NEIGHBOURHOODS as readonly string[]).includes(name ?? "");
}

/** "South Surrey" → "south-surrey"; undefined for anything that is not a town centre. */
export function neighbourhoodSlug(name: string | null | undefined): NeighbourhoodSlug | undefined {
  if (!name) return undefined;
  const entry = Object.entries(SLUG_TO_NAME).find(([, n]) => n.toLowerCase() === name.trim().toLowerCase());
  return entry?.[0] as NeighbourhoodSlug | undefined;
}

/** "south-surrey" → "South Surrey"; undefined for an unknown slug. */
export function neighbourhoodFromSlug(slug: string | null | undefined): Neighbourhood | undefined {
  if (!slug) return undefined;
  return SLUG_TO_NAME[slug.trim().toLowerCase() as NeighbourhoodSlug];
}

/** The forward sortation areas (first three postal-code characters) in each town centre. */
export const NEIGHBOURHOOD_FSAS: Record<Neighbourhood, string[]> = NEIGHBOURHOODS.reduce(
  (acc, name) => {
    acc[name] = Object.keys(FSA_TO_NEIGHBOURHOOD)
      .filter((fsa) => FSA_TO_NEIGHBOURHOOD[fsa] === name)
      .sort();
    return acc;
  },
  {} as Record<Neighbourhood, string[]>,
);

export function fsasForNeighbourhood(name: string): string[] {
  return isNeighbourhood(name) ? NEIGHBOURHOOD_FSAS[name] : [];
}
