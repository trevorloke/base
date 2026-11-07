const LABELS: Record<string, string> = {
  draft: "Draft",
  sending: "Sending",
  sent: "Sent",
  cancelled: "Cancelled",
  queued: "Queued",
  failed: "Failed",
  skipped: "Skipped",
};

/** A campaign or message status pill. */
export function StatusBadge({ status }: { status: string }) {
  return <span className={`msg-status msg-status--${status}`}>{LABELS[status] ?? status}</span>;
}
