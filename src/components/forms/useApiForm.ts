"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { fieldErrors } from "@/lib/validation";
import { HUMAN_NOT_READY, humanHeaders, useHumanControl } from "./human";

export type FieldErrors = Record<string, string>;

export type ApiFormOptions = {
  /**
   * The route's schema, run on the client first so a missed field shows at
   * once without a round trip. The route validates again regardless.
   */
  schema?: z.ZodType;
};

/**
 * POST JSON to one of our API routes and track pending, error and
 * field-error state. After a failed submit, focus moves to the error summary
 * (`summaryRef`) so keyboard and screen-reader users land on what went wrong.
 *
 * `human` is the controller for the form's human check: put
 * `<HumanCheck control={form.human} />` before the submit button and submit
 * sends its token as x-human-token (waiting a few seconds for one if needed),
 * then resets it after every answer. Without the site key it does nothing.
 */
export function useApiForm<TResult = { ok: true }>(url: string, options: ApiFormOptions = {}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<FieldErrors>({});
  const [failures, setFailures] = useState(0);
  const summaryRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef(false);
  const schema = options.schema;
  const human = useHumanControl();

  useEffect(() => {
    if (failures > 0) summaryRef.current?.focus();
  }, [failures]);

  const fail = useCallback((message: string, errors: FieldErrors = {}) => {
    setError(message);
    setFields(errors);
    setFailures((n) => n + 1);
  }, []);

  const submit = useCallback(
    async (body: unknown): Promise<TResult | null> => {
      if (pendingRef.current) return null;
      if (schema) {
        // The honeypot is the server's business: a filled one must get the
        // server's fake success, not a client-side error pointing at a hidden field.
        const { website: _website, ...visible } = (body ?? {}) as Record<string, unknown>;
        void _website;
        const result = schema.safeParse(visible);
        if (!result.success) {
          fail("Please check the highlighted fields.", fieldErrors(result.error));
          return null;
        }
      }
      pendingRef.current = true;
      setPending(true);
      setError(null);
      setFields({});
      let tokenUsed = false;
      try {
        const headers = await humanHeaders(human);
        if (!headers) {
          // The widget may still be working (or waiting for a tap): leave it be.
          fail(HUMAN_NOT_READY, { human: HUMAN_NOT_READY });
          return null;
        }
        tokenUsed = true;
        const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          fail(data.error ?? "Something went wrong. Please try again.", data.fields ?? {});
          return null;
        }
        return data as TResult;
      } catch {
        fail("We couldn't reach the server. Check your connection and try again.");
        return null;
      } finally {
        // A token works once: whatever the answer, the next submit needs a fresh one.
        if (tokenUsed) human.reset();
        pendingRef.current = false;
        setPending(false);
      }
    },
    [url, schema, fail, human],
  );

  return { submit, pending, error, fields, summaryRef, fail, human };
}

/** Read a form's named inputs, with checkboxes as booleans and grouped checkboxes as arrays. */
export function readForm(form: HTMLFormElement): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const el of Array.from(form.elements)) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) || !el.name) continue;
    if (el instanceof HTMLInputElement && el.type === "checkbox") {
      if (el.dataset.group) {
        const list = (out[el.name] as string[] | undefined) ?? [];
        if (el.checked) list.push(el.value);
        out[el.name] = list;
      } else {
        out[el.name] = el.checked;
      }
    } else if (el instanceof HTMLInputElement && el.type === "radio") {
      if (el.checked) out[el.name] = el.value;
      else out[el.name] ??= "";
    } else {
      out[el.name] = el.value;
    }
  }
  return out;
}
