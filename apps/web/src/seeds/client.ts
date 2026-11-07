// The client this deployment is built for. BASE_WEB_CLIENT is fixed when the
// site is built (next.config.ts passes it to the server and browser code
// alike), so every module can read the client's profile directly. Unset or
// unknown: "default", a clean, neutral site.
import { profile as defaultProfile } from "./default/profile";
import { settings as defaultSettings } from "./default/settings";
import { profile as imagineSurreyProfile } from "./imagine-surrey/profile";
import { settings as imagineSurreySettings } from "./imagine-surrey/settings";
import type { ClientProfile } from "./profile-types";

export type { ClientProfile } from "./profile-types";

export const CLIENT_ID: "imagine-surrey" | "default" = process.env.BASE_WEB_CLIENT === "imagine-surrey" ? "imagine-surrey" : "default";

export const clientProfile: ClientProfile = CLIENT_ID === "imagine-surrey" ? imagineSurreyProfile : defaultProfile;

/** " from around Surrey", or nothing for a client with no particular place. */
export const fromAroundPlace = clientProfile.place ? ` from around ${clientProfile.place}` : "";
/** " in Surrey", or nothing. */
export const inPlace = clientProfile.place ? ` in ${clientProfile.place}` : "";
/** " across Surrey", or nothing. */
export const acrossPlace = clientProfile.place ? ` across ${clientProfile.place}` : "";

/** The client's own Site settings copy, section by section (laid over the neutral defaults). */
export const clientSettings: Record<string, Record<string, unknown>> = CLIENT_ID === "imagine-surrey" ? imagineSurreySettings : defaultSettings;
