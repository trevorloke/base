import { useEffect, useRef, useState, type DragEvent } from "react";
import type { Media, MediaAsset } from "../../types";
import { api, errorText } from "../../api";
import { bytes, duration } from "../../lib/format";

/** One attachment in the composer: uploading, ready (a library asset), or failed. */
export interface MediaItem {
  id: string;
  status: "uploading" | "ready" | "failed";
  /** 0..1 while uploading. */
  progress: number;
  name: string;
  kind: Media["kind"];
  /** What the thumbnail shows: a local object URL while uploading, then the library URL. */
  previewUrl: string | null;
  asset: MediaAsset | null;
  alt: string;
  durationSeconds: number | null;
  error?: string;
}

export type ItemsUpdate = (fn: (items: MediaItem[]) => MediaItem[]) => void;

const ACCEPT = "image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime,video/webm,application/pdf";
let seq = 0;

function kindOf(file: File): Media["kind"] {
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return "document";
  if (file.type === "image/gif") return "gif";
  if (file.type.startsWith("video/") || /\.(mp4|mov|webm|m4v)$/i.test(file.name)) return "video";
  return "image";
}

export function itemFromAsset(a: MediaAsset): MediaItem {
  seq += 1;
  return {
    id: `lib_${a.id}_${seq}`,
    status: "ready",
    progress: 1,
    name: a.originalName ?? (a.kind === "document" ? "Document" : a.kind === "video" ? "Video" : "Image"),
    kind: a.kind,
    previewUrl: a.url || null,
    asset: a,
    alt: a.alt ?? "",
    durationSeconds: a.durationSeconds,
  };
}

/** The thumbnail for any kind: images and video frames, or a plain tile for PDFs. */
export function Thumb({ kind, url, name, durationSeconds, small = false }: { kind: Media["kind"]; url: string | null; name: string; durationSeconds: number | null; small?: boolean }) {
  const [videoFailed, setVideoFailed] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const chip = kind === "video" && durationSeconds ? <span className="thumb-chip mono">{duration(durationSeconds)}</span> : null;
  if (kind === "document" || !url || imgFailed) {
    return (
      <span className={`thumb thumb-doc${small ? " thumb-small" : ""}`} title={name}>
        <span className="mono">{kind === "document" ? "PDF" : kind === "video" ? "Video" : "Image"}</span>
        {chip}
      </span>
    );
  }
  if (kind === "video" && !videoFailed) {
    return (
      <span className={`thumb${small ? " thumb-small" : ""}`} title={name}>
        <video src={`${url}#t=0.5`} muted playsInline preload="metadata" onError={() => setVideoFailed(true)} />
        <span className="thumb-play" aria-hidden="true">
          ▶
        </span>
        {chip}
      </span>
    );
  }
  return (
    <span className={`thumb${small ? " thumb-small" : ""}`} title={name}>
      <img src={url} alt="" loading="lazy" onError={() => setImgFailed(true)} />
      {kind === "video" ? (
        <span className="thumb-play" aria-hidden="true">
          ▶
        </span>
      ) : null}
      {chip}
    </span>
  );
}

/**
 * The post's media: drop or pick files (images, video, PDF), watch them upload, add alt text, reorder, remove,
 * or pull past uploads from the library. Every variant picks from these.
 */
