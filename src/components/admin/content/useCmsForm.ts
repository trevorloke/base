"use client";

import { useActionState } from "react";
import type { ActionState } from "@/lib/server/actions";
import { useActionRedirect, type AdminFormAction } from "./ActionForm";

/** What was in the form when it was last submitted, by field name. */
export type Submitted = ReadonlyMap<string, readonly string[]>;

type CmsFormState = { result: ActionState; submitted: Submitted | null; key: number };

export function snapshotForm(form: FormData): Submitted {
  const out = new Map<string, string[]>();
  for (const [name, value] of form.entries()) {
    if (typeof value !== "string") continue; // Files are uploaded on their own, never resubmitted.
    out.set(name, [...(out.get(name) ?? []), value]);
  }
  return out;
}

/**
 * An admin form that keeps what was typed. React resets an uncontrolled form
 * once its action settles, which after a validation error would wipe (or, on
 * an edit page, silently revert) everything except the controlled fields. So
 * each submission is snapshotted, the form is remounted with a new `key`, and
 * fields take their defaults from the snapshot through `text` and `checked`.
 * After a successful save the fields show what was saved; `clearOnSuccess`
 * empties them instead (for quick-add forms).
 *
 *   const form = useCmsForm(saveEvent);
 *   <form key={form.key} action={form.action}>
 *     <TextField name="location" defaultValue={form.text("location", event?.location)} />
 */
export function useCmsForm(action: AdminFormAction, { clearOnSuccess = false }: { clearOnSuccess?: boolean } = {}) {
  const [state, dispatch] = useActionState(
    async (prev: CmsFormState, form: FormData): Promise<CmsFormState> => {
      const submitted = snapshotForm(form);
      const result = await action(prev.result, form);
      return { result, submitted: result?.ok && clearOnSuccess ? null : submitted, key: prev.key + 1 };
    },
    { result: null, submitted: null, key: 0 },
  );
  useActionRedirect(state.result);
  const { submitted } = state;
  return {
    state: state.result,
    action: dispatch,
    key: state.key,
    /** The submitted value of a field, or `fallback` before anything was submitted. */
    text<T>(name: string, fallback: T): string | T {
      return submitted ? (submitted.get(name)?.[0] ?? "") : fallback;
    },
    /** Whether a checkbox was ticked when submitted, or `fallback` before anything was submitted. */
    checked(name: string, fallback: boolean): boolean {
      return submitted ? submitted.has(name) : fallback;
    },
  };
}
