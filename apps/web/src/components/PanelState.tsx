/** Loading, error and empty states, in one quiet line. */
export function PanelState({ loading, error, onRetry, empty }: { loading?: boolean; error?: string | null; onRetry?: () => void; empty?: string | null }) {
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
  if (empty) return <div className="state state-empty">{empty}</div>;
  return null;
}
