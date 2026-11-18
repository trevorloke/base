import { defineConfig, build } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The public website's islands (src/site-islands.js) are a second build:
// one self-contained file with a stable name, dist/site-islands.js, that
// the server serves at {site root}site-assets/site-islands.js (SITE.md). It
// carries its own React, so the public site loads nothing of the app's.
// The draft's live preview (src/site-preview.js, WA) is built the same way,
// as dist/site-preview.js, loaded only on preview pages.
const SITE_ENTRIES = ['site-islands', 'site-preview'];
const siteIslands = () => ({
  name: 'site-islands',
  apply: 'build',
  async closeBundle() {
    for (const entry of SITE_ENTRIES) await build({
      configFile: false,
      root: fileURLToPath(new URL('.', import.meta.url)),
      logLevel: 'warn',
      publicDir: false,
      build: {
        outDir: 'dist',
        emptyOutDir: false,
        copyPublicDir: false,
        modulePreload: false,
        target: 'es2020',
        rollupOptions: {
          input: fileURLToPath(new URL(`./src/${entry}.js`, import.meta.url)),
          output: { format: 'es', entryFileNames: `${entry}.js`, inlineDynamicImports: true },
        },
      },
    });
  },
});

export default defineConfig({
  plugins: [react(), siteIslands()],
  // One build for any client's path (base.win/imaginesurrey…, BASE_PATH on
  // the server). The page's own /assets links are put under it by the
  // server (server/lib/mount.js); files a script loads (lazy screens, their
  // CSS) are found from window.__BASE__, which the server writes into the
  // page; a stylesheet's are relative to it. At a site's root __BASE__ is ''
  // and every address is what it always was.
  experimental: {
    renderBuiltUrl(filename, { hostType }) {
      if (hostType === 'js') return { runtime: `(window.__BASE__ || '') + ${JSON.stringify(`/${filename}`)}` };
      if (hostType === 'css') return { relative: true };
      return `/${filename}`;
    },
  },
  server: {
    // The server's own pages — unsubscribe (/u, /bu), ladder unsubscribe
    // (/lu), receipts (/r), public lessons (/learn, /learn-files), email
    // tracking (/o, /c), pictures (/media) and Google tiles (/tiles) — are
    // rendered by Hono, so dev proxies them alongside /api.
    proxy: {
      '/api': 'http://localhost:3200',
      '^/(u|bu|lu|r|o|c|learn|learn-files|media|tiles)/': 'http://localhost:3200',
    },
  },
});
