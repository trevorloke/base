"use client";

import { useActionState } from "react";
import { fieldDefault, fieldError, Notice } from "@/components/admin/Notice";
import { SubmitButton } from "@/components/admin/SubmitButton";
import { TextField } from "@/components/forms/Field";
import type { ActionState } from "@/lib/server/actions";

type Action = (state: ActionState, form: FormData) => Promise<ActionState>;

/** The supporter's tags as chips with a remove button each, plus an add form with suggestions from tags already in use. */
export function TagsEditor({ id, tags, suggestions, addAction, removeAction }: { id: string; tags: string[]; suggestions: string[]; addAction: Action; removeAction: Action }) {
  const [addState, add] = useActionState(addAction, null);
  const [removeState, remove] = useActionState(removeAction, null);
  return (
    <div className="stack" style={{ gap: 12 }}>
      <Notice state={removeState} />
      {tags.length === 0 ? (
        <p className="small">No tags yet.</p>
      ) : (
        <ul className="crm-chips" aria-label="Tags" style={{ margin: 0 }}>
          {tags.map((tag) => (
            <li key={tag} className="chip chip--tag">
              {tag}
              <form action={remove}>
                <input type="hidden" name="id" value={id} />
                <input type="hidden" name="tag" value={tag} />
                <button type="submit" className="chip-remove" aria-label={`Remove the tag ${tag}`}>
                  ×
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
      <form action={add} className="stack" style={{ gap: 10 }}>
        <Notice state={addState} />
        <input type="hidden" name="id" value={id} />
        <TextField id="new-tag" name="tag" label="Add a tag" defaultValue={fieldDefault(addState, "tag")} list="tag-suggestions" maxLength={40} required inputClassName="input--compact" error={fieldError(addState, "tag")} autoComplete="off" />
        <datalist id="tag-suggestions">
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <div>
          <SubmitButton className="btn btn--outline btn--compact" pendingText="Adding…">
            Add tag
          </SubmitButton>
        </div>
      </form>
    </div>
  );
}
