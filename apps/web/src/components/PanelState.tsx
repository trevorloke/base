import type { ReactNode } from "react";

/** Loading, error and empty states, in one quiet line. An empty state may carry its next step (a link or button). */
export function PanelState({ loading, error, onRetry, empty }: { loading?: boolean; error?: string | null; onRetry?: () => void; empty?: ReactNode }) {
  if (error) {
    return (
      <div className="state state-error" role="alert">
        <span>{error}</span>
        {onRetry ? (
          <button type="button" className="btn btn-small" onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </div>
    );
  }
  if (loading) return <div className="state state-loading">Loading…</div>;
  // One span: the state row is a flex box, and a sentence with a link in it must wrap as one paragraph.
  if (empty) return <div className="state state-empty"><span>{empty}</span></div>;
  return null;
}
