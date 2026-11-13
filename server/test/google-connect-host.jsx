// A stand-in feature screen for e2e-google-signin.mjs: GoogleConnect on its
// own, the way Gmail, Drive or Calendar will put it on theirs, so the suite
// drives the real component (Connect, Connected as, Disconnect, Reconnect,
// paused, not set up, and what ?google= says on return). Built by the
// suite into a scratch folder and served by google-e2e-server.js at
// /admin/e2e-google-connect (and /e2e-google-connect for the field app).
// Test-only: never part of the web build.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../../web/src/app.css';
import GoogleConnect from '../../web/src/components/GoogleConnect.jsx';

const q = new URLSearchParams(window.location.search);
const purpose = q.get('for') || 'test.purpose';
const label = q.get('label') || undefined;
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });

createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}>
    <main className="page" style={{ maxWidth: 640, margin: '0 auto', padding: '24px 16px' }}>
      <h1>A feature screen</h1>
      <p>Its own content would be here. Below, the one Google piece it uses.</p>
      <section className="ts-card" aria-label="Google connection">
        <GoogleConnect purpose={purpose} label={label} />
      </section>
    </main>
  </QueryClientProvider>,
);
