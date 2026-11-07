import "server-only";
import { z } from "zod";
import { fieldErrors } from "@/lib/validation";
import { requireAdmin, type AdminUser, type Permission } from "./admin-auth";
import { audit } from "./audit";

/** A form's submitted values, as FormData had them (repeated names are arrays). */
export type FormValues = Record<string, string | string[]>;

/**
 * What a form gets back from a server action, for React's useActionState.
 * React 19 resets an uncontrolled form after its action, so a failed action
 * returns the submitted `values` and the form uses them as defaults (see
 * fieldDefault in components/admin/Notice) instead of losing what was typed.
 */
export type ActionState = { ok: true; message?: string; redirect?: string; values?: FormValues } | { ok: false; error: string; fields?: Record<string, string>; values?: FormValues } | null;

// Never echoed back to the browser.
const SECRET_FIELD = /password|^confirm$|token/i;

/** The submitted values worth giving back to the form: text and choices, never passwords or files. */
export function formValues(form: FormData): FormValues {
  const out: FormValues = {};
  for (const [key, value] of Object.entries(formToObject(form))) {
    if (SECRET_FIELD.test(key)) continue;
    if (typeof value === "string" || Array.isArray(value)) out[key] = value as string | string[];
  }
  return out;
}

export class ActionError extends Error {
  constructor(
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
  }
}

type Handler<T> = (data: T, ctx: { user: AdminUser }) => Promise<ActionState | string | void>;

/**
 * Build an admin server action from a zod schema and a handler. The action
 * checks the signed-in admin's permission, validates the FormData against the
 * schema (checkboxes arrive as "on"), turns thrown errors into field or form
 * messages instead of a crashed page, and records an audit-log entry.
 *
 *   export const createEvent = adminAction("content", eventSchema, async (data, { user }) => { ... return "Event added." })
 *
 * In the form: `const [state, action, pending] = useActionState(createEvent, null)`.
 */
export function adminAction<S extends z.ZodType>(permission: Permission, schema: S, handler: Handler<z.output<S>>, auditAction?: string) {
  return async (_prev: ActionState, form: FormData): Promise<ActionState> => {
    const user = await requireAdmin(permission);
    const parsed = schema.safeParse(formToObject(form));
    if (!parsed.success) return { ok: false, error: "Please check the highlighted fields.", fields: fieldErrors(parsed.error), values: formValues(form) };
    try {
      const result = await handler(parsed.data, { user });
      if (auditAction) await audit(user, auditAction, parsed.data as Record<string, unknown>);
      if (typeof result === "string") return { ok: true, message: result };
      if (result && !result.ok && !result.values) return { ...result, values: formValues(form) };
      return result ?? { ok: true };
    } catch (err) {
      if (err instanceof ActionError) return { ok: false, error: err.message, fields: err.fields, values: formValues(form) };
      console.error(err);
      return { ok: false, error: "Something went wrong saving that. Nothing was changed. Please try again.", values: formValues(form) };
    }
  };
}

/**
 * FormData → plain object. Repeated names become arrays; the `$action` and
 * Next.js internal fields are dropped. Values are strings, so schemas should
 * use z.coerce for numbers and `checkbox()` for tick boxes.
 */
export function formToObject(form: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (key.startsWith("$")) continue;
    if (value instanceof File) continue;
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  }
  return out;
}

/** A checkbox input: "on" (or any value) when ticked, absent when not. */
export const checkbox = () =>
  z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((v) => v === true || (typeof v === "string" && v !== "" && v !== "false" && v !== "off"));

/** A multi-value field (checkbox group): always an array of strings. */
export const multi = () =>
  z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]));

/** Optional text: "" becomes undefined. */
export const optionalText = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

/** A URL that must be http(s), or empty. */
export const httpUrl = () =>
  z
    .string()
    .trim()
    .max(1000)
    .refine((v) => v === "" || /^https?:\/\//i.test(v), "Links must start with http:// or https://")
    .transform((v) => v || null);
