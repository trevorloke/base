"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { ActionError, adminAction, formToObject, type ActionState } from "@/lib/server/actions";
import { isLocked, parseSessionCookie, PASSWORD_MIN_LENGTH, recordAttempt, requireAdmin, SESSION_COOKIE, type AdminUser, type Permission } from "@/lib/server/admin-auth";
import { audit } from "@/lib/server/audit";
import { confirmEnrolment, disableTwoFactor, regenerateRecoveryCodes, startEnrolment } from "@/lib/server/mfa";
import { changeOwnPassword, renameSelf, signOutEverywhere } from "@/lib/server/staff";
import { fieldErrors } from "@/lib/validation";

// Handlers write their own audit entry (entity "admin_user" + the signed-in
// id); adminAction's auditAction argument is left out so there is one entry
// per action, not two. Passwords are never logged.

// Any signed-in admin may manage their own account: requireAdmin() skips the
// role check when no permission is given.
const ANY_ADMIN = undefined as unknown as Permission;

async function currentSessionId(): Promise<string | null> {
  return parseSessionCookie((await cookies()).get(SESSION_COOKIE)?.value)?.id ?? null;
}

export const renameAction = adminAction(ANY_ADMIN, z.object({ name: z.string().trim().min(1, "Enter your name").max(80) }), async (data, { user }) => {
  await renameSelf(getDb(), user.id, data.name);
  await audit(user, "account.rename", { from: user.name, to: data.name }, "admin_user", user.id);
  revalidatePath("/admin", "layout");
  return "Name saved.";
});

export const changePasswordAction = adminAction(
  ANY_ADMIN,
  z
    .object({
      currentPassword: z.string().max(200).optional().default(""),
      password: z.string().min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`).max(200),
      confirm: z.string().max(200),
    })
    .refine((d) => d.password === d.confirm, { path: ["confirm"], error: "The two passwords don't match" }),
  async (data, { user }) => {
    await changeOwnPassword(getDb(), user.id, data.currentPassword, data.password, await currentSessionId());
    await audit(user, "account.password", {}, "admin_user", user.id);
    return "Password changed. Any other sessions have been signed out.";
  },
);

export const signOutEverywhereAction = adminAction(ANY_ADMIN, z.object({}), async (_data, { user }) => {
  await signOutEverywhere(getDb(), user.id);
  await audit(user, "account.signout-all", {}, "admin_user", user.id);
  (await cookies()).delete(SESSION_COOKIE);
  return { ok: true, message: "Signed out everywhere.", redirect: "/admin/login?signedout=1" };
});

// ── Two-factor sign-in ─────────────────────────────────────────────────────
// These stay open to an owner or administrator who still has to set it up
// (requireAdmin with `enrolling`), unlike every other admin action. Wrong
// codes count toward the sign-in lockout, so a stolen session can't guess
// its way to turning two-factor sign-in off.

/** An action result that may carry recovery codes, shown once. */
export type TwoFactorState = (ActionState & { codes?: string[] }) | null;

type TwoFactorHandler<T> = (data: T, user: AdminUser) => Promise<TwoFactorState | string>;

function twoFactorAction<S extends z.ZodType>(schema: S, handler: TwoFactorHandler<z.output<S>>) {
  return async (_prev: TwoFactorState, form: FormData): Promise<TwoFactorState> => {
    const user = await requireAdmin(undefined, { enrolling: true });
    const parsed = schema.safeParse(formToObject(form));
    if (!parsed.success) return { ok: false, error: "Please check the highlighted fields.", fields: fieldErrors(parsed.error) };
    const db = getDb();
    const key = `email:${user.email}`;
    const usesCode = typeof (parsed.data as { code?: unknown }).code === "string";
    if (usesCode && (await isLocked(db, key))) return { ok: false, error: "Too many wrong codes. Wait 15 minutes and try again." };
    try {
      const result = await handler(parsed.data, user);
      if (usesCode) await recordAttempt(db, key, true);
      return typeof result === "string" ? { ok: true, message: result } : result;
    } catch (err) {
      if (err instanceof ActionError) {
        if (usesCode && err.fields?.code) await recordAttempt(db, key, false);
        return { ok: false, error: err.message, fields: err.fields };
      }
      console.error(err);
      return { ok: false, error: "Something went wrong saving that. Nothing was changed. Please try again." };
    }
  };
}

const code = z.string().trim().min(1, "Enter a code").max(40);

export const startTwoFactorAction = twoFactorAction(z.object({}), async (_data, user) => {
  await startEnrolment(getDb(), user.id);
  await audit(user, "account.2fa.start", {}, "admin_user", user.id);
  revalidatePath("/admin/account");
  return { ok: true };
});

export const confirmTwoFactorAction = twoFactorAction(z.object({ code }), async (data, user) => {
  const codes = await confirmEnrolment(getDb(), user.id, data.code);
  await audit(user, "account.2fa.enable", {}, "admin_user", user.id);
  // No revalidation here: the page keeps showing the recovery codes until the person moves on.
  return { ok: true, message: "Two-factor sign-in is on.", codes };
});

export const regenerateCodesAction = twoFactorAction(z.object({ code }), async (data, user) => {
  const codes = await regenerateRecoveryCodes(getDb(), user.id, data.code);
  await audit(user, "account.2fa.recovery-codes", {}, "admin_user", user.id);
  return { ok: true, message: "New recovery codes. The old ones no longer work.", codes };
});

export const disableTwoFactorAction = twoFactorAction(z.object({ code }), async (data, user) => {
  const used = await disableTwoFactor(getDb(), user.id, data.code);
  await audit(user, "account.2fa.disable", { with: used === "totp" ? "app code" : "recovery code" }, "admin_user", user.id);
  revalidatePath("/admin", "layout");
  return "Two-factor sign-in is off.";
});
