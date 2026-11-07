"use client";

import { useActionState } from "react";
import { fieldDefault, fieldError, Notice } from "@/components/admin/Notice";
import { SubmitButton } from "@/components/admin/SubmitButton";
import { TextField } from "@/components/forms/Field";
import type { ActionState } from "@/lib/server/actions";

type Action = (state: ActionState, form: FormData) => Promise<ActionState>;

/**
 * Add or change one year's limit. A stored year's form keeps the year fixed
 * (sent as a hidden field); the "add" form lets the year be typed.
 */
export function LimitForm({
  action,
  idPrefix,
  year,
  fixedYear = false,
  amount = "",
  note = "",
  submitLabel,
}: {
  action: Action;
  idPrefix: string;
  year: number;
  fixedYear?: boolean;
  amount?: string;
  note?: string;
  submitLabel: string;
}) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className="stack" style={{ gap: 12 }}>
      <Notice state={state} />
      {fixedYear ? (
        <input type="hidden" name="year" value={year} />
      ) : (
        <TextField
          id={`${idPrefix}-year`}
          name="year"
          label="Year"
          inputMode="numeric"
          defaultValue={fieldDefault(state, "year", String(year))}
          required
          style={{ maxWidth: 140 }}
          error={fieldError(state, "year")}
        />
      )}
      <TextField
        id={`${idPrefix}-amount`}
        name="amount"
        label={`Limit per person for ${fixedYear ? year : "the year"} (dollars)`}
        inputMode="decimal"
        defaultValue={fieldDefault(state, "amount", amount)}
        placeholder="1,429.70"
        required
        style={{ maxWidth: 200 }}
        error={fieldError(state, "amount")}
      />
      <TextField
        id={`${idPrefix}-note`}
        name="note"
        label="Source (optional)"
        hint="Where the figure comes from, such as the Elections BC notice and its date."
        defaultValue={fieldDefault(state, "note", note)}
        maxLength={500}
        error={fieldError(state, "note")}
      />
      <div>
        <SubmitButton className="btn btn--primary btn--compact" pendingText="Saving…">
          {submitLabel}
        </SubmitButton>
      </div>
    </form>
  );
}
