import type { ActivityInput, Media, MetricInput, Network } from "@starsign/schema";

/** What a connector receives about the account it acts for. Auth is already decrypted by core. */
export interface AccountRef {
  id: string;
  workspaceId: string;
  network: Network;
  externalId: string;
  handle: string;
  /** Decrypted credential blob; shape is connector-specific. */
  auth: Record<string, unknown> | null;
  /** Non-secret connector config. */
  config: Record<string, unknown>;
}

export interface PublishInput {
  variantId: string;
  text: string;
  media: Media[];
  /** Additional thread segments after the first post. */
  thread: string[];
  /** Reply target, when this is a reply. */
  replyToExternalId?: string | null;
  /** Idempotency key: connectors that support it must not double-post on retry. */
  idempotencyKey: string;
}

export interface PublishResult {
  externalId: string;
  url: string | null;
  /** Thread segment ids when a thread was posted. */
  threadExternalIds?: string[];
  raw?: unknown;
}

export interface ValidationIssue {
  code: "too_long" | "too_many_media" | "media_required" | "thread_unsupported" | "unsupported_media" | "empty";
  message: string;
  /** Which segment (0 = root) when applicable. */
  segment?: number;
}

export interface ConnectorCapabilities {
  publish: boolean;
  fetchActivity: boolean;
  fetchMetrics: boolean;
  /** Reading costs money (metered API). Core enforces spend caps when true. */
  meteredReads: boolean;
}

/** Updated credentials to persist after a refresh. */
export interface AuthRefresh {
  auth: Record<string, unknown>;
}

export interface Connector {
  readonly name: string;
  readonly networks: readonly Network[];
  capabilities(network: Network): ConnectorCapabilities;
  /** Pre-flight checks beyond generic limits (e.g. link cards). Return [] when fine. */
  validate?(account: AccountRef, input: PublishInput): ValidationIssue[];
  publish(account: AccountRef, input: PublishInput): Promise<PublishResult>;
  fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]>;
  /** Metrics for the given external post ids, as of now. */
  fetchMetrics(account: AccountRef, externalIds: string[]): Promise<MetricInput[]>;
  refreshAuth?(account: AccountRef): Promise<AuthRefresh | null>;
}

export class ConnectorError extends Error {
  /** Set when part of a thread reached the network before the failure: the root's ids, so core can keep them. */
  partial?: { externalId: string; url: string | null; threadExternalIds: string[] };
  constructor(
    message: string,
    public readonly kind: "auth" | "rate_limit" | "rejected" | "network" | "unknown",
    public readonly retryable: boolean,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}
