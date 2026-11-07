"use client";

import { addWalkIn, saveEvent } from "@/app/admin/(secure)/content/events/actions";
import { fieldError, Notice } from "@/components/admin/Notice";
import { SubmitButton } from "@/components/admin/SubmitButton";
import { Checkbox, SelectField, TextField } from "@/components/forms/Field";
import { NEIGHBOURHOODS } from "@/lib/neighbourhoods";
import { dateToPacificLocal } from "./fields";
import { ImageField } from "./ImageField";
import { TextareaField } from "./Inputs";
import { MarkdownEditor } from "./MarkdownEditor";
import { TitleSlugFields } from "./TitleSlugFields";
import { useCmsForm } from "./useCmsForm";
import { clientProfile } from "@/seeds/client";

export type EventFormValues = {
  id: string;
  title: string;
  slug: string;
  /** ISO strings. */
  startsAt: string;
  endsAt: string | null;
  location: string;
  address: string | null;
  neighbourhood: string | null;
  capacity: number | null;
  summary: string;
  description: string;
  imageUrl: string | null;
  published: boolean;
};

export function EventForm({ event }: { event?: EventFormValues }) {
  const form = useCmsForm(saveEvent);
  const { state } = form;
  return (
    <form key={form.key} action={form.action} className="cms-form">
      {event && <input type="hidden" name="id" value={event.id} />}
      <TitleSlugFields titleLabel="Event name" defaultTitle={form.text("title", event?.title)} defaultSlug={form.text("slug", event?.slug)} urlPrefix="/events/" titleError={fieldError(state, "title")} slugError={fieldError(state, "slug")} />
      <div className="form-row">
        <TextField
          id="startsAt"
          name="startsAt"
          type="datetime-local"
          label={`Starts (${clientProfile.place || "Pacific"} time)`}
          required
          defaultValue={form.text("startsAt", event ? dateToPacificLocal(new Date(event.startsAt)) : "")}
          error={fieldError(state, "startsAt")}
        />
        <TextField id="endsAt" name="endsAt" type="datetime-local" label="Ends (optional)" defaultValue={form.text("endsAt", event?.endsAt ? dateToPacificLocal(new Date(event.endsAt)) : "")} error={fieldError(state, "endsAt")} />
      </div>
      <div className="form-row">
        <TextField id="location" name="location" label="Venue" required maxLength={200} defaultValue={form.text("location", event?.location)} error={fieldError(state, "location")} placeholder="e.g. Newton Seniors Centre" />
        <TextField id="address" name="address" label="Street address (for maps and calendar files)" maxLength={300} defaultValue={form.text("address", event?.address ?? "")} error={fieldError(state, "address")} />
      </div>
      <div className="form-row">
        <SelectField id="neighbourhood" name="neighbourhood" label="Neighbourhood" defaultValue={form.text("neighbourhood", event?.neighbourhood ?? "")} error={fieldError(state, "neighbourhood")}>
          <option value="">City-wide</option>
          {NEIGHBOURHOODS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </SelectField>
        <TextField id="capacity" name="capacity" type="number" min={1} max={100000} step={1} label="Capacity (optional)" defaultValue={form.text("capacity", event?.capacity ?? "")} error={fieldError(state, "capacity")} inputMode="numeric" />
      </div>
      <TextareaField id="summary" name="summary" label="One line on what to expect" required maxLength={300} rows={2} defaultValue={form.text("summary", event?.summary)} error={fieldError(state, "summary")} />
      <MarkdownEditor id="description" name="description" label="Details" defaultValue={form.text("description", event?.description)} maxLength={20_000} error={fieldError(state, "description")} rows={10} />
      <ImageField defaultUrl={form.text("imageUrl", event?.imageUrl)} showAlt={false} urlError={fieldError(state, "imageUrl")} />
      <Checkbox name="published" defaultChecked={form.checked("published", event ? event.published : true)}>
        Published (listed on /events and open for RSVPs)
      </Checkbox>
      <Notice state={state} />
      <div className="cms-publish">
        <SubmitButton className="btn btn--accent">{event ? "Save changes" : "Add event"}</SubmitButton>
      </div>
    </form>
  );
}

/** Someone who turned up without an RSVP: add them and check them in at once. */
export function WalkInForm({ eventId }: { eventId: string }) {
  // Cleared after each walk-in is added, ready for the next.
  const form = useCmsForm(addWalkIn, { clearOnSuccess: true });
  const { state } = form;
  return (
    <form key={form.key} action={form.action} className="stack" style={{ gap: 10 }}>
      <input type="hidden" name="eventId" value={eventId} />
      <div className="walk-in">
        <TextField id="walkin-name" name="name" label="Name" required maxLength={120} autoComplete="off" defaultValue={form.text("name", "")} error={fieldError(state, "name")} />
        <TextField id="walkin-email" name="email" type="email" label="Email" required maxLength={254} autoComplete="off" defaultValue={form.text("email", "")} error={fieldError(state, "email")} />
        <TextField id="walkin-guests" name="guests" type="number" min={0} max={10} defaultValue={form.text("guests", "0")} label="Guests" style={{ maxWidth: 110 }} error={fieldError(state, "guests")} />
        <SubmitButton className="btn btn--primary" pendingText="Adding…">
          Add walk-in
        </SubmitButton>
      </div>
      <Notice state={state} />
    </form>
  );
}
