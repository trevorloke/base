import type { PostSummary } from "../types";
import { PanelState } from "../components/PanelState";
import { PostCard } from "./PostCard";

export function Queue({
  items,
  loading,
  error,
  onRetry,
  onDecided,
}: {
  items: PostSummary[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onDecided: (id: string, decision: "approve" | "reject") => void;
}) {
  return (
    <section className="panel panel-queue" aria-labelledby="queue-title">
      <header className="panel-head">
        <h2 id="queue-title">Queue</h2>
        <span className="panel-meta mono">{items ? `${items.length} waiting on you` : ""}</span>
      </header>
      <div className="panel-body">
        <PanelState loading={loading && !items} error={error} onRetry={onRetry} empty={items && items.length === 0 ? "Nothing is waiting on you." : null} />
        {items?.map((item) => <PostCard key={item.post.id} item={item} onDecided={onDecided} />)}
      </div>
    </section>
  );
}
