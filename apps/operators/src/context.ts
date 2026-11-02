import type { BrandContext } from "@starsign/ai";
import type { Starsign, Principal } from "@starsign/core";
import type { Actor, Network, Policy } from "@starsign/schema";

/** The operators, as the ledger names them. Posts are created by "studio" (it drafts), alerts by "watch", briefs by "analyst". */
export const WATCH_ACTOR: Actor = { type: "operator", id: "watch" };
export const STUDIO_ACTOR: Actor = { type: "operator", id: "studio" };
export const ANALYST_ACTOR: Actor = { type: "operator", id: "analyst" };

export function principalFor(workspaceId: string, actor: Actor): Principal {
  return { workspaceId, actor };
}

export interface ActiveAccount {
  id: string;
  network: Network;
  handle: string;
}

/** One active account per network, skipping networks a `network_restriction` red line forbids outright. */
export async function activeAccountsByNetwork(m: Starsign, workspaceId: string, policy: Policy): Promise<ActiveAccount[]> {
  return m.brand.activeAccountsByNetwork(workspaceId, policy);
}

/** The brand block every prompt is grounded in: workspace profile, voice, red lines, connected networks. */
export async function buildBrandContext(m: Starsign, workspaceId: string, opts: { policy?: Policy; networks?: Network[] } = {}): Promise<BrandContext> {
  return m.brand.context(workspaceId, opts);
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
