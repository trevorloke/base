import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
