/**
 * The words and places that make the code read as one client's site: used by
 * pages, forms and emails that have no Site settings at hand, and by the
 * neighbourhood pages and postal-code finder. Safe for the browser.
 */
export type ClientProfile = {
  /** The organization's name where Site settings can't be read (forms, emails, receipts). */
  orgName: string;
  /** The domain in calendar event ids (UIDs); it must never change once calendars hold them. */
  uidDomain: string;
  /** The public email address, for the default sender and Site settings. */
  email: string;
  /** The place the campaign is about ("Surrey"), or "" for no particular place. */
  place: string;
  /** The place with its province, for mailing lines ("Surrey, BC"), or "". */
  placeLine: string;
  /** The default city on forms, or "". */
  defaultCity: string;
  /** What monthly gifts build, or "" (e.g. "Imagine Victory Fund"). */
  fundName: string;
  /** The promise tracker's name. */
  trackerName: string;
  /** The two campaigns built into the home page (its pledge and petition modules), or none. */
  homeCampaigns: { pledge?: string; petition?: string; petitionAsk?: { title: string; body: string }; titles?: Record<string, string> };
  /** Neighbourhood pages, the postal-code finder and the neighbourhood field. Empty: none of these. */
  places: {
    /** The town centres (or wards, or neighbourhoods), in display order. */
    names: string[];
    /** URL slug → name, for /neighbourhoods/<slug>. */
    slugs: Record<string, string>;
    /** Postal-code areas (first three characters) → name. */
    postalAreas: Record<string, string>;
    /** The choice for people who live elsewhere ("Outside Surrey"); "" when the place doesn't matter. */
    outside: string;
    /** Campuses for campus clubs. */
    campuses: string[];
  };
};
