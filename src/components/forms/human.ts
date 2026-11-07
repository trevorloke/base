"use client";

import { useMemo } from "react";

// The link between a form's submit and its HumanCheck widget. The widget
// attaches itself when it renders (only when the site key is set); submit
// asks for a token, sends it as x-human-token, and resets the widget after
// every answer, because a Turnstile token can be used once.

/** The header the server reads (HUMAN_TOKEN_HEADER in src/lib/server/api.ts). */
export const HUMAN_HEADER = "x-human-token";
/** How long submit waits for a token that isn't ready yet. */
export const HUMAN_WAIT_MS = 5_000;
export const HUMAN_NOT_READY = "The check that you're a person hasn't finished. Please wait a moment, then try again.";

export type HumanWidget = {
  /** The current token, if the widget has one. */
  token(): string | null;
  /** Called with each new token; returns an unsubscribe. */
  onToken(listener: (token: string) => void): () => void;
  /** Throw the used token away and get a fresh one. */
  reset(): void;
};

export type HumanControl = {
  /** For HumanCheck: plug the widget in; returns the unplug. */
  attach(widget: HumanWidget): () => void;
  /** Whether a widget is on the form (false when the check is off). */
  active(): boolean;
  /** The token, waiting up to `waitMs` for one; null when there is no widget or none came. */
  token(waitMs?: number): Promise<string | null>;
  reset(): void;
};

export function createHumanControl(): HumanControl {
  let widget: HumanWidget | null = null;
  return {
    attach(w) {
      widget = w;
      return () => {
        if (widget === w) widget = null;
      };
    },
    active: () => widget !== null,
    async token(waitMs = HUMAN_WAIT_MS) {
      const w = widget;
      if (!w) return null;
      const now = w.token();
      if (now) return now;
      return new Promise<string | null>((resolve) => {
        const stop = w.onToken((t) => {
          clearTimeout(timer);
          stop();
          resolve(t);
        });
        const timer = setTimeout(() => {
          stop();
          resolve(w.token());
        }, waitMs);
      });
    },
    reset() {
      widget?.reset();
    },
  };
}

/** One controller for the life of a form. */
export function useHumanControl(): HumanControl {
  return useMemo(() => createHumanControl(), []);
}

/** Headers for a JSON POST, with the human-check token when the form has the widget. `null` means: no token came, don't send. */
export async function humanHeaders(control: HumanControl): Promise<Record<string, string> | null> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!control.active()) return headers;
  const token = await control.token();
  if (!token) return null;
  headers[HUMAN_HEADER] = token;
  return headers;
}
