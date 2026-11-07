import type { Network, Policy } from "@starsign/schema";
import type { CoreContext } from "../context.ts";
import type { AccountService } from "./accounts.ts";
import type { PolicyService } from "./policy.ts";
import type { WorkspaceService } from "./workspaces.ts";

/** The brand block every model call is grounded in. Structurally identical to @starsign/ai's BrandContext. */
export interface BrandContextData {
  workspace: { name: string; slug?: string; profile: Record<string, unknown> };
  policy: { redLines: Policy["redLines"]; timezone: string; autonomy?: Policy["autonomy"]; visibleTextForAi?: string; competitors?: string[] };
  networks: Network[];
}

export class BrandService {
  constructor(
    private readonly ctx: CoreContext,
    private readonly workspaces: WorkspaceService,
    private readonly policies: PolicyService,
    private readonly accounts: AccountService,
  ) {}

  /** One active account per network, skipping networks a `network_restriction` red line forbids outright. */
  async activeAccountsByNetwork(workspaceId: string, policy?: Policy) {
    const pol = policy ?? (await this.policies.getActive(workspaceId));
    const restricted = new Set(pol.redLines.flatMap((rl) => (rl.kind === "network_restriction" ? rl.networks : [])));
    const seen = new Set<string>();
    const out: { id: string; network: Network; handle: string }[] = [];
    for (const a of await this.accounts.list(workspaceId)) {
      if (a.status !== "active" || restricted.has(a.network) || seen.has(a.network)) continue;
      seen.add(a.network);
      out.push({ id: a.id, network: a.network as Network, handle: a.handle });
    }
    return out;
  }

  async context(workspaceId: string, opts: { policy?: Policy; networks?: Network[] } = {}): Promise<BrandContextData> {
    const ws = await this.workspaces.get(workspaceId);
    const policy = opts.policy ?? (await this.policies.getActive(workspaceId));
    const networks = opts.networks ?? (await this.activeAccountsByNetwork(workspaceId, policy)).map((a) => a.network);
    return {
      workspace: { name: ws.name, slug: ws.slug, profile: ws.profile },
      policy: { redLines: policy.redLines, timezone: policy.timezone, autonomy: policy.autonomy, visibleTextForAi: policy.disclosure.visibleTextForAi, competitors: policy.competitors },
      networks,
    };
  }
}
