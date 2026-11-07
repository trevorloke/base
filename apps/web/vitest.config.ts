import { defineConfig } from "vitest/config";
import path from "node:path";

// Current time-zone rules (see tzdata/README.md); set before any test runs.
process.env.ICU_TIMEZONE_FILES_DIR ??= path.resolve(import.meta.dirname, "tzdata");
// The suites describe Imagine Surrey's site; tests/clients.test.ts loads the
// code afresh as a new client's.
process.env.BASE_WEB_CLIENT ??= "imagine-surrey";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
