"use client";

import { useEffect, useRef } from "react";
import type { ActionState } from "@/lib/server/actions";

/** Shows a server action's result and moves focus to it so it is announced. */
export function Notice({ state }: { state: ActionState }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state) ref.current?.focus();
  }, [state]);
  if (!state) return null;
  if (state.ok) {
    if (!state.message) return null;
    return (
      <div ref={ref} tabIndex={-1} role="status" className="alert alert--note" style={{ outline: "none" }}>
        <span aria-hidden="true" className="alert-icon">
          ✓
        </span>
        <span>{state.message}</span>
      </div>
    );
  }
  return (
    <div ref={ref} tabIndex={-1} role="alert" className="alert" style={{ outline: "none" }}>
      <span aria-hidden="true" className="alert-icon">
        !
      </span>
      <span>
        {state.error}
        {state.fields && Object.keys(state.fields).length > 0 && (
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {Object.entries(state.fields).map(([field, message]) => (
              <li key={field}>
                <strong>{field}</strong>: {message}
              </li>
            ))}
          </ul>
        )}
      </span>
    </div>
  );
}

/** The error for one field from an action state, for `error={fieldError(state, "title")}`. */
export function fieldError(state: ActionState, name: string): string | undefined {
  return state && !state.ok ? state.fields?.[name] : undefined;
}

/**
 * A field's default after the action ran: what was submitted when the action
 * returned values (always on failure, and on success for forms whose action
 * echoes them), else the fallback. React 19 resets an uncontrolled form to its
 * defaults after an action, so this keeps what was typed.
 */
export function fieldDefault(state: ActionState, name: string, fallback = ""): string {
  const v = state?.values?.[name];
  if (v === undefined) return fallback;
  return Array.isArray(v) ? v.join(", ") : v;
}

/** fieldDefault for a tick box: with submitted values, ticked means present. */
export function fieldDefaultChecked(state: ActionState, name: string, fallback: boolean): boolean {
  if (!state?.values) return fallback;
  const v = state.values[name];
  return v !== undefined && v !== "" && v !== "false" && v !== "off";
}
