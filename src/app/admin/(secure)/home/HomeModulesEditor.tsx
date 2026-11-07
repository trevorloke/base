"use client";

import { useActionState, useRef, useState } from "react";
import { Notice } from "@/components/admin/Notice";
import { SubmitButton } from "@/components/admin/SubmitButton";
import { BUILT_IN_MODULES, CUSTOM_TONES, moduleLabel, type HomeModule } from "@/lib/home-modules";
import type { ActionState } from "@/lib/server/actions";
import { saveSettings } from "../settings/actions";
import "./home.css";

const TONE_LABELS: Record<HomeModule["tone"], string> = { white: "White", grey: "Light grey", navy: "Navy", yellow: "Yellow" };

const newTextBlock = (): HomeModule => ({ kind: "custom", enabled: true, heading: "", body: "", buttonLabel: "", buttonHref: "", tone: "white" });

export function HomeModulesEditor({ initial }: { initial: HomeModule[] }) {
  const [modules, setModules] = useState<HomeModule[]>(initial);
  const [state, action] = useActionState<ActionState, FormData>(saveSettings, null);
  const listRef = useRef<HTMLOListElement>(null);

  const update = (i: number, patch: Partial<HomeModule>) => setModules((list) => list.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  // Keep keyboard focus on the button that was pressed, now on the moved row.
  const move = (i: number, by: -1 | 1, which: "up" | "down") => {
    const to = i + by;
    if (to < 0 || to >= modules.length) return;
    setModules((list) => {
      const next = [...list];
      [next[i], next[to]] = [next[to], next[i]];
      return next;
    });
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>(`[data-row="${to}"] [data-move="${which}"]`)?.focus());
  };
  const remove = (i: number) => setModules((list) => list.filter((_, j) => j !== i));
  const add = () => {
    setModules((list) => [...list, newTextBlock()]);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLInputElement>("li:last-child input[type=text]")?.focus());
  };

  const shown = modules.filter((m) => m.enabled).length;

  return (
    <form action={action} className="stack" style={{ gap: 20 }}>
      <input type="hidden" name="key" value="homeModules" />
      <input type="hidden" name="value" value={JSON.stringify({ modules })} />
      <Notice state={state} />
      <p className="small" aria-live="polite">
        {shown} of {modules.length} modules shown, top to bottom in this order.
      </p>
      <ol className="home-modules" ref={listRef}>
        {modules.map((m, i) => {
          const builtIn = BUILT_IN_MODULES.find((b) => b.kind === m.kind);
          const name = moduleLabel(m);
          const id = `module-${i}`;
          return (
            <li key={`${m.kind}-${i}`} data-row={i} className={`home-module ${m.enabled ? "" : "is-hidden"}`}>
              <div className="home-module-head">
                <span className="home-module-number" aria-hidden="true">
                  {i + 1}
                </span>
                <div className="home-module-title">
                  <strong>{name}</strong>
                  <span className="small">{builtIn ? builtIn.description : "Your own heading, text and button."}</span>
                </div>
                <label className="home-module-toggle">
                  <input type="checkbox" checked={m.enabled} onChange={(e) => update(i, { enabled: e.target.checked })} />
                  Show<span className="visually-hidden"> {name} on the home page</span>
                </label>
                <div className="home-module-actions">
                  <button type="button" className="btn btn--outline btn--sm" data-move="up" onClick={() => move(i, -1, "up")} disabled={i === 0} aria-label={`Move ${name} up`}>
                    ↑
                  </button>
                  <button type="button" className="btn btn--outline btn--sm" data-move="down" onClick={() => move(i, 1, "down")} disabled={i === modules.length - 1} aria-label={`Move ${name} down`}>
                    ↓
                  </button>
                  {m.kind === "custom" && (
                    <button type="button" className="btn btn--outline btn--sm is-danger" onClick={() => remove(i)} aria-label={`Remove ${name}`}>
                      Remove
                    </button>
                  )}
                </div>
              </div>
              {m.kind === "custom" && (
                <div className="home-module-fields">
                  <div className="field">
                    <label htmlFor={`${id}-heading`}>Heading</label>
                    <input id={`${id}-heading`} type="text" className="input" maxLength={120} value={m.heading} onChange={(e) => update(i, { heading: e.target.value })} />
                  </div>
                  <div className="field">
                    <label htmlFor={`${id}-body`}>Text</label>
                    <textarea id={`${id}-body`} className="input" rows={4} maxLength={4000} value={m.body} onChange={(e) => update(i, { body: e.target.value })} aria-describedby={`${id}-body-hint`} />
                    <p id={`${id}-body-hint`} className="small">
                      Markdown works: **bold**, *italics*, [a link](https://example.com), and a blank line between paragraphs.
                    </p>
                  </div>
                  <div className="home-module-row">
                    <div className="field">
                      <label htmlFor={`${id}-button`}>Button text (optional)</label>
                      <input id={`${id}-button`} type="text" className="input" maxLength={40} value={m.buttonLabel} onChange={(e) => update(i, { buttonLabel: e.target.value })} />
                    </div>
                    <div className="field">
                      <label htmlFor={`${id}-href`}>Button link</label>
                      <input id={`${id}-href`} type="text" className="input" maxLength={500} placeholder="/volunteer or https://…" value={m.buttonHref} onChange={(e) => update(i, { buttonHref: e.target.value })} />
                    </div>
                    <div className="field">
                      <label htmlFor={`${id}-tone`}>Background</label>
                      <select id={`${id}-tone`} className="input" value={m.tone} onChange={(e) => update(i, { tone: e.target.value as HomeModule["tone"] })}>
                        {CUSTOM_TONES.map((t) => (
                          <option key={t} value={t}>
                            {TONE_LABELS[t]}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <div className="btn-row">
        <button type="button" className="btn btn--outline" onClick={add}>
          + Add a text block
        </button>
        <SubmitButton pendingText="Saving…">Save the home page</SubmitButton>
      </div>
    </form>
  );
}
