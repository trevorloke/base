"use client";

import { useActionState, useEffect, useState } from "react";
import { resetSettings, saveSettings } from "@/app/admin/(secure)/settings/actions";
import { fieldError, Notice } from "@/components/admin/Notice";
import { SubmitButton } from "@/components/admin/SubmitButton";
import type { ActionState } from "@/lib/server/actions";
import { humanize } from "./fields";
import { ImageControl, type ImageValue } from "./ImageField";
import { emptyValue, setAtPath, toJson, type FieldSpec } from "./schema-form";

type Path = (string | number)[];

/**
 * A form generated from a section's schema description. The state is the
 * section's value itself; on submit it is sent as one JSON field, which the
 * action validates with the same zod schema the public site reads through.
 */
export function SettingsForm({ sectionKey, spec, initial, defaults, customized }: { sectionKey: string; spec: FieldSpec; initial: unknown; defaults: unknown; customized: boolean }) {
  const [value, setValue] = useState<unknown>(initial);
  const [state, action] = useActionState(saveSettings, null);
  const [resetState, resetAction] = useActionState(resetSettings, null);
  const update = (path: Path, next: unknown) => setValue((current: unknown) => setAtPath(current, path, next));
  // After a reset the server shows the defaults again; the form follows.
  useEffect(() => {
    if (resetState?.ok) setValue(defaults);
  }, [resetState, defaults]);

  return (
    <div className="stack" style={{ gap: 24 }}>
      <form action={action} className="cms-form">
        <input type="hidden" name="key" value={sectionKey} />
        <input type="hidden" name="value" value={JSON.stringify(toJson(spec, value) ?? {})} />
        <Field spec={spec} path={[]} label="" value={value} update={update} state={state} />
        <Notice state={state} />
        <div className="cms-publish">
          <SubmitButton className="btn btn--red">Save changes</SubmitButton>
        </div>
      </form>
      <form action={resetAction} className="cms-danger">
        <input type="hidden" name="key" value={sectionKey} />
        <p>
          {customized ? "This section has been customized. Resetting it removes every change here and shows the built-in text again." : "This section is showing the built-in defaults."}
        </p>
        <SubmitButton className="btn btn--danger" confirm="Reset this section to the defaults? Every change made here will be lost." pendingText="Resetting…" disabled={!customized} aria-disabled={!customized}>
          Reset to defaults
        </SubmitButton>
        <Notice state={resetState} />
      </form>
    </div>
  );
}

function idFor(path: Path): string {
  return `sf-${path.map(String).join("-") || "root"}`;
}

