"use client";

import { useEffect, useRef, useState } from "react";

export type ImageValue = { url: string; alt: string };
export type MediaItem = { id: string; url: string; alt: string; filename: string; mime?: string; width: number | null; height: number | null };

/** Only pictures can go where an image is expected: a PDF in the library is not one. */
export function isImageItem(item: Pick<MediaItem, "mime">): boolean {
  return typeof item.mime === "string" && item.mime.startsWith("image/");
}

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml";

async function uploadFile(file: File, alt: string): Promise<{ ok: true; item: MediaItem } | { ok: false; error: string }> {
  const body = new FormData();
  body.set("file", file);
  body.set("alt", alt);
  try {
    const res = await fetch("/api/admin/media", { method: "POST", body });
    const data = (await res.json().catch(() => ({}))) as { error?: string; id?: string; url?: string; width?: number | null; height?: number | null };
    if (!res.ok || !data.url || !data.id) return { ok: false, error: data.error ?? "The upload failed. Please try again." };
    return { ok: true, item: { id: data.id, url: data.url, alt, filename: file.name, mime: file.type, width: data.width ?? null, height: data.height ?? null } };
  } catch {
    return { ok: false, error: "The upload failed. Check your connection and try again." };
  }
}

/**
 * Choose an image: upload a new one, pick one from the media library, or
 * paste a URL. Controlled: the parent owns {url, alt}.
 */
export function ImageControl({
  idPrefix,
  value,
  onChange,
  showAlt = true,
  altRequired = true,
  urlError,
  altError,
  label = "Image",
}: {
  idPrefix: string;
  value: ImageValue;
  onChange: (next: ImageValue) => void;
  showAlt?: boolean;
  altRequired?: boolean;
  urlError?: string;
  altError?: string;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickButton = useRef<HTMLButtonElement>(null);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    const result = await uploadFile(file, value.alt);
    setBusy(false);
    if (result.ok) onChange({ url: result.item.url, alt: value.alt });
    else setError(result.error);
  }

  return (
    <div className="image-field">
      <div className="image-field-preview">
        {value.url ? (
          // eslint-disable-next-line @next/next/no-img-element -- admin preview of an arbitrary stored URL
          <img src={value.url} alt={value.alt || ""} />
        ) : (
          <span className="small">No image</span>
        )}
      </div>
      <div className="image-field-controls">
        <div className="field">
          <label htmlFor={`${idPrefix}-url`}>{label} URL</label>
          <input
            id={`${idPrefix}-url`}
            className="input"
            value={value.url}
            onChange={(e) => onChange({ ...value, url: e.target.value })}
            placeholder="Upload a file or choose one from the library"
            aria-invalid={urlError ? true : undefined}
            aria-describedby={urlError ? `${idPrefix}-url-error` : undefined}
            inputMode="url"
          />
          {urlError && (
            <p className="field-error" id={`${idPrefix}-url-error`}>
              {urlError}
            </p>
          )}
        </div>
        {showAlt && (
          <div className="field">
            <label htmlFor={`${idPrefix}-alt`}>Alt text{altRequired && value.url ? " (required)" : ""}</label>
            <input
              id={`${idPrefix}-alt`}
              className="input"
              value={value.alt}
              maxLength={300}
              required={altRequired && Boolean(value.url)}
              onChange={(e) => onChange({ ...value, alt: e.target.value })}
              placeholder="What the picture shows, for people who can't see it"
              aria-invalid={altError ? true : undefined}
              aria-describedby={altError ? `${idPrefix}-alt-error` : undefined}
            />
            {altError && (
              <p className="field-error" id={`${idPrefix}-alt-error`}>
                {altError}
              </p>
            )}
          </div>
        )}
        <div className="image-field-actions">
          <div className="field">
            <label htmlFor={`${idPrefix}-file`} className="small">
              Upload a new image (JPEG, PNG, WebP, GIF or SVG, up to 8 MB)
            </label>
            <input id={`${idPrefix}-file`} type="file" accept={ACCEPT} className="file-input" onChange={(e) => onFile(e.target.files?.[0])} disabled={busy} />
          </div>
          <div className="btn-row" style={{ gap: 10 }}>
            <button ref={pickButton} type="button" className="btn btn--outline btn--sm" onClick={() => setPickerOpen(true)}>
              Choose from library
            </button>
            {value.url && (
              <button type="button" className="btn btn--outline btn--sm" onClick={() => onChange({ url: "", alt: "" })}>
                Remove image
              </button>
            )}
          </div>
        </div>
        {busy && (
          <p role="status" className="small">
            Uploading…
          </p>
        )}
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
      </div>
      {pickerOpen && (
        <MediaPicker
          onPick={(item) => {
            onChange({ url: item.url, alt: value.alt || item.alt });
            setPickerOpen(false);
            pickButton.current?.focus();
          }}
          onClose={() => {
            setPickerOpen(false);
            pickButton.current?.focus();
          }}
        />
      )}
    </div>
  );
}

