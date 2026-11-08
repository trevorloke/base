import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { suiteLinks, useSuite } from "../lib/suite";

/**
 * The Base switcher (SUITE.md, "The app switcher"): a "Base" wordmark in the top bar that opens a short menu of this
 * client's apps — field and ground in Base Ground, Base Air (here), Base Web's admin when it is set up.
 *
 * A real button with aria-haspopup/aria-expanded; the menu takes the arrow keys, Home/End, Escape (back to the
 * button) and Tab (closes); items are plain links, so they open in a new tab with the usual modifier keys.
 */
export function BaseSwitcher() {
  const suite = useSuite();
  const links = suiteLinks(suite);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const items = useRef<(HTMLAnchorElement | null)[]>([]);
  const focusOnOpen = useRef<"first" | "last" | null>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const target = focusOnOpen.current === "last" ? items.current[links.length - 1] : focusOnOpen.current === "first" ? items.current[0] : null;
    target?.focus();
    focusOnOpen.current = null;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, links.length]);

  const openWith = (where: "first" | "last" | null) => {
    if (open) {
      // Already open (opened with the mouse): just move into it.
      if (where) items.current[where === "first" ? 0 : links.length - 1]?.focus();
      return;
    }
    focusOnOpen.current = where;
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  const onButtonKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openWith("first");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      openWith("last");
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      close(true);
    }
  };

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = items.current.filter((x): x is HTMLAnchorElement => !!x);
    const at = list.indexOf(document.activeElement as HTMLAnchorElement);
    const move = (i: number) => list[(i + list.length) % list.length]?.focus();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(at + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(at - 1);
        break;
      case "Home":
        e.preventDefault();
        move(0);
        break;
      case "End":
        e.preventDefault();
        move(list.length - 1);
        break;
      case "Escape":
        e.preventDefault();
        close(true);
        break;
      case "Tab":
        close(false);
        break;
    }
  };

  return (
    <div className="base-switcher" ref={root}>
      <button
        ref={button}
        type="button"
        className="base-switcher-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="Base apps: you are in Base Air"
        onClick={() => (open ? close(false) : openWith(null))}
        onKeyDown={onButtonKey}
      >
        <span className="base-wordmark">Base</span>
        <span className="base-switcher-app">Air</span>
        <svg className="base-switcher-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div id={menuId} className="base-switcher-menu" role="menu" aria-label="Base apps" onKeyDown={onMenuKey}>
          {links.map((l, i) => (
            <a
              key={l.id}
              ref={(el) => {
                items.current[i] = el;
              }}
              role="menuitem"
              href={l.href}
              tabIndex={-1}
              className={`base-switcher-item${l.current ? " is-current" : ""}`}
              aria-current={l.current ? "page" : undefined}
              onClick={() => setOpen(false)}
            >
              <span className="base-switcher-name">
                {l.name}
                {l.face ? <span className="base-switcher-face"> · {l.face}</span> : null}
              </span>
              <span className="base-switcher-detail">{l.current ? "You are here" : l.detail}</span>
            </a>
          ))}
          {links.length === 1 ? <p className="base-switcher-note">Base Ground isn't linked to this Base Air yet.</p> : null}
        </div>
      ) : null}
    </div>
  );
}
