"use client";

import { useActionState, useEffect } from "react";
import { fieldDefault, fieldError, Notice } from "@/components/admin/Notice";
import { SubmitButton } from "@/components/admin/SubmitButton";
import { TextField } from "@/components/forms/Field";
import type { ActionState } from "@/lib/server/actions";

type Action = (state: ActionState, form: FormData) => Promise<ActionState>;

export function RenameForm({ action, name }: { action: Action; name: string }) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className="stack" style={{ gap: 12 }}>
      <Notice state={state} />
      <TextField id="account-name" name="name" label="Your name" defaultValue={fieldDefault(state, "name", name)} maxLength={80} required error={fieldError(state, "name")} autoComplete="name" />
      <div>
        <SubmitButton className="btn btn--outline btn--compact" pendingText="Saving…">
          Save name
        </SubmitButton>
      </div>
    </form>
  );
}

export function PasswordForm({ action, passwordSet, minLength }: { action: Action; passwordSet: boolean; minLength: number }) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className="stack" style={{ gap: 12 }}>
      <Notice state={state} />
      {passwordSet ? (
        <TextField id="current-password" name="currentPassword" label="Current password" type="password" required autoComplete="current-password" error={fieldError(state, "currentPassword")} />
      ) : (
        <p className="small">You signed in with an email link and have no password yet. Set one here to sign in with it next time.</p>
      )}
      <TextField id="new-password" name="password" label={`New password (at least ${minLength} characters)`} type="password" minLength={minLength} required autoComplete="new-password" error={fieldError(state, "password")} />
      <TextField id="confirm-password" name="confirm" label="New password again" type="password" minLength={minLength} required autoComplete="new-password" error={fieldError(state, "confirm")} />
      <div>
        <SubmitButton pendingText="Saving…">{passwordSet ? "Change password" : "Set password"}</SubmitButton>
      </div>
    </form>
  );
}

export function SignOutEverywhereForm({ action }: { action: Action }) {
  const [state, formAction] = useActionState(action, null);
  useEffect(() => {
    if (state?.ok && state.redirect) window.location.assign(state.redirect);
  }, [state]);
  return (
    <form action={formAction} className="stack" style={{ gap: 12 }}>
      <Notice state={state} />
      <div>
        <SubmitButton className="btn btn--accent btn--compact" pendingText="Signing out…" confirm="Sign out of every device, including this one?">
          Sign out everywhere
        </SubmitButton>
      </div>
    </form>
  );
}
