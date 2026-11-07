import { defineConfig } from "vitest/config";
import path from "node:path";

// Current time-zone rules (see tzdata/README.md); set before any test runs.
process.env.ICU_TIMEZONE_FILES_DIR ??= path.resolve(import.meta.dirname, "tzdata");

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
