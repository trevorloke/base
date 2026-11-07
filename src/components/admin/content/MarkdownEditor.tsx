"use client";

import { useEffect, useId, useRef, useState } from "react";
import { previewMarkdown } from "@/app/admin/(secure)/content/preview";

/**
 * A Markdown textarea with a live preview. The preview is rendered on the
 * server with the same sanitizer the public pages use, so what the editor
 * sees is what visitors get.
 */
export function MarkdownEditor({
  id,
  name,
  label,
  defaultValue = "",
  required,
  error,
  rows = 14,
  hint,
  maxLength,
}: {
  id: string;
  name: string;
  label: string;
  defaultValue?: string;
  required?: boolean;
  error?: string;
  rows?: number;
  hint?: string;
  maxLength?: number;
}) {
  const [text, setText] = useState(defaultValue);
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const latest = useRef(0);
  const headingId = useId();

  useEffect(() => {
    const ticket = ++latest.current;
    if (!text.trim()) {
      setHtml("");
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const rendered = await previewMarkdown(text);
        if (ticket === latest.current) {
          setHtml(rendered);
          setFailed(false);
        }
      } catch {
        if (ticket === latest.current) setFailed(true);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [text]);

  const describedBy = [`${id}-hint`, error ? `${id}-error` : null].filter(Boolean).join(" ");
  return (
    <div className="md-editor">
      <div className="field md-editor-input">
        <label htmlFor={id}>{label}</label>
        <p className="hint" id={`${id}-hint`} style={{ margin: 0 }}>
          {hint ?? "Markdown: blank line between paragraphs, **bold**, *italic*, ## heading, - list item, [link text](https://…)."}
        </p>
        <textarea
          id={id}
          name={name}
          className="input input--area md-textarea"
          rows={rows}
          required={required}
          maxLength={maxLength}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          spellCheck
        />
        {error && (
          <p className="field-error" id={`${id}-error`}>
            {error}
          </p>
        )}
      </div>
      <section className="md-preview" aria-labelledby={headingId}>
        <h3 id={headingId} className="md-preview-title">
          Preview
        </h3>
        {failed ? (
          <p className="small">The preview could not be loaded. Your text is still here; keep writing.</p>
        ) : html === null ? (
          <p className="small">Rendering…</p>
        ) : html === "" ? (
          <p className="small">Start typing to see how it will look.</p>
        ) : (
          <div className="prose page-prose" dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </section>
    </div>
  );
}
