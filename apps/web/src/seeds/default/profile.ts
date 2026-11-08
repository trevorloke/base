import type { ClientProfile } from "../profile-types";

function hostOf(url: string | undefined): string {
  try {
    return url ? new URL(url).hostname : "";
  } catch {
    return "";
  }
}

/** A new client: no particular place, no neighbourhood pages until they are set up in its seed. */
export const profile: ClientProfile = {
  orgName: process.env.BASE_WEB_ORG_NAME || "Our organization",
  email: process.env.BASE_WEB_ORG_EMAIL || "hello@example.org",
  uidDomain: hostOf(process.env.NEXT_PUBLIC_SITE_URL) || "base-web.invalid",
  place: "",
  placeLine: "",
  defaultCity: "",
  fundName: "",
  trackerName: "Promise tracker",
  homeCampaigns: {},
  places: { names: [], slugs: {}, postalAreas: {}, outside: "", campuses: [] },
};
