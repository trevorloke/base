import { EventEmitter } from "node:events";
import type { Db, DbHandle } from "@base-air/db";
import type { ConnectorRegistry } from "@base-air/connectors";
import { ApprovalDiffs, EventStore, OutcomeScheduler } from "@base-air/ledger";
import type { Actor } from "@base-air/schema";
import type { MemberRole } from "@base-air/policy";
import type { SecretBox } from "./crypto.ts";
import type { Scheduler } from "./scheduler.ts";

export interface CoreDeps {
  handle: DbHandle;
  connectors: ConnectorRegistry;
  scheduler: Scheduler;
  secrets: SecretBox;
  now?: () => Date;
  /** Optional semantic classifier for red lines marked semantic (wired to the model gateway by the operators app). */
  classifyTopic?: (text: string, keywords: string[], description: string) => number;
  /** Where uploaded media lives. Defaults to local disk (BASE_AIR_MEDIA_DIR / BASE_AIR_PUBLIC_URL). */
  mediaStorage?: import("./media/storage.ts").MediaStorage;
  /** Short-link base for link tracking. Undefined: read BASE_AIR_LINK_BASE_URL / BASE_AIR_PUBLIC_URL. Null: off. */
  linkBaseUrl?: string | null;
  /** Sign-up gate, mailer and link base for people auth. Defaults read the environment. */
  auth?: import("./services/auth.ts").AuthOptions;
  /** The look before a workspace saves one. Default: BASE_AIR_BRAND_* settings, else the Air preset. */
  defaultBrand?: import("@base-air/look").Brand;
}

/** Who is asking. Every service call carries one; it decides autonomy and shows up in the ledger. */
export interface Principal {
  workspaceId: string;
  actor: Actor;
  role?: MemberRole;
}

export const SYSTEM: Actor = { type: "system", id: "base-air" };

export class CoreContext {
  readonly db: Db;
  readonly events: EventStore;
  readonly outcomes: OutcomeScheduler;
  readonly diffs: ApprovalDiffs;
  readonly connectors: ConnectorRegistry;
  readonly scheduler: Scheduler;
  readonly secrets: SecretBox;
  readonly now: () => Date;
  readonly classifyTopic?: CoreDeps["classifyTopic"];
  /** Live fan-out: "activity", "post", "alert", "forecast". The API turns these into SSE. */
  readonly emitter = new EventEmitter();

  constructor(deps: CoreDeps) {
    this.db = deps.handle.db;
    this.now = deps.now ?? (() => new Date());
    this.events = new EventStore(this.db, this.now);
    this.outcomes = new OutcomeScheduler(this.db, this.events);
    this.diffs = new ApprovalDiffs(this.db);
    this.connectors = deps.connectors;
    this.scheduler = deps.scheduler;
    this.secrets = deps.secrets;
    this.classifyTopic = deps.classifyTopic;
  }
}
