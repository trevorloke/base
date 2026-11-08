"use client";

import { useActionState } from "react";
import { retryBaseGroundRow, sendBaseGroundNow, sendTestEmail, sendTestSms, skipBaseGroundRow, testBaseGround } from "@/app/admin/(secure)/integrations/actions";
import { fieldError, Notice } from "@/components/admin/Notice";
import { SubmitButton } from "@/components/admin/SubmitButton";
import { TextField } from "@/components/forms/Field";
import { useCmsForm } from "./useCmsForm";

export function TestEmailForm({ to }: { to: string }) {
  const [state, action] = useActionState(sendTestEmail, null);
  return (
    <form action={action} className="stack" style={{ gap: 8 }}>
      <div>
        <SubmitButton className="btn btn--outline btn--sm" pendingText="Sending…">
          Send me a test email
        </SubmitButton>
      </div>
      <p className="small">Goes to {to}.</p>
      <Notice state={state} />
    </form>
  );
}

export function TestSmsForm() {
  const form = useCmsForm(sendTestSms);
  const { state } = form;
  return (
    <form key={form.key} action={form.action} className="stack" style={{ gap: 8 }}>
      <TextField id="test-sms-to" name="to" type="tel" label="Send a test text to (your own phone)" required autoComplete="tel" placeholder="604 555 0100" defaultValue={form.text("to", "")} error={fieldError(state, "to")} />
      <div>
        <SubmitButton className="btn btn--outline btn--sm" pendingText="Sending…">
          Send a test text
        </SubmitButton>
      </div>
      <Notice state={state} />
    </form>
  );
}

/** Base Ground: "Test connection" (ping) and "Send now" (deliver everything waiting). */
export function BaseGroundForms({ waiting }: { waiting: number }) {
  const [testState, testAction] = useActionState(testBaseGround, null);
  const [sendState, sendAction] = useActionState(sendBaseGroundNow, null);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <form action={testAction} className="stack" style={{ gap: 8 }}>
        <div>
          <SubmitButton className="btn btn--outline btn--sm" pendingText="Checking…">
            Test connection
          </SubmitButton>
        </div>
        <Notice state={testState} />
      </form>
      <form action={sendAction} className="stack" style={{ gap: 8 }}>
        <div>
          <SubmitButton className="btn btn--outline btn--sm" pendingText="Sending…">
            Send now{waiting ? ` (${waiting} waiting)` : ""}
          </SubmitButton>
        </div>
        <Notice state={sendState} />
      </form>
    </div>
  );
}

/** Retry (failed or skipped → pending, attempts reset) and Skip for one outbox row. */
export function OutboxRowActions({ id, status }: { id: string; status: string }) {
  const [retryState, retryAction] = useActionState(retryBaseGroundRow, null);
  const [skipState, skipAction] = useActionState(skipBaseGroundRow, null);
  const canRetry = status === "failed" || status === "skipped";
  const canSkip = status === "pending" || status === "failed";
  if (!canRetry && !canSkip && !retryState && !skipState) return null;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="btn-row" style={{ gap: 6 }}>
        {canRetry && (
          <form action={retryAction}>
            <input type="hidden" name="id" value={id} />
            <SubmitButton className="btn btn--outline btn--compact" pendingText="Sending…">
              Retry
            </SubmitButton>
          </form>
        )}
        {canSkip && (
          <form action={skipAction}>
            <input type="hidden" name="id" value={id} />
            <SubmitButton className="btn btn--outline btn--compact" pendingText="Saving…" confirm="Skip this one? It won't be sent to Base Ground.">
              Skip
            </SubmitButton>
          </form>
        )}
      </div>
      <Notice state={retryState} />
      <Notice state={skipState} />
    </div>
  );
}
