import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API runs on :4000 in dev. The web app talks to "" (same origin) by default,
// so these proxies forward /v1 and /api — including the SSE stream — to the API.
const API = "http://localhost:4000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/v1": { target: API, changeOrigin: true },
      "/api": { target: API, changeOrigin: true },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      "/v1": { target: API, changeOrigin: true },
      "/api": { target: API, changeOrigin: true },
    },
  },
  build: { target: "es2022", sourcemap: false },
});
