"use client";

import { useActionState } from "react";
import { fieldError, Notice } from "@/components/admin/Notice";
import { SubmitButton } from "@/components/admin/SubmitButton";
import { StatusBadge } from "@/components/tracker/PromiseList";
import { NEIGHBOURHOODS } from "@/lib/neighbourhoods";
import type { ActionState } from "@/lib/server/actions";
import type { TrackerAnnouncement, TrackerPromise } from "@/lib/server/tracker";
import { PROMISE_STATUSES } from "@/lib/tracker";
import { addAnnouncement, addPromise, addUpdate, deleteAnnouncement, deletePromise, deleteUpdate, editPromise, setStatus } from "./actions";

// The admin's forms. Each one submits to a server action through
// useActionState, shows the result in a Notice and field errors next to the
// field, and keeps its submit button focused while it works.

const textarea = { padding: 12, minHeight: 72 } as const;

function FieldError({ state, name, id }: { state: ActionState; name: string; id: string }) {
  const message = fieldError(state, name);
  return message ? (
    <p className="field-error" id={`${id}-error`}>
      {message}
    </p>
  ) : null;
}

const invalid = (state: ActionState, name: string, id: string) =>
  fieldError(state, name) ? { "aria-invalid": true as const, "aria-describedby": `${id}-error` } : {};

export function UpdateForm({ promise, today }: { promise: TrackerPromise; today: string }) {
  const [state, action] = useActionState(addUpdate, null);
  const id = promise.id;
  return (
    <form action={action} className="form-card form-card--surface" style={{ padding: 18, gap: 12 }}>
      <h3 className="h3" style={{ fontSize: 18 }}>
        Add an update
      </h3>
      <Notice state={state} />
      <input type="hidden" name="promiseId" value={id} />
      <div className="form-row">
        <div className="field">
          <label htmlFor={`d-${id}`}>Date</label>
          <input id={`d-${id}`} name="date" type="date" className="input" defaultValue={today} required {...invalid(state, "date", `d-${id}`)} />
          <FieldError state={state} name="date" id={`d-${id}`} />
        </div>
        <div className="field">
          <label htmlFor={`s-${id}`}>New status</label>
          <select id={`s-${id}`} name="status" className="input" defaultValue="" {...invalid(state, "status", `s-${id}`)}>
            <option value="">Keep as {PROMISE_STATUSES.find((s) => s.id === promise.status)?.label}</option>
            {PROMISE_STATUSES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <FieldError state={state} name="status" id={`s-${id}`} />
        </div>
      </div>
      <div className="field">
        <label htmlFor={`n-${id}`}>What happened</label>
        <textarea id={`n-${id}`} name="note" className="input" style={textarea} required maxLength={2000} {...invalid(state, "note", `n-${id}`)} />
        <FieldError state={state} name="note" id={`n-${id}`} />
      </div>
      <div className="field">
        <label htmlFor={`u-${id}`}>Link to the record (council minutes, bylaw, news story)</label>
        <input id={`u-${id}`} name="url" type="url" className="input" placeholder="https://" {...invalid(state, "url", `u-${id}`)} />
        <FieldError state={state} name="url" id={`u-${id}`} />
      </div>
      {promise.testKept && (
        <p className="small">
          <strong>Kept:</strong> {promise.testKept} <strong>Partly:</strong> {promise.testPartly} <strong>Broken:</strong> {promise.testBroken}
        </p>
      )}
      <p className="small">Changing the status emails everyone following this promise.</p>
      <SubmitButton className="btn btn--accent" pendingText="Adding…" style={{ alignSelf: "flex-start" }}>
        Add update
      </SubmitButton>
    </form>
  );
}

export function DeleteUpdateForm({ id }: { id: string }) {
  const [state, action] = useActionState(deleteUpdate, null);
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      {state && !state.ok && (
        <p className="field-error" role="alert">
          {state.error}
        </p>
      )}
      <SubmitButton className="link-button is-danger" pendingText="Deleting…" confirm="Delete this update? The public log will no longer show it.">
        Delete
      </SubmitButton>
    </form>
  );
}

