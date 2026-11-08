// The election-finance and privacy rules the site follows. BC is the default
// and the only one written so far; BASE_WEB_JURISDICTION picks one when there
// are more. Fixed at build time like BASE_WEB_CLIENT (next.config.ts).

export type Jurisdiction = {
  id: string;
  /** "BC" */
  short: string;
  /** "British Columbia" */
  name: string;
  /** Who publishes the contribution limit: "Elections BC". */
  authority: string;
  /** The election-finance law: "LECFA" (Local Elections Campaign Financing Act). */
  financeLaw: string;
  /** The privacy law supporters' data falls under: "BC PIPA". */
  privacyLaw: string;
  /** Postal codes a contributor's address must have (BC's start with V). */
  postalCode: RegExp;
  postalCodeHint: string;
  /** The contribution limit per contributor, per year, in cents, as published. */
  contributionLimits: Record<number, { cents: number; note: string }>;
};

export const JURISDICTIONS: Record<string, Jurisdiction> = {
  bc: {
    id: "bc",
    short: "BC",
    name: "British Columbia",
    authority: "Elections BC",
    financeLaw: "LECFA",
    privacyLaw: "BC PIPA",
    postalCode: /^V\d[A-Z] ?\d[A-Z]\d$/i,
    postalCodeHint: "a BC postal code (starting with V)",
    contributionLimits: { 2026: { cents: 142970, note: "Elections BC, 2026 local elections contribution limit" } },
  },
};

export const jurisdiction: Jurisdiction = JURISDICTIONS[process.env.BASE_WEB_JURISDICTION ?? ""] ?? JURISDICTIONS.bc;
