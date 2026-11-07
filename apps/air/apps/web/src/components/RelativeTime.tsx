import { formatDateTime, relativeTime } from "../lib/time";
import { useNow } from "../lib/useNow";

/** "3m ago" in mono, with the absolute time on hover. Ticks so it never goes stale. */
export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  const now = useNow();
  return (
    <time className={`mono rel${className ? ` ${className}` : ""}`} dateTime={iso} title={formatDateTime(iso)}>
      {relativeTime(iso, now)}
    </time>
  );
}
