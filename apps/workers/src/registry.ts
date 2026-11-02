import * as connectors from "@starsign/connectors";
import type { ConnectorRegistry } from "@starsign/connectors";

/**
 * Build the connector registry from the environment. Uses the native adapters' factory when the
 * connectors package exports one; otherwise the mock adapter alone (dev without any credentials).
 */
export function buildRegistry(env: NodeJS.ProcessEnv = process.env): ConnectorRegistry {
  const factory = (connectors as unknown as { createDefaultRegistry?: (env: NodeJS.ProcessEnv) => ConnectorRegistry }).createDefaultRegistry;
  if (factory) return factory(env);
  return new connectors.ConnectorRegistry().register(new connectors.MockConnector());
}
