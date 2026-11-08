"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Task } from "@/components/admin/ShiftBoard";
import { Alert, Checkbox, SelectField, TextField } from "@/components/forms/Field";
import { NEIGHBOURHOODS } from "@/lib/neighbourhoods";
import type { AdminOpening, OpeningSignup } from "@/lib/server/shifts";
import { formatLongDate, SLOTS, spotsLeft, STATUS_LABELS, textColorFor, weekStart, type ShiftStatus, type Slot } from "@/lib/shifts";

type Editing = "new" | AdminOpening | null;
type FieldErrors = Record<string, string>;

async function api<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? "Something went wrong. Please try again.", data.fields);
  return data as T;
}

class ApiError extends Error {
  constructor(
    message: string,
    public fields?: FieldErrors,
  ) {
    super(message);
  }
}

/**
 * Openings are the shifts volunteers book themselves on /volunteer: a date,
 * a time of day, a task, a place and a number of spots. Organizers create
 * and publish them here and see who signed up.
 */
export function OpeningsPanel({ initialOpenings, tasks, today }: { initialOpenings: AdminOpening[]; tasks: Task[]; today: string }) {
  const [openings, setOpenings] = useState(initialOpenings);
  const [showPast, setShowPast] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<FieldErrors>({});
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [signups, setSignups] = useState<Record<string, OpeningSignup[] | "loading">>({});
  const [open, setOpen] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);

  useEffect(() => setOpenings(initialOpenings), [initialOpenings]);

  useEffect(() => {
    if (!message) return;
    noticeRef.current?.focus();
    const t = setTimeout(() => setMessage(null), 6000);
    return () => clearTimeout(t);
  }, [message]);

  useEffect(() => {
    if (editing) formRef.current?.querySelector<HTMLInputElement>("#op-title")?.focus();
  }, [editing]);

  async function reload(past: boolean) {
    try {
      setOpenings(await api<AdminOpening[]>(`/api/admin/openings${past ? "?past=1" : ""}`, "GET"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load openings.");
    }
  }

  function startEdit(target: Editing) {
    setEditing(target);
    setError(null);
    setFields({});
  }

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "");
    const body = {
      date: text("date"),
      slot: text("slot") as Slot,
      taskId: text("taskId") || null,
      title: text("title"),
      location: text("location"),
      neighbourhood: text("neighbourhood") || null,
      capacity: Number(text("capacity")),
      notes: text("notes"),
      published: form.get("published") === "on",
    };
    setPending(true);
    setError(null);
    setFields({});
    try {
      if (editing === "new") {
        const created = await api<AdminOpening>("/api/admin/openings", "POST", body);
        setOpenings((list) => sortOpenings([...list, created]));
        setMessage(`Added “${created.title}”${created.published ? ", now on the website." : " as a draft."}`);
      } else if (editing) {
        const updated = await api<AdminOpening>(`/api/admin/openings/${editing.id}`, "PATCH", body);
        setOpenings((list) => sortOpenings(list.map((o) => (o.id === updated.id ? updated : o))));
        setMessage(`Saved “${updated.title}”.`);
      }
      setEditing(null);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFields(err.fields ?? {});
        const first = Object.keys(err.fields ?? {})[0];
        const el = first ? formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`) : null;
        (el ?? formRef.current?.querySelector<HTMLElement>("[role=alert]"))?.focus();
      } else setError("Something went wrong. Please try again.");
    } finally {
      setPending(false);
    }
  }

  async function setPublished(o: AdminOpening, published: boolean) {
    try {
      const updated = await api<AdminOpening>(`/api/admin/openings/${o.id}`, "PATCH", { published });
      setOpenings((list) => list.map((x) => (x.id === updated.id ? updated : x)));
      setMessage(published ? `“${updated.title}” is on the website.` : `“${updated.title}” is hidden from the website. People already signed up keep their shifts.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change that.");
    }
  }

  async function remove(o: AdminOpening) {
    if (!confirm(`Delete “${o.title}” on ${formatLongDate(o.date)}? This can't be undone.`)) return;
    try {
      await api(`/api/admin/openings/${o.id}`, "DELETE");
      setOpenings((list) => list.filter((x) => x.id !== o.id));
      setMessage(`Deleted “${o.title}”.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete that.");
    }
  }

  async function toggleSignups(o: AdminOpening) {
    if (open === o.id) {
      setOpen(null);
      return;
    }
    setOpen(o.id);
    if (signups[o.id]) return;
    setSignups((s) => ({ ...s, [o.id]: "loading" }));
    try {
      const data = await api<AdminOpening & { signups: OpeningSignup[] }>(`/api/admin/openings/${o.id}`, "GET");
      setSignups((s) => ({ ...s, [o.id]: data.signups }));
    } catch (err) {
      setSignups((s) => {
        const next = { ...s };
        delete next[o.id];
        return next;
      });
      setError(err instanceof Error ? err.message : "Could not load sign-ups.");
    }
  }

  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const current = editing && editing !== "new" ? editing : null;

  return (
    <section id="openings" className="openings-panel" aria-labelledby="openings-title">
      <div className="openings-head">
        <div>
          <h2 id="openings-title" className="week-title">
            Openings
          </h2>
          <p className="small" style={{ margin: "4px 0 0" }}>
            Shifts volunteers can sign up for on <Link href="/volunteer">/volunteer</Link>. Sign-ups land on the board above.
          </p>
        </div>
        <div className="btn-row no-print" style={{ gap: 12 }}>
          <label className="check" style={{ fontSize: 14 }}>
            <input
              type="checkbox"
              checked={showPast}
              onChange={(e) => {
                setShowPast(e.target.checked);
                reload(e.target.checked);
              }}
            />
            <span>Show past openings</span>
          </label>
          <button type="button" className="btn btn--primary" style={{ minHeight: 40 }} onClick={() => startEdit("new")} aria-expanded={editing === "new"}>
            + New opening
          </button>
        </div>
      </div>

      {message && (
        <div ref={noticeRef} tabIndex={-1} role="status" className="alert alert--note" style={{ outline: "none" }}>
          <span aria-hidden="true" className="alert-icon">
            ✓
          </span>
          <span>{message}</span>
        </div>
      )}
      {error && !editing && <Alert>{error}</Alert>}

      {editing && (
        <form ref={formRef} className="opening-editor" onSubmit={save} aria-label={current ? `Edit ${current.title}` : "New opening"}>
          <h3 className="h3" style={{ margin: 0, fontSize: 20 }}>
            {current ? "Edit opening" : "New opening"}
          </h3>
          <div className="form-row">
            <TextField id="op-title" name="title" label="Title" required maxLength={120} defaultValue={current?.title ?? ""} error={fields.title} placeholder="Door-knocking in Newton" />
            <SelectField id="op-task" name="taskId" label="Task" defaultValue={current?.taskId ?? tasks[0]?.id ?? ""} error={fields.taskId}>
              <option value="">No task</option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </SelectField>
          </div>
          <div className="form-row">
            <TextField id="op-date" name="date" type="date" label="Date" required min={current ? undefined : today} defaultValue={current?.date ?? ""} error={fields.date} />
            <SelectField id="op-slot" name="slot" label="Time of day" defaultValue={current?.slot ?? "morning"} error={fields.slot}>
              {SLOTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label} ({s.hours})
                </option>
              ))}
            </SelectField>
            <TextField id="op-capacity" name="capacity" type="number" label="Spots" required min={1} max={500} defaultValue={current?.capacity ?? 6} error={fields.capacity} style={{ maxWidth: 140 }} />
          </div>
          <div className="form-row">
            <TextField id="op-location" name="location" label="Meeting place" maxLength={200} defaultValue={current?.location ?? ""} error={fields.location} placeholder="Newton Seniors Centre, 13775 70 Ave" />
            <SelectField id="op-neighbourhood" name="neighbourhood" label="Neighbourhood" defaultValue={current?.neighbourhood ?? ""} error={fields.neighbourhood}>
              <option value="">City-wide</option>
              {NEIGHBOURHOODS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </SelectField>
          </div>
          <div className="field">
            <label htmlFor="op-notes">Notes for volunteers (Markdown)</label>
            <textarea id="op-notes" name="notes" className="input" rows={3} maxLength={2000} defaultValue={current?.notes ?? ""} aria-invalid={fields.notes ? true : undefined} aria-describedby={fields.notes ? "op-notes-error" : undefined} />
            {fields.notes && (
              <p className="field-error" id="op-notes-error">
                {fields.notes}
              </p>
            )}
          </div>
          <Checkbox name="published" defaultChecked={current ? current.published : true}>
            Published: volunteers can see it and sign up
          </Checkbox>
          {error && <Alert>{error}</Alert>}
          <div className="btn-row" style={{ gap: 8 }}>
            <button type="submit" className="btn btn--primary" aria-busy={pending} aria-disabled={pending}>
              {pending ? "Saving…" : current ? "Save opening" : "Add opening"}
            </button>
            <button type="button" className="btn btn--outline" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {openings.length === 0 ? (
        <p className="empty-state">No openings yet. Add one and it appears on the volunteer page for people to sign up.</p>
      ) : (
        <ul className="opening-rows">
          {openings.map((o) => {
            const task = o.taskId ? taskById.get(o.taskId) : undefined;
            const left = spotsLeft(o.capacity, o.signedUp);
            const slot = SLOTS.find((s) => s.id === o.slot);
            const list = signups[o.id];
            const past = o.date < today;
            return (
              <li key={o.id} className={`opening-row ${o.published ? "" : "is-draft"} ${past ? "is-past" : ""}`}>
                <div className="opening-row-main">
                  <p className="opening-row-when">
                    {formatLongDate(o.date, true)} · {slot?.label} {slot?.hours}
                  </p>
                  <h3 className="opening-row-title">
                    {o.title}
                    {!o.published && <span className="status-badge badge-draft">Draft</span>}
                    {past && <span className="status-badge badge-past">Past</span>}
                  </h3>
                  <p className="opening-row-meta">
                    {task && (
                      <span className="task-pill task-pill--sm" style={{ background: task.color, color: textColorFor(task.color) }}>
                        {task.name}
                      </span>
                    )}
                    <span>{o.neighbourhood ?? "City-wide"}</span>
                    {o.location && <span>{o.location}</span>}
                  </p>
                </div>
                <div className="opening-row-count" aria-label={`${o.signedUp} of ${o.capacity} spots filled`}>
                  <strong>{o.signedUp}</strong> of {o.capacity} filled
                  <span className={`small ${left === 0 ? "is-full" : ""}`}>{left === 0 ? "Full" : `${left} left`}</span>
                </div>
                <div className="opening-row-actions no-print">
                  <button type="button" className="link-button" onClick={() => toggleSignups(o)} aria-expanded={open === o.id} aria-controls={`signups-${o.id}`}>
                    Sign-ups ({o.signedUp})
                  </button>
                  <button type="button" className="link-button" onClick={() => startEdit(o)}>
                    Edit
                  </button>
                  <button type="button" className="link-button" onClick={() => setPublished(o, !o.published)}>
                    {o.published ? "Unpublish" : "Publish"}
                  </button>
                  <button type="button" className="link-button is-danger" onClick={() => remove(o)}>
                    Delete
                  </button>
                </div>
                {open === o.id && (
                  <div id={`signups-${o.id}`} className="opening-signups">
                    {list === "loading" || !list ? (
                      <p className="small">Loading…</p>
                    ) : list.length === 0 ? (
                      <p className="small">Nobody has signed up yet.</p>
                    ) : (
                      <ul className="opening-signup-list">
                        {list.map((s) => (
                          <li key={s.shiftId}>
                            <strong>{s.name}</strong> <span className="small">{STATUS_LABELS[s.status as ShiftStatus] ?? s.status}</span>
                            <br />
                            <a href={`mailto:${s.email}`}>{s.email}</a>
                            {s.phone && (
                              <>
                                {" · "}
                                <a href={`tel:${s.phone}`}>{s.phone}</a>
                              </>
                            )}
                            {s.neighbourhood && <span className="small"> · {s.neighbourhood}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                    <Link href={`/admin/shifts?week=${weekStart(o.date)}`} className="text-link" style={{ fontSize: 14 }}>
                      Open that week on the board
                    </Link>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function sortOpenings(list: AdminOpening[]): AdminOpening[] {
  const order: Record<Slot, number> = { morning: 0, afternoon: 1, evening: 2 };
  return [...list].sort((a, b) => a.date.localeCompare(b.date) || order[a.slot] - order[b.slot] || a.title.localeCompare(b.title));
}
