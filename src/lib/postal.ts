// Postal-code formatting for inputs. Pure, usable on server and client.
import { neighbourhoodForPostalCode } from "./neighbourhoods";

/**
 * Format what someone is typing into a postal-code field: upper-case, strip
 * anything that isn't a letter or digit, and insert the space after the
 * third character ("v3s1a1" → "V3S 1A1"). Never longer than 7 characters.
 */
export function formatPostalCodeInput(value: string): string {
  const raw = value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  return raw.length > 3 ? `${raw.slice(0, 3)} ${raw.slice(3)}` : raw;
}

/** True once the field holds a complete Canadian postal code. */
export function isCompletePostalCode(value: string): boolean {
  return /^[A-Z]\d[A-Z] \d[A-Z]\d$/.test(formatPostalCodeInput(value));
}

/** "That’s Newton" once the first three characters map to a town centre; otherwise nothing. */
export function postalCodePreview(value: string): string | null {
  const raw = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (raw.length < 3) return null;
  const hood = neighbourhoodForPostalCode(raw);
  return hood ? `That’s ${hood}` : null;
}
