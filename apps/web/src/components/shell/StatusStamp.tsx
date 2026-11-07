import { STATUS_BY_ID, type PromiseStatus } from "@/lib/tracker";

// A shape for each status, so the stamp never relies on colour alone.
const icons: Record<PromiseStatus, React.ReactNode> = {
  not_started: <circle cx="12" cy="12" r="7" />,
  in_progress: (
    <>
      <circle cx="12" cy="12" r="7" />
      <path d="M12 8v4l3 2" />
    </>
  ),
  partly_kept: (
    <>
      <circle cx="12" cy="12" r="7" />
      <path d="M12 5a7 7 0 0 1 0 14z" fill="currentColor" />
    </>
  ),
  kept: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  broken: <path d="M7 7l10 10M17 7L7 17" />,
};

export function StatusStamp({ status }: { status: PromiseStatus }) {
  const s = STATUS_BY_ID[status] ?? STATUS_BY_ID.not_started;
  return (
    <span className="status-badge status-stamp" style={{ background: s.color, color: s.text }}>
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
        {icons[s.id]}
      </svg>
      {s.label}
    </span>
  );
}
