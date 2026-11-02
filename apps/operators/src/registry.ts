import { createDefaultRegistry, type ConnectorRegistry } from "@meridian/connectors";

/**
 * The registry this process boots with: the connectors package's factory (native Bluesky and X adapters, Zernio when
 * ZERNIO_API_KEY is set, the mock adapter last). Env is injectable so tools can build one without touching process.env.
 */
export function buildRegistry(env: NodeJS.ProcessEnv = process.env): ConnectorRegistry {
  return createDefaultRegistry(env);
}
