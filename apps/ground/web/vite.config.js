import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