export function MediaTray({ items, onItems }: { items: MediaItem[]; onItems: ItemsUpdate }) {
  const input = useRef<HTMLInputElement | null>(null);
  const aborts = useRef(new Map<string, () => void>());
  const [dragOver, setDragOver] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [library, setLibrary] = useState<MediaAsset[] | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);

  // Leaving the composer cancels uploads that haven't finished.
  useEffect(() => {
    const map = aborts.current;
    return () => {
      for (const abort of map.values()) abort();
    };
  }, []);

  const patch = (id: string, p: Partial<MediaItem>) => onItems((list) => list.map((x) => (x.id === id ? { ...x, ...p } : x)));

  function upload(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      seq += 1;
      const id = `up_${seq}`;
      const kind = kindOf(file);
      const local = kind === "document" ? null : URL.createObjectURL(file);
      onItems((list) => [...list, { id, status: "uploading", progress: 0, name: file.name, kind, previewUrl: local, asset: null, alt: "", durationSeconds: null }]);
      const handle = api.uploadMedia(file, (p) => patch(id, { progress: p }));
      aborts.current.set(id, handle.abort);
      handle.done
        .then((asset) => {
          onItems((list) =>
            list.map((x) =>
              x.id === id
                ? { ...x, status: "ready", progress: 1, asset, kind: asset.kind, previewUrl: asset.url || x.previewUrl, durationSeconds: asset.durationSeconds ?? x.durationSeconds, alt: x.alt || (asset.alt ?? "") }
                : x,
            ),
          );
          setLibrary(null); // the library has a new file; read it again next time
        })
        .catch((e: unknown) => patch(id, { status: "failed", error: errorText(e) }))
        .finally(() => aborts.current.delete(id));
    }
  }

  function remove(id: string) {
    aborts.current.get(id)?.();
    onItems((list) => list.filter((x) => x.id !== id));
  }

  function move(from: number, to: number) {
    if (to < 0 || to >= items.length || from === to) return;
    onItems((list) => {
      const next = list.slice();
      const [it] = next.splice(from, 1);
      if (it) next.splice(to, 0, it);
      return next;
    });
  }

  function openLibrary() {
    const next = !libraryOpen;
    setLibraryOpen(next);
    if (next && !library) {
      setLibraryError(null);
      api
        .media()
        .then(setLibrary)
        .catch((e: unknown) => setLibraryError(errorText(e)));
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
    setDragFrom(null);
  };

  const inTray = new Set(items.map((i) => i.asset?.id).filter(Boolean));

  return (
    <div
      className={`tray${dragOver ? " tray-over" : ""}`}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      {items.length ? (
        <ol className="tray-list">
          {items.map((it, i) => (
            <li
              key={it.id}
              className={`tray-item tray-${it.status}`}
              draggable={it.status !== "uploading"}
              onDragStart={(e) => {
                setDragFrom(i);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", it.id);
              }}
              onDragOver={(e) => {
                if (dragFrom !== null) e.preventDefault();
              }}
              onDrop={(e) => {
                if (dragFrom === null) return;
                e.preventDefault();
                e.stopPropagation();
                move(dragFrom, i);
                setDragFrom(null);
              }}
              onDragEnd={() => setDragFrom(null)}
            >
              <div className="tray-thumb">
                <Thumb kind={it.kind} url={it.previewUrl} name={it.name} durationSeconds={it.durationSeconds} />
                <span className="tray-pos mono" aria-hidden="true">
                  {i + 1}
                </span>
                {it.status === "uploading" ? (
                  <span className="tray-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(it.progress * 100)} aria-label={`Uploading ${it.name}`}>
                    <span className="tray-bar" style={{ width: `${Math.round(it.progress * 100)}%` }} />
                    <span className="tray-pct mono">{Math.round(it.progress * 100)}%</span>
                  </span>
                ) : null}
              </div>
              <div className="tray-name small" title={it.name}>
                <span className="tray-file">{it.name}</span>
                {it.asset ? <span className="muted mono">{bytes(it.asset.bytes)}</span> : null}
              </div>
              {it.status === "failed" ? (
                <div className="card-error small">{it.error ?? "Upload failed."}</div>
              ) : it.kind === "document" ? null : (
                <input
                  className="input tray-alt"
                  placeholder="Alt text"
                  aria-label={`Alt text for ${it.name}`}
                  value={it.alt}
                  onChange={(e) => patch(it.id, { alt: e.target.value })}
                />
              )}
              <div className="tray-tools">
                <button type="button" className="btn btn-ghost btn-small" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label={`Move ${it.name} earlier`}>
                  ←
                </button>
                <button type="button" className="btn btn-ghost btn-small" disabled={i === items.length - 1} onClick={() => move(i, i + 1)} aria-label={`Move ${it.name} later`}>
                  →
                </button>
                <button type="button" className="btn btn-ghost btn-small tray-remove" onClick={() => remove(it.id)}>
                  {it.status === "uploading" ? "Cancel" : "Remove"}
                </button>
              </div>
            </li>
          ))}
        </ol>
      ) : null}

      <div className="tray-drop">
        <span className="muted small">{items.length ? "Drop more files here, or" : "Drop images, video or a PDF here, or"}</span>
        <button type="button" className="btn btn-small" onClick={() => input.current?.click()}>
          Choose files
        </button>
        <button type="button" className="btn btn-small btn-ghost" aria-expanded={libraryOpen} onClick={openLibrary}>
          Library
        </button>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) upload(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {libraryOpen ? (
        <div className="library">
          <div className="library-head">
            <span className="section-h">Past uploads</span>
            <button type="button" className="btn btn-ghost btn-small" onClick={() => setLibraryOpen(false)}>
              Close
            </button>
          </div>
          {libraryError ? <div className="card-error small">{libraryError}</div> : null}
          {!library && !libraryError ? <p className="muted small">Loading…</p> : null}
          {library && !library.length ? <p className="muted small">Nothing uploaded yet.</p> : null}
          {library?.length ? (
            <ul className="library-grid">
              {library.map((a) => {
                const added = inTray.has(a.id);
                return (
                  <li key={a.id}>
                    <button
                      type="button"
                      className={`library-item${added ? " library-added" : ""}`}
                      disabled={added}
                      onClick={() => onItems((list) => [...list, itemFromAsset(a)])}
                      title={added ? "Already attached" : `Attach ${a.originalName ?? "this file"}`}
                    >
                      <Thumb kind={a.kind} url={a.url || null} name={a.originalName ?? ""} durationSeconds={a.durationSeconds} />
                      <span className="library-name small">{a.originalName ?? (a.kind === "document" ? "Document" : "File")}</span>
                      {added ? <span className="library-tag small">Attached</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