export function SetStatusForm({ promise }: { promise: TrackerPromise }) {
  const [state, action] = useActionState(setStatus, null);
  return (
    <form action={action} className="stack" style={{ gap: 8 }}>
      <Notice state={state} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <input type="hidden" name="id" value={promise.id} />
        <label htmlFor={`fix-${promise.id}`} className="small">
          Correct the status without an update:
        </label>
        <select id={`fix-${promise.id}`} name="status" className="input" defaultValue={promise.status} style={{ width: "auto", minHeight: 38 }}>
          {PROMISE_STATUSES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <SubmitButton className="btn btn--outline" pendingText="Saving…" style={{ minHeight: 38 }}>
          Save
        </SubmitButton>
      </div>
    </form>
  );
}

function PromiseDateFields({ idPrefix, state, promisedOn, targetDate, neighbourhoods }: { idPrefix: string; state: ActionState; promisedOn?: string | null; targetDate?: string | null; neighbourhoods?: string[] }) {
  return (
    <>
      <div className="form-row">
        <div className="field">
          <label htmlFor={`${idPrefix}-promisedOn`}>Promised on (optional)</label>
          <input id={`${idPrefix}-promisedOn`} name="promisedOn" type="date" className="input" defaultValue={promisedOn ?? ""} {...invalid(state, "promisedOn", `${idPrefix}-promisedOn`)} />
          <FieldError state={state} name="promisedOn" id={`${idPrefix}-promisedOn`} />
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-targetDate`}>Due by (optional, the party&apos;s own deadline)</label>
          <input id={`${idPrefix}-targetDate`} name="targetDate" type="date" className="input" defaultValue={targetDate ?? ""} {...invalid(state, "targetDate", `${idPrefix}-targetDate`)} />
          <FieldError state={state} name="targetDate" id={`${idPrefix}-targetDate`} />
        </div>
      </div>
      <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="field-label" style={{ marginBottom: 6 }}>
          Neighbourhoods this promise affects
        </legend>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px" }}>
          {NEIGHBOURHOODS.map((n) => (
            <label key={n} className="check">
              <input type="checkbox" name="neighbourhoods" value={n} defaultChecked={neighbourhoods?.includes(n)} /> <span>{n}</span>
            </label>
          ))}
        </div>
        <FieldError state={state} name="neighbourhoods" id={`${idPrefix}-neighbourhoods`} />
      </fieldset>
    </>
  );
}

export function EditPromiseForm({ promise }: { promise: TrackerPromise }) {
  const [state, action] = useActionState(editPromise, null);
  const id = promise.id;
  const fields = [
    ["title", "Promise", promise.title],
    ["specifics", "Specifics and conditions", promise.specifics],
    ["area", "Area", promise.area],
    ["testKept", "Kept means", promise.testKept ?? ""],
    ["testPartly", "Partly kept means", promise.testPartly ?? ""],
    ["testBroken", "Broken means", promise.testBroken ?? ""],
    ["testRecord", "Record to check", promise.testRecord ?? ""],
  ] as const;
  return (
    <form action={action} className="stack" style={{ gap: 10, marginTop: 12 }}>
      <Notice state={state} />
      <input type="hidden" name="id" value={id} />
      {fields.map(([name, label, value]) => (
        <div key={name} className="field">
          <label htmlFor={`${name}-${id}`}>{label}</label>
          {name === "area" ? (
            <input id={`${name}-${id}`} name={name} className="input" defaultValue={value} required maxLength={40} {...invalid(state, name, `${name}-${id}`)} />
          ) : (
            <textarea id={`${name}-${id}`} name={name} className="input" style={textarea} defaultValue={value} required={name === "title"} {...invalid(state, name, `${name}-${id}`)} />
          )}
          <FieldError state={state} name={name} id={`${name}-${id}`} />
        </div>
      ))}
      <PromiseDateFields idPrefix={`edit-${id}`} state={state} promisedOn={promise.promisedOn} targetDate={promise.targetDate} neighbourhoods={promise.neighbourhoods} />
      <div className="btn-row" style={{ gap: 10 }}>
        <SubmitButton className="btn btn--primary" pendingText="Saving…">
          Save changes
        </SubmitButton>
      </div>
    </form>
  );
}

export function DeletePromiseForm({ promise }: { promise: TrackerPromise }) {
  const [state, action] = useActionState(deletePromise, null);
  return (
    <form action={action} style={{ marginTop: 12 }}>
      <input type="hidden" name="id" value={promise.id} />
      {state && !state.ok && (
        <p className="field-error" role="alert">
          {state.error}
        </p>
      )}
      <SubmitButton
        className="link-button is-danger"
        pendingText="Deleting…"
        confirm={`Delete promise ${promise.number} ("${promise.title}") with its ${promise.updates.length} update(s) and everyone following it? This cannot be undone.`}
      >
        Delete this promise and its updates
      </SubmitButton>
    </form>
  );
}

export function AddPromiseForm({ nextNumber, areas }: { nextNumber: number; areas: string[] }) {
  const [state, action] = useActionState(addPromise, null);
  return (
    <form action={action} className="form-card form-card--surface">
      <Notice state={state} />
      <div className="field">
        <label htmlFor="np-title">Promise</label>
        <input id="np-title" name="title" className="input" required maxLength={400} {...invalid(state, "title", "np-title")} />
        <FieldError state={state} name="title" id="np-title" />
      </div>
      <div className="field">
        <label htmlFor="np-specifics">Specifics and conditions</label>
        <textarea id="np-specifics" name="specifics" className="input" style={textarea} {...invalid(state, "specifics", "np-specifics")} />
        <FieldError state={state} name="specifics" id="np-specifics" />
      </div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="np-area">Area</label>
          <input id="np-area" name="area" className="input" required list="areas" maxLength={40} {...invalid(state, "area", "np-area")} />
          <datalist id="areas">
            {areas.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
          <FieldError state={state} name="area" id="np-area" />
        </div>
        <div className="field">
          <label htmlFor="np-src">Where it was made</label>
          <input id="np-src" name="sourceLabel" className="input" placeholder="e.g. Council meeting, Nov 2, 2026" maxLength={200} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="np-url">Link</label>
        <input id="np-url" name="sourceUrl" type="url" className="input" placeholder="https://" {...invalid(state, "sourceUrl", "np-url")} />
        <FieldError state={state} name="sourceUrl" id="np-url" />
      </div>
      <PromiseDateFields idPrefix="np" state={state} />
      <SubmitButton className="btn btn--accent" pendingText="Adding…" style={{ alignSelf: "flex-start" }}>
        Add promise #{nextNumber}
      </SubmitButton>
    </form>
  );
}

export function AddAnnouncementForm({ today }: { today: string }) {
  const [state, action] = useActionState(addAnnouncement, null);
  return (
    <form action={action} className="form-card form-card--surface">
      <Notice state={state} />
      <div className="form-row">
        <div className="field">
          <label htmlFor="na-date">Date</label>
          <input id="na-date" name="date" type="date" className="input" defaultValue={today} required {...invalid(state, "date", "na-date")} />
          <FieldError state={state} name="date" id="na-date" />
        </div>
        <div className="field">
          <label htmlFor="na-title">Announcement</label>
          <input id="na-title" name="title" className="input" required maxLength={300} {...invalid(state, "title", "na-title")} />
          <FieldError state={state} name="title" id="na-title" />
        </div>
      </div>
      <div className="field">
        <label htmlFor="na-commitments">Commitments or claims made</label>
        <textarea id="na-commitments" name="commitments" className="input" style={textarea} required maxLength={4000} {...invalid(state, "commitments", "na-commitments")} />
        <FieldError state={state} name="commitments" id="na-commitments" />
      </div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="na-src">Source</label>
          <input id="na-src" name="sourceLabel" className="input" placeholder="e.g. a newspaper, Nov 3, 2026" maxLength={200} />
        </div>
        <div className="field">
          <label htmlFor="na-url">Link</label>
          <input id="na-url" name="sourceUrl" type="url" className="input" placeholder="https://" {...invalid(state, "sourceUrl", "na-url")} />
          <FieldError state={state} name="sourceUrl" id="na-url" />
        </div>
      </div>
      <SubmitButton className="btn btn--accent" pendingText="Adding…" style={{ alignSelf: "flex-start" }}>
        Add announcement
      </SubmitButton>
    </form>
  );
}

export function DeleteAnnouncementForm({ announcement }: { announcement: TrackerAnnouncement }) {
  const [state, action] = useActionState(deleteAnnouncement, null);
  return (
    <form action={action}>
      <input type="hidden" name="id" value={announcement.id} />
      {state && !state.ok && (
        <p className="field-error" role="alert">
          {state.error}
        </p>
      )}
      <SubmitButton className="link-button is-danger" pendingText="Deleting…" confirm={`Delete "${announcement.title}" from the announcements log?`}>
        Delete
      </SubmitButton>
    </form>
  );
}

export function StatusSummary({ promise }: { promise: TrackerPromise }) {
  return <StatusBadge status={promise.status} />;
}
