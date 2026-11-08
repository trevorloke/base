"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { deleteMedia, updateMediaAlt } from "@/app/admin/(secure)/media/actions";
import { fieldError, Notice } from "@/components/admin/Notice";
import { SubmitButton } from "@/components/admin/SubmitButton";
import { ActionForm } from "./ActionForm";
import { useCmsForm } from "./useCmsForm";

export type MediaCardItem = {
  id: string;
  url: string;
  alt: string;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  uploadedBy: string | null;
  /** ISO string. */
  createdAt: string;
};

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function MediaCard({ item }: { item: MediaCardItem }) {
  const form = useCmsForm(updateMediaAlt);
  const { state } = form;
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const isImage = item.mime.startsWith("image/");

  async function copy() {
    const absolute = item.url.startsWith("http") ? item.url : `${window.location.origin}${item.url}`;
    try {
      await navigator.clipboard.writeText(absolute);
      setCopied("done");
    } catch {
      urlInput.current?.select();
      setCopied("failed");
    }
    setTimeout(() => setCopied(null), 3000);
  }

  return (
    <li className="media-card">
      <div className="media-thumb">
        {isImage ? (
          // eslint-disable-next-line @next/next/no-img-element -- stored URLs from any host
          <img src={item.url} alt={item.alt} loading="lazy" />
        ) : (
          <span className="small">{item.mime}</span>
        )}
      </div>
      <p className="media-meta">
        <strong style={{ color: "var(--ink)" }}>{item.filename}</strong>
        <br />
        {item.width && item.height ? `${item.width} × ${item.height} · ` : ""}
        {formatSize(item.size)}
        <br />
        {new Date(item.createdAt).toLocaleDateString("en-CA", { timeZone: "America/Vancouver", month: "short", day: "numeric", year: "numeric" })}
        {item.uploadedBy ? ` · ${item.uploadedBy}` : ""}
      </p>
      <form key={form.key} action={form.action} className="stack" style={{ gap: 8 }}>
        <input type="hidden" name="id" value={item.id} />
        <div className="field">
          <label htmlFor={`alt-${item.id}`}>Alt text</label>
          <input id={`alt-${item.id}`} name="alt" className="input" defaultValue={form.text("alt", item.alt)} maxLength={300} aria-invalid={fieldError(state, "alt") ? true : undefined} />
          {fieldError(state, "alt") && <p className="field-error">{fieldError(state, "alt")}</p>}
        </div>
        <div>
          <SubmitButton className="btn btn--outline btn--sm">Save alt text</SubmitButton>
        </div>
        <Notice state={state} />
      </form>
      <label className="visually-hidden" htmlFor={`url-${item.id}`}>
        File URL
      </label>
      <input id={`url-${item.id}`} ref={urlInput} className="input media-url" readOnly value={item.url} style={{ minHeight: 36 }} />
      <div className="btn-row">
        <button type="button" className="btn btn--outline btn--sm" onClick={copy}>
          Copy URL
        </button>
        <ActionForm action={deleteMedia} fields={{ id: item.id }} buttonClassName="btn btn--danger btn--sm" confirm="Remove this file from the library? Anything still using its URL keeps working, and the file itself stays in storage." pendingText="Removing…">
          Remove
        </ActionForm>
      </div>
      {copied && (
        <p role="status" className="small">
          {copied === "done" ? "Copied." : "Select the address above and copy it."}
        </p>
      )}
    </li>
  );
}

/** Upload straight into the library. */
export function MediaUpload() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const form = useRef<HTMLFormElement>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = new FormData(e.currentTarget);
    const file = body.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setMessage({ tone: "error", text: "Choose a file first." });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/media", { method: "POST", body });
      const data = (await res.json().catch(() => ({}))) as { error?: string; url?: string };
      if (!res.ok) setMessage({ tone: "error", text: data.error ?? "The upload failed." });
      else {
        setMessage({ tone: "ok", text: `Uploaded ${file.name}.` });
        form.current?.reset();
        router.refresh();
      }
    } catch {
      setMessage({ tone: "error", text: "The upload failed. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form ref={form} onSubmit={onSubmit} className="cms-form" aria-busy={busy}>
      <h2 style={{ margin: 0 }}>Upload</h2>
      <div className="form-row">
        <div className="field">
          <label htmlFor="upload-file">File (JPEG, PNG, WebP, GIF, SVG or PDF, up to 8 MB)</label>
          <input id="upload-file" name="file" type="file" className="file-input" accept="image/*,application/pdf" required />
        </div>
        <div className="field">
          <label htmlFor="upload-alt">Alt text (what the image shows)</label>
          <input id="upload-alt" name="alt" className="input" maxLength={300} />
        </div>
      </div>
      {message && (
        <div role={message.tone === "error" ? "alert" : "status"} className={`alert ${message.tone === "ok" ? "alert--note" : ""}`}>
          <span aria-hidden="true" className="alert-icon">
            {message.tone === "ok" ? "✓" : "!"}
          </span>
          <span>{message.text}</span>
        </div>
      )}
      <div>
        <button type="submit" className="btn btn--primary" aria-busy={busy} aria-disabled={busy}>
          {busy ? "Uploading…" : "Upload"}
        </button>
      </div>
    </form>
  );
}
