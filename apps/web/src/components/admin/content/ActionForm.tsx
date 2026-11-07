"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, type ReactNode } from "react";
import { Notice } from "@/components/admin/Notice";
import { SubmitButton } from "@/components/admin/SubmitButton";
import type { ActionState } from "@/lib/server/actions";

export type AdminFormAction = (prev: ActionState, form: FormData) => Promise<ActionState>;

/**
 * After an action succeeds, follow its `redirect` (e.g. to the edit page of a
 * new item) or refresh the page so lists and counts show the change.
 */
export function useActionRedirect(state: ActionState) {
  const router = useRouter();
  useEffect(() => {
    if (!state?.ok) return;
    if (state.redirect) router.push(state.redirect);
    else router.refresh();
  }, [state, router]);
}

/**
 * A one-button form for an action that needs no typing: publish, unpublish,
 * check in, delete. Hidden fields carry the ids. Destructive ones confirm.
 */
export function ActionForm({
  action,
  fields,
  children,
  confirm,
  pendingText,
  buttonClassName = "btn btn--outline",
  className,
  buttonProps,
  noticeBelow = true,
}: {
  action: AdminFormAction;
  fields: Record<string, string>;
  children: ReactNode;
  confirm?: string;
  pendingText?: string;
  buttonClassName?: string;
  className?: string;
  buttonProps?: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type" | "className" | "onClick">;
  noticeBelow?: boolean;
}) {
  const [state, formAction] = useActionState(action, null);
  useActionRedirect(state);
  return (
    <form action={formAction} className={className ?? "action-form"}>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <SubmitButton className={buttonClassName} confirm={confirm} pendingText={pendingText ?? "Working…"} {...buttonProps}>
        {children}
      </SubmitButton>
      {noticeBelow && <Notice state={state} />}
    </form>
  );
}
