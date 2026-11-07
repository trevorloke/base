"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";
import { resendEmailAction } from "@/app/admin/(secure)/comms/actions";
import { SubmitButton } from "@/components/admin/SubmitButton";

/** Re-queue a failed one-off email from the log. */
export function ResendButton({ id }: { id: string }) {
  const router = useRouter();
  const [state, action] = useActionState(resendEmailAction, null);
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
  return (
    <form action={action} style={{ display: "inline" }}>
      <input type="hidden" name="id" value={id} />
      <SubmitButton className="btn btn--outline" style={{ minHeight: 36 }} pendingText="Queuing…">
        Resend
      </SubmitButton>
      {state && (
        <span role={state.ok ? "status" : "alert"} className={`inline-result${state.ok ? "" : " is-error"}`}>
          {state.ok ? (state.message ?? "Queued.") : state.error}
        </span>
      )}
    </form>
  );
}
