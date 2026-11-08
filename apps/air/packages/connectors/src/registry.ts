import type { Network } from "@base-air/schema";
import type { Connector } from "./types.ts";

/** Resolves the adapter for an account: by explicit connector name first, else any adapter serving the network. */
export class ConnectorRegistry {
  private byName = new Map<string, Connector>();

  register(c: Connector): this {
    this.byName.set(c.name, c);
    return this;
  }

  get(name: string): Connector | undefined {
    return this.byName.get(name);
  }

  /** Strict: the account's connector must be registered and serve the network. No silent fallback to another adapter. */
  resolve(connectorName: string, network: Network): Connector {
    const named = this.byName.get(connectorName);
    if (named && named.networks.includes(network)) return named;
    if (named) throw new Error(`connector "${connectorName}" does not serve ${network}`);
    throw new Error(`connector "${connectorName}" is not configured in this deployment`);
  }

  list(): Connector[] {
    return [...this.byName.values()];
  }
}
