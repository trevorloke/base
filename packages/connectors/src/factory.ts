import { BlueskyConnector } from "./bluesky.ts";
import { MockConnector } from "./mock.ts";
import { ConnectorRegistry } from "./registry.ts";
import { XConnector } from "./x.ts";
import { ZernioConnector } from "./zernio.ts";

/**
 * The registry a Starsign process boots with. Native adapters are always present (their credentials
 * live on each account, not in the environment); Zernio needs a workspace-wide API key, so it joins
 * only when ZERNIO_API_KEY is set. Env is injectable so tests and tools can build registries without
 * touching process.env.
 */
export function createDefaultRegistry(env: NodeJS.ProcessEnv = process.env): ConnectorRegistry {
  const registry = new ConnectorRegistry()
    .register(new BlueskyConnector())
    .register(new XConnector({ clientId: env.X_CLIENT_ID, clientSecret: env.X_CLIENT_SECRET, ...(env.X_API_BASE_URL ? { baseUrl: env.X_API_BASE_URL } : {}) }));
  if (env.ZERNIO_API_KEY) registry.register(new ZernioConnector({ apiKey: env.ZERNIO_API_KEY, ...(env.ZERNIO_BASE_URL ? { baseUrl: env.ZERNIO_BASE_URL } : {}) }));
  // Registered last: resolve() falls back in insertion order, so an account with an unknown connector
  // name reaches the real adapter for its network before the mock does.
  registry.register(new MockConnector());
  return registry;
}
