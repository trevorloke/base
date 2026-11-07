import { hasCurrentBcRules } from "@/lib/tz-check";

// Runs once when the server starts.
export function register() {
  if (!hasCurrentBcRules()) {
    console.error(
      "Time-zone rules are out of date: this process puts Vancouver on UTC-8 this winter, but BC is on permanent UTC-7 from November 1, 2026. " +
        "Start the site with `npm start` (which sets ICU_TIMEZONE_FILES_DIR=./tzdata), or set ICU_TIMEZONE_FILES_DIR to the tzdata folder. See tzdata/README.md.",
    );
  }
}
