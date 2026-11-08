"use client";

import { useActionState } from "react";
import { fieldDefault, fieldError, Notice } from "@/components/admin/Notice";
import { SubmitButton } from "@/components/admin/SubmitButton";
import { SelectField, TextField } from "@/components/forms/Field";
import type { ActionState } from "@/lib/server/actions";
import type { Role } from "@/lib/server/admin-auth";

type Action = (state: ActionState, form: FormData) => Promise<ActionState>;
type RoleOption = { id: Role; label: string; summary: string };

export function InviteForm({ action, roles, emailEnabled }: { action: Action; roles: RoleOption[]; emailEnabled: boolean }) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className="form-card form-card--surface" style={{ gap: 14 }} aria-labelledby="invite-title">
      <h2 id="invite-title" className="h3" style={{ fontSize: 20 }}>
        Invite a staff member
      </h2>
      <Notice state={state} />
      <div className="form-row">
        <TextField id="invite-name" name="name" label="Name" defaultValue={fieldDefault(state, "name")} maxLength={80} required error={fieldError(state, "name")} autoComplete="off" />
        <TextField id="invite-email" name="email" label="Email" defaultValue={fieldDefault(state, "email")} type="email" maxLength={254} required error={fieldError(state, "email")} autoComplete="off" />
        <SelectField id="invite-role" name="role" label="Role" defaultValue={fieldDefault(state, "role", "organizer")} error={fieldError(state, "role")}>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </SelectField>
      </div>
      <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
        {roles.map((r) => (
          <li key={r.id}>
            <strong>{r.label}:</strong> {r.summary}
          </li>
        ))}
      </ul>
      <p className="small">
        {emailEnabled
          ? "They get an email with a one-time sign-in link and set their own password under My account."
          : "Email isn't configured, so a one-time password is generated and shown to you once. Pass it on securely."}
      </p>
      <div>
        <SubmitButton pendingText="Creating…">Create account</SubmitButton>
      </div>
    </form>
  );
}

export type StaffControlsProps = {
  id: string;
  name: string;
  role: Role;
  active: boolean;
  passwordSet: boolean;
  twoFactor: boolean;
  isSelf: boolean;
  actorIsOwner: boolean;
  emailEnabled: boolean;
  roles: RoleOption[];
  /** The account has a Base Ground link ("Sign in with Base"). */
  baseLinked: boolean;
  actions: { changeRole: Action; deactivate: Action; reactivate: Action; resetPassword: Action; resendLink: Action; resetTwoFactor: Action; removeBaseLink: Action };
};

/** Role, active state, password reset, sign-in link and Base Ground link for one account. */
export function StaffControls(p: StaffControlsProps) {
  const [roleState, changeRole] = useActionState(p.actions.changeRole, null);
  const [activeState, setActive] = useActionState(p.active ? p.actions.deactivate : p.actions.reactivate, null);
  const [resetState, resetPassword] = useActionState(p.actions.resetPassword, null);
  const [linkState, resendLink] = useActionState(p.actions.resendLink, null);
  const [twoFactorState, resetTwoFactor] = useActionState(p.actions.resetTwoFactor, null);
  const [baseLinkState, removeBaseLink] = useActionState(p.actions.removeBaseLink, null);
  const states = [roleState, activeState, resetState, linkState, twoFactorState, baseLinkState];
  const notices = states.filter(Boolean);
  return (
    <>
      <div className="staff__controls">
        <form action={changeRole}>
          <input type="hidden" name="id" value={p.id} />
          <SelectField id={`role-${p.id}`} name="role" label="Role" defaultValue={fieldDefault(roleState, "role", p.role)} error={fieldError(roleState, "role")} className="field" disabled={!p.active}>
            {p.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </SelectField>
          <SubmitButton className="btn btn--outline btn--compact" pendingText="Saving…" disabled={!p.active}>
            Save role
          </SubmitButton>
        </form>
        {!p.isSelf && (
          <form action={setActive}>
            <input type="hidden" name="id" value={p.id} />
            <SubmitButton
              className={`btn btn--compact ${p.active ? "btn--outline" : "btn--primary"}`}
              pendingText="Saving…"
              confirm={p.active ? `Deactivate ${p.name}? They are signed out everywhere and can't sign in until reactivated.` : undefined}
            >
              {p.active ? "Deactivate" : "Reactivate"}
            </SubmitButton>
          </form>
        )}
        {p.actorIsOwner && p.active && (
          <form action={resetPassword}>
            <input type="hidden" name="id" value={p.id} />
            <SubmitButton className="btn btn--outline btn--compact" pendingText="Resetting…" confirm={`Reset ${p.name}'s password? Their current password stops working and they are signed out everywhere.`}>
              Reset password
            </SubmitButton>
          </form>
        )}
        {p.actorIsOwner && !p.isSelf && p.twoFactor && (
          <form action={resetTwoFactor}>
            <input type="hidden" name="id" value={p.id} />
            <SubmitButton
              className="btn btn--outline btn--compact"
              pendingText="Resetting…"
              confirm={`Reset ${p.name}'s two-factor sign-in? Their authenticator app and recovery codes stop working and they are signed out everywhere.`}
            >
              Reset two-factor
            </SubmitButton>
          </form>
        )}
        {p.baseLinked && (
          <form action={removeBaseLink}>
            <input type="hidden" name="id" value={p.id} />
            <SubmitButton
              className="btn btn--outline btn--compact"
              pendingText="Removing…"
              confirm={`Remove ${p.name}'s Base Ground link? "Sign in with Base" will ask them to confirm this account again before it opens the admin.`}
            >
              Remove Base link
            </SubmitButton>
          </form>
        )}
        {p.emailEnabled && p.active && (
          <form action={resendLink}>
            <input type="hidden" name="id" value={p.id} />
            <SubmitButton className="btn btn--outline btn--compact" pendingText="Sending…">
              {p.passwordSet ? "Send a sign-in link" : "Re-send the invite"}
            </SubmitButton>
          </form>
        )}
      </div>
      {notices.length > 0 && (
        <div className="staff__notice stack" style={{ gap: 8 }}>
          {states.map((s, i) => (
            <Notice key={i} state={s} />
          ))}
        </div>
      )}
    </>
  );
}
