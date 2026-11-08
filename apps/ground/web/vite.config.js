import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative: built files resolve against the <base href> the server writes
  // into index.html, so one build serves any client's prefix (SUITE.md,
  // BASE_PATH) — /assets/… at the root (base.win, a laptop), /ground/assets/…
  // under a path.
  base: './',
  server: {
    // The dev server has no prefix: the field app at /field/, the desk at
    // /ground/ (main.jsx sends / and /admin there). The server's own pages —
    // unsubscribe (/u, /bu), ladder unsubscribe (/lu), receipts (/r), public
    // lessons (/learn, /learn-files), email tracking (/o, /c), pictures
    // (/media) and Google tiles (/tiles) — are rendered by Hono, so dev
    // proxies them alongside /api.
    proxy: {
      '/api': 'http://localhost:3200',
      '^/(u|bu|lu|r|o|c|learn|learn-files|media|tiles|in)/': 'http://localhost:3200',
    },
  },
});
