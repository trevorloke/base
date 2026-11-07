"use client";

import { useActionState } from "react";
import { fieldDefault, fieldError, Notice } from "@/components/admin/Notice";
import { SubmitButton } from "@/components/admin/SubmitButton";
import type { ActionState } from "@/lib/server/actions";

type Action = (state: ActionState, form: FormData) => Promise<ActionState>;

export function NoteForm({ id, action }: { id: string; action: Action }) {
  const [state, formAction] = useActionState(action, null);
  const error = fieldError(state, "body");
  return (
    <form action={formAction} className="stack" style={{ gap: 10 }}>
      <Notice state={state} />
      <input type="hidden" name="id" value={id} />
      <div className="field">
        <label htmlFor="note-body">Add a note</label>
        <textarea id="note-body" name="body" defaultValue={fieldDefault(state, "body")} className="input textarea" maxLength={4000} required aria-invalid={error ? true : undefined} aria-describedby={error ? "note-body-error" : undefined} />
        {error && (
          <p className="field-error" id="note-body-error">
            {error}
          </p>
        )}
      </div>
      <div>
        <SubmitButton className="btn btn--outline btn--compact" pendingText="Adding…">
          Add note
        </SubmitButton>
      </div>
    </form>
  );
}
