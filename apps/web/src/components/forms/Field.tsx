"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type MouseEvent,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
} from "react";
import { CONSENT_WORDING, type ConsentWordingKey } from "@/lib/consent-wording";
import { formatPostalCodeInput, postalCodePreview } from "@/lib/postal";
import { useTracking } from "./tracking";
import type { FieldErrors } from "./useApiForm";
import "./forms.css";

// The building blocks of every public form. Each field wires aria-invalid and
// aria-describedby itself, so a form only has to pass the error message.

type Common = { id: string; label: ReactNode; error?: string; hint?: ReactNode; className?: string };

function describedBy(id: string, error?: string, hint?: ReactNode, extra?: string): string | undefined {
  const ids = [hint ? `${id}-hint` : null, extra ?? null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length ? ids.join(" ") : undefined;
}

function FieldError({ id, error }: { id: string; error?: string }) {
  return error ? (
    <p className="field-error" id={`${id}-error`}>
      {error}
    </p>
  ) : null;
}

function FieldHint({ id, hint }: { id: string; hint?: ReactNode }) {
  return hint ? (
    <p className="field-hint" id={`${id}-hint`}>
      {hint}
    </p>
  ) : null;
}

export function TextField({
  id,
  label,
  error,
  hint,
  className,
  inputClassName,
  ...input
}: Common & { inputClassName?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className={`field ${className ?? ""}`}>
      <label htmlFor={id}>{label}</label>
      <FieldHint id={id} hint={hint} />
      <input
        id={id}
        className={`input ${inputClassName ?? ""}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
        {...input}
      />
      <FieldError id={id} error={error} />
    </div>
  );
}

export function SelectField({
  id,
  label,
  error,
  hint,
  className,
  children,
  ...select
}: Common & SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <div className={`field ${className ?? ""}`}>
      <label htmlFor={id}>{label}</label>
      <FieldHint id={id} hint={hint} />
      <select id={id} className="input" aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, error, hint)} {...select}>
        {children}
      </select>
      <FieldError id={id} error={error} />
    </div>
  );
}

/** A tick box. `id` is required so error-summary links and labels can point at it. */
export function Checkbox({
  id: givenId,
  name,
  children,
  error,
  hint,
  ...input
}: { id?: string; name: string; children: ReactNode; error?: string; hint?: ReactNode } & Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "name" | "type">) {
  const generatedId = useId();
  const id = givenId ?? `${name}-${generatedId.replace(/:/g, "")}`;
  return (
    <div className="field field--check">
      <label className="check" htmlFor={id}>
        <input type="checkbox" id={id} name={name} aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, error, hint)} {...input} />
        <span>{children}</span>
      </label>
      <FieldHint id={id} hint={hint} />
      <FieldError id={id} error={error} />
    </div>
  );
}

/**
 * Express consent to email updates or to texts, with the exact wording the
 * consent ledger records (CONSENT_WORDING). Never pre-checked: the person
 * ticks it themselves or it stays off.
 */
export function ConsentCheckbox({ id, kind, name, error, hint }: { id: string; kind: ConsentWordingKey; name?: string; error?: string; hint?: ReactNode }) {
  return (
    <Checkbox id={id} name={name ?? (kind === "updates" ? "updatesConsent" : "smsConsent")} error={error} hint={hint} defaultChecked={false}>
      {CONSENT_WORDING[kind]}
    </Checkbox>
  );
}

/**
 * A postal-code input that upper-cases, inserts the space ("V3S1A1" → "V3S 1A1")
 * and previews the town centre ("That’s Newton") as the person types.
 */
export function PostalCodeField({
  id,
  name = "postalCode",
  label = "Postal code",
  error,
  hint,
  required,
  defaultValue = "",
  onValueChange,
  className,
  preview = true,
  autoComplete = "postal-code",
}: {
  id: string;
  name?: string;
  label?: ReactNode;
  error?: string;
  hint?: ReactNode;
  required?: boolean;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  className?: string;
  preview?: boolean;
  autoComplete?: string;
}) {
  const [value, setValue] = useState(() => formatPostalCodeInput(defaultValue));
  const previewText = preview ? postalCodePreview(value) : null;
  const previewId = preview ? `${id}-preview` : undefined;
  return (
    <div className={`field ${className ?? ""}`}>
      <label htmlFor={id}>{label}</label>
      <FieldHint id={id} hint={hint} />
      <input
        id={id}
        name={name}
        className="input"
        value={value}
        required={required}
        maxLength={7}
        placeholder="V3T 1A1"
        inputMode="text"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint, previewId)}
        onChange={(e) => {
          const next = formatPostalCodeInput(e.target.value);
          setValue(next);
          onValueChange?.(next);
        }}
      />
      {preview && (
        <p id={previewId} className="postal-preview" aria-live="polite">
          {previewText ?? ""}
        </p>
      )}
      <FieldError id={id} error={error} />
    </div>
  );
}

export function Alert({ children, tone = "error" }: { children: ReactNode; tone?: "error" | "note" }) {
  return (
    <div role={tone === "error" ? "alert" : "note"} className={`alert ${tone === "note" ? "alert--note" : ""}`}>
      <span aria-hidden="true" className="alert-icon">
        !
      </span>
      <span>{children}</span>
    </div>
  );
}

/** Hidden from people, irresistible to bots. Submissions that fill it are dropped. */
export function Honeypot() {
  return (
    <div className="honeypot" aria-hidden="true">
      <label>
        Website
        <input type="text" name="website" tabIndex={-1} autoComplete="off" defaultValue="" />
      </label>
    </div>
  );
}

/**
 * Hidden `source`, `ref` and `locale` fields, filled on mount from the query
 * string (?source=&ref=), the tracking cookie set by share links, and the
 * page language. Pass `locale={false}` for routes whose schema has no locale.
 */
export function TrackingFields({ locale = true }: { locale?: boolean }) {
  const t = useTracking();
  return (
    <>
      <input type="hidden" name="source" value={t.source ?? ""} />
      <input type="hidden" name="ref" value={t.ref ?? ""} />
      {locale && <input type="hidden" name="locale" value={t.locale ?? ""} />}
    </>
  );
}

/**
 * The input for an error key: by name first, then by id (for controls that
 * have no name, like the custom amount box), then by data-field (the human
 * check, which is not a form field).
 */
function resolveField(form: HTMLFormElement, name: string): HTMLElement | null {
  const item = form.elements.namedItem(name);
  if (item instanceof HTMLElement) return item;
  if (item instanceof RadioNodeList) {
    const first = item.item(0);
    return first instanceof HTMLElement ? first : null;
  }
  const byId = form.querySelector(`#${CSS.escape(name)}`) ?? form.querySelector(`[data-field="${CSS.escape(name)}"]`);
  return byId instanceof HTMLElement ? byId : null;
}

function labelFor(el: HTMLElement): string {
  const labelled = el as HTMLElement & { labels?: NodeListOf<HTMLLabelElement> };
  const text = labelled.labels?.[0]?.textContent?.replace(/\s+/g, " ").trim() ?? el.getAttribute("aria-label") ?? "";
  return text.length > 60 ? text.slice(0, 59).replace(/\s\S*$/, "") + "…" : text;
}

/**
 * The list of what went wrong, shown above the submit button after a failed
 * submit. The hook focuses it; each item links to its field and moves focus
 * there when activated.
 */
export function ErrorSummary({
  ref,
  error,
  fields,
  title = "There’s a problem with the form",
}: {
  ref?: Ref<HTMLDivElement>;
  error: string | null;
  fields: FieldErrors;
  title?: string;
}) {
  const localRef = useRef<HTMLDivElement | null>(null);
  const [targets, setTargets] = useState<Record<string, { id: string; label: string }>>({});
  const names = Object.keys(fields);
  const key = names.join("|");

  useLayoutEffect(() => {
    const form = localRef.current?.closest("form");
    if (!form) return;
    const next: Record<string, { id: string; label: string }> = {};
    for (const name of key ? key.split("|") : []) {
      const el = resolveField(form, name);
      if (el?.id) next[name] = { id: el.id, label: labelFor(el) };
    }
    setTargets(next);
  }, [key]);

  if (!error && names.length === 0) return null;

  const setRefs = (node: HTMLDivElement | null) => {
    localRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  };

  const focusField = (e: MouseEvent<HTMLAnchorElement>, id: string) => {
    e.preventDefault();
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.focus();
  };

  const message = error ?? "Please check the highlighted fields.";
  return (
    <div ref={setRefs} role="alert" tabIndex={-1} className="error-summary">
      <h3>{title}</h3>
      <p>{message}</p>
      {names.length > 0 && (
        <ul>
          {names.map((name) => {
            const t = targets[name];
            const text = t?.label ? `${t.label}: ${fields[name]}` : fields[name];
            return (
              <li key={name}>
                {t ? (
                  <a href={`#${t.id}`} onClick={(e) => focusField(e, t.id)}>
                    {text}
                  </a>
                ) : (
                  text
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** A polite live region that stays mounted across the form → success swap, so the announcement lands. */
export function LiveRegion({ message }: { message: string }) {
  return (
    <div className="visually-hidden" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}

/**
 * The confirmation shown in place of the form. Focus moves to its heading so
 * keyboard and screen-reader users know the submit worked.
 */
export function SuccessCard({ title, children, className, style }: { title: ReactNode; children?: ReactNode; className?: string; style?: CSSProperties }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <div role="status" className={`success-card ${className ?? ""}`} style={style}>
      <h3 ref={heading} tabIndex={-1}>
        {title}
      </h3>
      {children}
    </div>
  );
}

/**
 * The submit button. While sending it reads "Sending…" and is aria-disabled
 * and aria-busy rather than disabled, so focus never drops off it.
 */
export function SubmitButton({
  pending,
  disabled,
  pendingLabel = "Sending…",
  className = "btn btn--accent btn--lg",
  children,
  onClick,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { pending: boolean; pendingLabel?: string }) {
  const blocked = pending || Boolean(disabled);
  return (
    <button
      type="submit"
      className={className}
      aria-busy={pending || undefined}
      aria-disabled={blocked || undefined}
      onClick={(e) => {
        if (blocked) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      {...rest}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
