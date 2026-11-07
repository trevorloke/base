"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { ActionError, adminAction } from "@/lib/server/actions";
import { ROLE_LABELS, type Role } from "@/lib/server/admin-auth";
import { audit } from "@/lib/server/audit";
import { changeRole, inviteStaff, resetPassword, resetStaffTwoFactor, ROLES, sendSignInLink, setActive } from "@/lib/server/staff";

// Handlers write their own audit entry so it names the account (entity
// "admin_user" + id); adminAction's auditAction argument is left out so there
// is one entry per action, not two. Passwords are never logged.

const role = z.enum(ROLES as [Role, ...Role[]], { error: "Choose a role" });
const id = z.uuid({ error: "Not a staff account" });

function refresh() {
  revalidatePath("/admin/users");
}

export const inviteAction = adminAction(
  "users",
  z.object({
    name: z.string().trim().min(1, "Enter their name").max(80),
    email: z.string().trim().toLowerCase().max(254).pipe(z.email("Enter a valid email address")),
    role,
  }),
  async (data, { user }) => {
    const invite = await inviteStaff(getDb(), user, data);
    await audit(user, "staff.invite", { email: data.email, role: data.role, emailed: invite.emailed }, "admin_user", invite.id);
    refresh();
    if (invite.oneTimePassword) {
      return `Account created for ${data.name}. Their one-time password is ${invite.oneTimePassword} — pass it on securely; it is shown only this once. They can change it under My account.`;
    }
    return invite.emailed
      ? `Account created. A sign-in link is on its way to ${data.email}; it works once and expires in an hour.`
      : `Account created, but the sign-in email could not be sent. Use "Send a sign-in link" to try again.`;
  },
);

export const resendLinkAction = adminAction("users", z.object({ id }), async (data, { user }) => {
  const db = getDb();
  const target = await db.query.adminUsers.findFirst({ where: (u, { eq }) => eq(u.id, data.id) });
  if (!target) throw new ActionError("That account no longer exists.");
  if (!target.active) throw new ActionError("Reactivate the account first.");
  if (!env.emailEnabled) throw new ActionError("Email isn't configured, so sign-in links can't be sent. Reset their password instead.");
  const sent = await sendSignInLink(db, target.email);
  if (!sent) throw new ActionError("The email could not be sent. Check the Integrations page.");
  await audit(user, "staff.signin-link", { email: target.email }, "admin_user", data.id);
  return `A sign-in link is on its way to ${target.email}.`;
});

export const changeRoleAction = adminAction("users", z.object({ id, role }), async (data, { user }) => {
  const { previous } = await changeRole(getDb(), user, data.id, data.role);
  await audit(user, "staff.role", { from: previous, to: data.role }, "admin_user", data.id);
  refresh();
  return previous === data.role ? "No change." : `Role changed to ${ROLE_LABELS[data.role]}.`;
});

export const deactivateAction = adminAction("users", z.object({ id }), async (data, { user }) => {
  await setActive(getDb(), user, data.id, false);
  await audit(user, "staff.deactivate", {}, "admin_user", data.id);
  refresh();
  return "Account deactivated and signed out everywhere.";
});

export const reactivateAction = adminAction("users", z.object({ id }), async (data, { user }) => {
  await setActive(getDb(), user, data.id, true);
  await audit(user, "staff.reactivate", {}, "admin_user", data.id);
  refresh();
  return "Account reactivated.";
});

export const resetPasswordAction = adminAction("users", z.object({ id }), async (data, { user }) => {
  const password = await resetPassword(getDb(), user, data.id);
  await audit(user, "staff.reset-password", {}, "admin_user", data.id);
  refresh();
  return `New password: ${password} — pass it on securely; it is shown only this once. Their other sessions are signed out.`;
});

export const resetTwoFactorAction = adminAction("users", z.object({ id }), async (data, { user }) => {
  await resetStaffTwoFactor(getDb(), user, data.id);
  await audit(user, "staff.reset-2fa", {}, "admin_user", data.id);
  refresh();
  return "Two-factor sign-in was reset and they were signed out everywhere. Owners and administrators set it up again when they next sign in.";
});
