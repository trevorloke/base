/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the API. Empty (default) means same origin, so the Vite proxy forwards /v1 and /api. */
  readonly VITE_API_URL?: string;
  /** "1" serves fixture data from src/dev/fixtures.ts instead of calling the API. */
  readonly VITE_USE_FIXTURES?: string;
}
