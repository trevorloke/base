"use client";

import { useActionState } from "react";
import { TextField } from "@/components/forms/Field";
import { fieldDefault, fieldError, Notice } from "@/components/admin/Notice";
import { SubmitButton } from "@/components/admin/SubmitButton";
import type { ActionState } from "@/lib/server/actions";
import { peopleParams, type PeopleQuery } from "./query";

type Action = (state: ActionState, form: FormData) => Promise<ActionState>;

/** Tag everyone the current filter matches. The filter is carried as hidden fields so the action re-runs the same query. */
export function BulkTagForm({ action, query, total }: { action: Action; query: PeopleQuery; total: number }) {
  const [state, formAction] = useActionState(action, null);
  const hidden = [...peopleParams(query, { page: 1 }).entries()];
  const who = `${total} supporter${total === 1 ? "" : "s"} matching this view`;
  return (
    <form action={formAction} className="bulk" aria-labelledby="bulk-title">
      <h2 id="bulk-title" className="h3" style={{ fontSize: 17, flexBasis: "100%" }}>
        Tag everyone in this view ({total})
      </h2>
      <div style={{ flexBasis: "100%" }}>
        <Notice state={state} />
      </div>
      {hidden.map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}
      {/* Named bulkTag, not tag: "tag" is the list's filter key, carried in the hidden fields above. */}
      <TextField id="bulk-tag" name="bulkTag" label="Tag" defaultValue={fieldDefault(state, "bulkTag")} inputClassName="input--compact" maxLength={40} required error={fieldError(state, "bulkTag")} />
      <div className="bulk__buttons">
        <SubmitButton name="mode" value="add" className="btn btn--primary btn--compact" pendingText="Tagging…" confirm={`Add this tag to ${who}?`}>
          Add tag to all
        </SubmitButton>
        <SubmitButton name="mode" value="remove" className="btn btn--outline btn--compact" pendingText="Removing…" confirm={`Remove this tag from ${who}?`}>
          Remove tag from all
        </SubmitButton>
      </div>
    </form>
  );
}
