"use client";

import { useState } from "react";
import { TextField } from "@/components/forms/Field";
import { SLUG_MAX, slugify } from "./fields";

/** Title and slug inputs; the slug follows the title until someone edits it. */
export function TitleSlugFields({
  titleLabel = "Title",
  defaultTitle = "",
  defaultSlug = "",
  urlPrefix,
  titleError,
  slugError,
  slugLocked = false,
  lockedNote,
  titleMax = 200,
}: {
  titleLabel?: string;
  defaultTitle?: string;
  defaultSlug?: string;
  urlPrefix: string;
  titleError?: string;
  slugError?: string;
  slugLocked?: boolean;
  lockedNote?: string;
  titleMax?: number;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const [slug, setSlug] = useState(defaultSlug);
  const [slugTouched, setSlugTouched] = useState(Boolean(defaultSlug));
  return (
    <>
      <TextField
        id="title"
        name="title"
        label={titleLabel}
        value={title}
        required
        maxLength={titleMax}
        error={titleError}
        onChange={(e) => {
          setTitle(e.target.value);
          if (!slugTouched) setSlug(slugify(e.target.value));
        }}
      />
      <div className="field">
        <label htmlFor="slug">Web address</label>
        <p className="hint" id="slug-hint" style={{ margin: 0 }}>
          {slugLocked ? (lockedNote ?? "This address is fixed.") : `Lowercase letters, numbers and hyphens. Shown at ${urlPrefix}${slug || "…"}`}
        </p>
        <div className="slug-row">
          <span className="slug-prefix" aria-hidden="true">
            {urlPrefix}
          </span>
          <input
            id="slug"
            name="slug"
            className="input"
            value={slug}
            maxLength={SLUG_MAX}
            readOnly={slugLocked}
            aria-readonly={slugLocked || undefined}
            aria-describedby={["slug-hint", slugError ? "slug-error" : null].filter(Boolean).join(" ")}
            aria-invalid={slugError ? true : undefined}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value.toLowerCase());
            }}
            onBlur={(e) => {
              if (!e.target.value.trim()) setSlugTouched(false);
            }}
            spellCheck={false}
            autoCapitalize="none"
          />
        </div>
        {slugError && (
          <p className="field-error" id="slug-error">
            {slugError}
          </p>
        )}
      </div>
    </>
  );
}
