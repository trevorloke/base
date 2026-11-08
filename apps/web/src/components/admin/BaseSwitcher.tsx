"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { SuiteApp } from "@/lib/suite";
import "./base-suite.css";

/**
 * The small "Base" menu in the admin's top bar: the client's other apps.
 * A disclosure button with a list of links (not an ARIA menu, so links
 * behave as links): Escape closes it and returns focus to the button, as
 * does a click or focus outside it.
 */
export function BaseSwitcher({ apps }: { apps: SuiteApp[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  return (
    <div className="base-switcher" ref={root}>
      <button ref={button} type="button" className="base-switcher__button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        <span className="base-wordmark">Base</span>
        <span className="visually-hidden">: switch app</span>
        <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" className="base-switcher__chevron">
          <path d="M1.5 3.5 5 7l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <ul id={id} className="base-switcher__list" hidden={!open}>
        {apps.map((app) => (
          <li key={app.id}>
            <a href={app.href} aria-current={app.current ? "page" : undefined} className="base-switcher__item" onClick={() => setOpen(false)}>
              <span className="base-switcher__name">
                <span className="base-wordmark base-wordmark--small">Base</span> {app.label}
              </span>
              <span className="base-switcher__desc">{app.description}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
