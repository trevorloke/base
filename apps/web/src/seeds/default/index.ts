import type { ClientSeed } from "../types";

/** A new client's fresh deployment: a clean, neutral site in the Civic look. */
export const client: ClientSeed = {
  id: "default",
  label: "A new client",
  brand: { preset: "civic" },
};
