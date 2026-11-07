"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { HumanControl, HumanWidget } from "./human";

// The human check on public forms: a Cloudflare Turnstile widget. Most people
// never see it (appearance "interaction-only"); Cloudflare shows a box to tick
// only when it isn't sure. Its token goes to our server with the form (see
// useApiForm), and the server asks Cloudflare whether it is real. Without
// NEXT_PUBLIC_TURNSTILE_SITE_KEY this renders nothing and the form sends no
// token.

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

type RenderOptions = {
  sitekey: string;
  appearance: "always" | "execute" | "interaction-only";
  language: string;
  callback: (token: string) => void;
  "expired-callback": () => void;
  "error-callback": () => void;
  "refresh-expired": "auto" | "manual" | "never";
  "response-field": boolean;
};
type Turnstile = {
  render(container: HTMLElement, options: RenderOptions): string | undefined;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
};

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let loading: Promise<Turnstile> | null = null;

/** Load Cloudflare's script once per page, however many forms ask. */
function loadTurnstile(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile did not start")));
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error("Turnstile could not load"));
    };
    document.head.appendChild(script);
  });
  return loading;
}

// The site's languages that Turnstile also speaks; anything else lets it pick.
const LANGUAGES: Record<string, string> = { en: "en", hi: "hi", tl: "tl", fil: "tl", "zh-hans": "zh-cn", "zh-cn": "zh-cn", "zh-hant": "zh-tw", "zh-tw": "zh-tw", fr: "fr", es: "es" };

/** Turnstile's language for the page's `<html lang>`. */
export function turnstileLanguage(lang: string | null | undefined): string {
  const tag = (lang ?? "").trim().toLowerCase();
  return LANGUAGES[tag] ?? LANGUAGES[tag.split("-")[0]] ?? "auto";
}

/**
 * Put it inside the form, before the submit button:
 *   const form = useApiForm(url); … <HumanCheck control={form.human} error={form.fields.human} />
 */
export function HumanCheck({ control, error }: { control: HumanControl; error?: string }) {
  const id = `human-${useId().replace(/:/g, "")}`;
  const box = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!SITE_KEY || !box.current) return;
    const el = box.current;
    let widgetId: string | undefined;
    let token: string | null = null;
    let gone = false;
    const listeners = new Set<(t: string) => void>();
    const widget: HumanWidget = {
      token: () => token,
      onToken(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      reset() {
        token = null;
        if (widgetId && window.turnstile) window.turnstile.reset(widgetId);
      },
    };
    const detach = control.attach(widget);
    loadTurnstile()
      .then((ts) => {
        if (gone) return;
        widgetId = ts.render(el, {
          sitekey: SITE_KEY,
          appearance: "interaction-only",
          language: turnstileLanguage(document.documentElement.lang),
          callback: (t) => {
            token = t;
            setProblem(null);
            for (const l of [...listeners]) l(t);
          },
          "expired-callback": () => {
            token = null;
          },
          "error-callback": () => {
            token = null;
            setProblem("The check that you're a person ran into a problem. Reload the page and try again.");
          },
          "refresh-expired": "auto",
          // The token travels in a header, never as a form field.
          "response-field": false,
        });
      })
      .catch(() => {
        if (!gone) setProblem("The check that you're a person couldn't load. Check your connection (or allow challenges.cloudflare.com), then reload the page.");
      });
    return () => {
      gone = true;
      detach();
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [control]);

  if (!SITE_KEY) return null;
  const message = error ?? problem;
  return (
    <div id={id} data-field="human" role="group" aria-label="Check that you're a person" tabIndex={-1} className="human-check" aria-describedby={message ? `${id}-error` : undefined}>
      <div ref={box} />
      {message && (
        <p className="field-error" id={`${id}-error`}>
          {message}
        </p>
      )}
    </div>
  );
}
