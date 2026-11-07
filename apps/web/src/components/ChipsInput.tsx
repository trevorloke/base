import { useRef, useState, type KeyboardEvent } from "react";

/**
 * A list of short words as removable chips. Enter or a comma adds what is typed (a pasted list is split on commas
 * and new lines); leaving the field adds it too, so nothing typed is lost on Save. Backspace in the empty field
 * takes the last one back.
 */
export function ChipsInput({
  id,
  label,
  what,
  values,
  onChange,
  placeholder,
  help,
  max,
  maxLength = 120,
}: {
  id: string;
  label: string;
  /** For the remove buttons: "Remove alias Greens". */
  what: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  help?: string;
  max?: number;
  maxLength?: number;
}) {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const full = max !== undefined && values.length >= max;

  function add(raw: string) {
    const parts = raw
      .split(/[,\n]/)
      .map((p) => p.trim().slice(0, maxLength))
      .filter(Boolean);
    if (!parts.length) {
      setText("");
      return;
    }
    const seen = new Set(values.map((v) => v.normalize("NFKC").toLowerCase()));
    const next = [...values];
    for (const p of parts) {
      const k = p.normalize("NFKC").toLowerCase();
      if (seen.has(k) || (max !== undefined && next.length >= max)) continue;
      seen.add(k);
      next.push(p);
    }
    if (next.length !== values.length) onChange(next);
    setText("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(text);
    } else if (e.key === "Backspace" && !text && values.length) {
      e.preventDefault();
      const last = values[values.length - 1]!;
      onChange(values.slice(0, -1));
      setText(last);
    }
  }

  const helpId = help ? `${id}-help` : undefined;
  return (
    <div className="field chipsin-field">
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      {help ? (
        <p id={helpId} className="muted small chipsin-help">
          {help}
        </p>
      ) : null}
      <div className="chipsin" onClick={() => input.current?.focus()}>
        {values.map((v) => (
          <span key={v} className="chipsin-chip">
            <span className="chipsin-text">{v}</span>
            <button
              type="button"
              className="chipsin-x"
              aria-label={`Remove ${what} ${v}`}
              onClick={(e) => {
                e.stopPropagation();
                onChange(values.filter((x) => x !== v));
              }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={input}
          id={id}
          className="chipsin-input"
          value={text}
          placeholder={full ? `${max} at most` : values.length ? "" : placeholder}
          disabled={full}
          aria-describedby={helpId}
          maxLength={maxLength * 4}
          onChange={(e) => {
            const v = e.target.value;
            if (/[,\n]/.test(v)) add(v);
            else setText(v);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => add(text)}
        />
      </div>
    </div>
  );
}
