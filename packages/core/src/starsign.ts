import { CoreContext, type CoreDeps } from "./context.ts";
import { AccountService } from "./services/accounts.ts";
import { ApprovalService } from "./services/approvals.ts";
import { ExportService } from "./services/export.ts";
import { ListeningService } from "./services/listening.ts";
import { MetricsService } from "./services/metrics.ts";
import { OpsService } from "./services/ops.ts";
import { PolicyService } from "./services/policy.ts";
import { PostService } from "./services/posts.ts";
import { PublishingService } from "./services/publishing.ts";
import { TrendService } from "./services/trends.ts";
import { WorkspaceService } from "./services/workspaces.ts";

/** The one object every front door (API, MCP, operators, workers) talks to. */
export class Starsign {
  readonly ctx: CoreContext;
  readonly workspaces: WorkspaceService;
  readonly accounts: AccountService;
  readonly policy: PolicyService;
  readonly posts: PostService;
  readonly approvals: ApprovalService;
  readonly publishing: PublishingService;
  readonly listening: ListeningService;
  readonly metrics: MetricsService;
  readonly trends: TrendService;
  readonly ops: OpsService;
  readonly exports: ExportService;

  constructor(deps: CoreDeps) {
    this.ctx = new CoreContext(deps);
    this.workspaces = new WorkspaceService(this.ctx);
    this.accounts = new AccountService(this.ctx);
    this.policy = new PolicyService(this.ctx);
    this.posts = new PostService(this.ctx, this.policy);
    this.approvals = new ApprovalService(this.ctx, this.posts, this.policy);
    this.publishing = new PublishingService(this.ctx, this.accounts);
    this.listening = new ListeningService(this.ctx, this.accounts);
    this.metrics = new MetricsService(this.ctx, this.accounts, this.policy);
    this.trends = new TrendService(this.ctx);
    this.ops = new OpsService(this.ctx);
    this.exports = new ExportService(this.ctx);
  }

  get events() {
    return this.ctx.events;
  }
  get emitter() {
    return this.ctx.emitter;
  }
}
