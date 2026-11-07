"use client";

import { useActionState } from "react";
import { fieldError, Notice } from "@/components/admin/Notice";
import { SubmitButton } from "@/components/admin/SubmitButton";
import { Checkbox } from "@/components/forms/Field";
import type { ActionState } from "@/lib/server/actions";

type Action = (state: ActionState, form: FormData) => Promise<ActionState>;

/** The PIPA deletion request: a tick box, then a confirmation, because there is no undo. */
export function AnonymizeForm({ id, name, action }: { id: string; name: string; action: Action }) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className="stack" style={{ gap: 12 }}>
      <Notice state={state} />
      <input type="hidden" name="id" value={id} />
      <p className="small">
        For a deletion request under BC&apos;s Personal Information Protection Act. Name, address, phone, email, consents, tags and notes are
        erased and the newsletter subscription ends. Contribution records stay, as election-financing law requires. This can&apos;t be undone.
      </p>
      <Checkbox name="confirm" error={fieldError(state, "confirm")}>
        I have the request on file and want to remove {name}&apos;s personal details
      </Checkbox>
      <div>
        <SubmitButton className="btn btn--red btn--compact" pendingText="Removing…" confirm={`Remove ${name}'s personal details for good?`}>
          Anonymize this supporter
        </SubmitButton>
      </div>
    </form>
  );
}
