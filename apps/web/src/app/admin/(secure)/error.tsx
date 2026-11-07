"use client";

export default function AdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="admin">
      <div role="alert" className="alert" style={{ maxWidth: 720 }}>
        <span aria-hidden="true" className="alert-icon">
          !
        </span>
        <span>
          <strong>Something went wrong on this page.</strong> Nothing was saved. {error.digest ? `Reference: ${error.digest}. ` : ""}
          <button type="button" className="link-button" onClick={reset}>
            Try again
          </button>
        </span>
      </div>
    </div>
  );
}