/** Uncontrolled wrapper for plain forms: keeps hidden inputs in sync for the server action. */
export function ImageField({
  idPrefix = "image",
  urlName = "imageUrl",
  altName = "imageAlt",
  defaultUrl,
  defaultAlt,
  showAlt = true,
  altRequired = true,
  urlError,
  altError,
  label,
}: {
  idPrefix?: string;
  urlName?: string;
  altName?: string;
  defaultUrl?: string | null;
  defaultAlt?: string | null;
  showAlt?: boolean;
  altRequired?: boolean;
  urlError?: string;
  altError?: string;
  label?: string;
}) {
  const [value, setValue] = useState<ImageValue>({ url: defaultUrl ?? "", alt: defaultAlt ?? "" });
  return (
    <>
      <input type="hidden" name={urlName} value={value.url} />
      {showAlt && <input type="hidden" name={altName} value={value.alt} />}
      <ImageControl idPrefix={idPrefix} value={value} onChange={setValue} showAlt={showAlt} altRequired={altRequired} urlError={urlError} altError={altError} label={label} />
    </>
  );
}

/** The media library in a dialog. Native <dialog> handles focus, Escape and the backdrop. */
export function MediaPicker({ onPick, onClose }: { onPick: (item: MediaItem) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin/media?images=1&q=${encodeURIComponent(q)}`);
        const data = (await res.json()) as MediaItem[] | { error: string };
        if (cancelled) return;
        if (!res.ok || !Array.isArray(data)) setError((data as { error?: string }).error ?? "Could not load the library.");
        else setItems(data.filter(isImageItem));
      } catch {
        if (!cancelled) setError("Could not load the library.");
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q]);

  return (
    <dialog ref={dialog} className="media-dialog" aria-labelledby="media-picker-title" onClose={onClose} onCancel={onClose}>
      <div className="media-dialog-head">
        <h2 id="media-picker-title" className="h3">
          Choose an image
        </h2>
        <button type="button" className="btn btn--outline btn--sm" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="field">
        <label htmlFor="media-picker-search">Search by file name or alt text</label>
        <input id="media-picker-search" type="search" className="input" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error ? (
        <p role="alert" className="field-error">
          {error}
        </p>
      ) : items === null ? (
        <p className="small">Loading…</p>
      ) : items.length === 0 ? (
        <p className="empty-state">Nothing in the library yet. Upload an image first.</p>
      ) : (
        <ul className="media-grid media-grid--picker">
          {items.map((item) => (
            <li key={item.id}>
              <button type="button" className="media-pick" onClick={() => onPick(item)}>
                {/* eslint-disable-next-line @next/next/no-img-element -- stored URLs from any host */}
                <img src={item.url} alt="" loading="lazy" />
                <span className="media-pick-name">{item.alt || item.filename}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </dialog>
  );
}