function Field({ spec, path, label, description, value, update, state }: { spec: FieldSpec; path: Path; label: string; description?: string; value: unknown; update: (path: Path, next: unknown) => void; state: ActionState }) {
  const id = idFor(path);
  const error = fieldError(state, path.join("."));
  const describedBy = [description ? `${id}-desc` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;

  switch (spec.kind) {
    case "text": {
      const text = typeof value === "string" ? value : "";
      const common = {
        id,
        className: "input",
        value: text,
        maxLength: spec.max,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": describedBy,
        onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => update(path, e.target.value),
      };
      return (
        <div className="field">
          <label htmlFor={id}>{label}</label>
          {description && <Desc id={id} text={description} />}
          {spec.multiline ? <textarea {...common} className="input input--area" rows={Math.min(10, Math.max(3, Math.ceil((spec.max ?? 300) / 120)))} /> : <input {...common} type={spec.format === "email" ? "email" : "text"} />}
          {error && <Err id={id} text={error} />}
        </div>
      );
    }
    case "number":
      return (
        <div className="field">
          <label htmlFor={id}>{label}</label>
          {description && <Desc id={id} text={description} />}
          <input
            id={id}
            type="number"
            className="input"
            step={spec.integer ? 1 : "any"}
            min={spec.min}
            max={spec.max}
            value={typeof value === "number" ? value : typeof value === "string" ? value : ""}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            onChange={(e) => update(path, e.target.value === "" ? "" : Number(e.target.value))}
            style={{ maxWidth: 220 }}
          />
          {error && <Err id={id} text={error} />}
        </div>
      );
    case "boolean":
      return (
        <div>
          <label className="check" htmlFor={id}>
            <input id={id} type="checkbox" checked={value === true} aria-describedby={describedBy} onChange={(e) => update(path, e.target.checked)} />
            <span>{label}</span>
          </label>
          {description && <Desc id={id} text={description} />}
          {error && <Err id={id} text={error} />}
        </div>
      );
    case "enum":
      return (
        <div className="field">
          <label htmlFor={id}>{label}</label>
          {description && <Desc id={id} text={description} />}
          <select id={id} className="input" value={typeof value === "string" ? value : ""} aria-invalid={error ? true : undefined} aria-describedby={describedBy} onChange={(e) => update(path, e.target.value)} style={{ maxWidth: 320 }}>
            {spec.optional && <option value="">—</option>}
            {spec.options.map((o) => (
              <option key={o} value={o}>
                {humanize(o)}
              </option>
            ))}
          </select>
          {error && <Err id={id} text={error} />}
        </div>
      );
    case "image": {
      const img = (value ?? { url: "", alt: "" }) as ImageValue;
      return (
        <div className="field">
          <span className="field-label">{label}</span>
          {description && <Desc id={id} text={description} />}
          <ImageControl idPrefix={id} value={img} onChange={(next) => update(path, next)} altRequired={false} urlError={fieldError(state, [...path, "url"].join("."))} altError={fieldError(state, [...path, "alt"].join("."))} label={label} />
          {error && <Err id={id} text={error} />}
        </div>
      );
    }
    case "list": {
      const items = Array.isArray(value) ? value : [];
      const singular = (label.replace(/s$/i, "") || "item").toLowerCase();
      const canAdd = spec.max === undefined || items.length < spec.max;
      const canRemove = spec.min === undefined || items.length > spec.min;
      const move = (from: number, to: number) => {
        if (to < 0 || to >= items.length) return;
        const next = items.slice();
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        update(path, next);
      };
      return (
        <fieldset className="sf-list" aria-describedby={describedBy}>
          <legend>
            {label} ({items.length}
            {spec.max ? ` of ${spec.max}` : ""})
          </legend>
          {description && <Desc id={id} text={description} />}
          {error && <Err id={id} text={error} />}
          {items.length === 0 ? <p className="small">None yet.</p> : null}
          <ol className="sf-items">
            {items.map((item, i) => (
              <li key={i} className="sf-item">
                <div className="sf-item-body">
                  <Field spec={spec.item} path={[...path, i]} label={`${humanize(singular)} ${i + 1}`} value={item} update={update} state={state} />
                </div>
                <div className="sf-item-tools">
                  <button type="button" className="btn btn--outline" onClick={() => move(i, i - 1)} disabled={i === 0} aria-label={`Move ${singular} ${i + 1} up`}>
                    ↑ Up
                  </button>
                  <button type="button" className="btn btn--outline" onClick={() => move(i, i + 1)} disabled={i === items.length - 1} aria-label={`Move ${singular} ${i + 1} down`}>
                    ↓ Down
                  </button>
                  <button type="button" className="btn btn--danger" onClick={() => update(path, items.filter((_, j) => j !== i))} disabled={!canRemove} aria-label={`Remove ${singular} ${i + 1}`}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ol>
          <div>
            <button type="button" className="btn btn--outline btn--sm" onClick={() => update(path, [...items, emptyValue(spec.item)])} disabled={!canAdd}>
              Add {singular}
            </button>
          </div>
        </fieldset>
      );
    }
    case "group": {
      const obj = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
      const children = spec.fields.map((f) => (
        <Field key={f.key} spec={f.spec} path={[...path, f.key]} label={f.label} description={f.description} value={obj[f.key]} update={update} state={state} />
      ));
      if (path.length === 0) return <>{children}</>;
      return (
        <fieldset className="sf-group" aria-describedby={describedBy}>
          <legend>{label}</legend>
          {description && <Desc id={id} text={description} />}
          {error && <Err id={id} text={error} />}
          {children}
        </fieldset>
      );
    }
    default:
      return (
        <div className="field">
          <label htmlFor={id}>{label} (JSON)</label>
          <textarea id={id} className="input input--area" value={typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2)} onChange={(e) => update(path, e.target.value)} aria-describedby={describedBy} />
          {error && <Err id={id} text={error} />}
        </div>
      );
  }
}

function Desc({ id, text }: { id: string; text: string }) {
  return (
    <p className="sf-desc" id={`${id}-desc`}>
      {text}
    </p>
  );
}

function Err({ id, text }: { id: string; text: string }) {
  return (
    <p className="field-error" id={`${id}-error`}>
      {text}
    </p>
  );
}

