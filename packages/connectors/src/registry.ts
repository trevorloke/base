import type { Network } from "@meridian/schema";
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

  resolve(connectorName: string, network: Network): Connector {
    const named = this.byName.get(connectorName);
    if (named && named.networks.includes(network)) return named;
    for (const c of this.byName.values()) if (c.networks.includes(network)) return c;
    throw new Error(`no connector for ${network} (requested "${connectorName}")`);
  }

  list(): Connector[] {
    return [...this.byName.values()];
  }
}
