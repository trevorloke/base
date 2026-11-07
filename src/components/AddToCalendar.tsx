/**
 * "Add to calendar" for an event or shift: a Google Calendar link and an .ics
 * file for Apple Calendar, Outlook and everything else. Server-safe.
 */
export function AddToCalendar({ googleUrl, icsUrl, title }: { googleUrl: string; icsUrl: string; title?: string }) {
  return (
    <div className="calendar-links" role="group" aria-label={title ? `Add ${title} to your calendar` : "Add to your calendar"}>
      <a className="btn btn--outline calendar-link" href={googleUrl} target="_blank" rel="noopener noreferrer">
        Add to Google Calendar<span className="visually-hidden"> (opens in a new tab)</span>
      </a>
      <a className="btn btn--outline calendar-link" href={icsUrl} download>
        Download .ics<span className="visually-hidden"> calendar file</span>
        <span aria-hidden="true"> (Apple, Outlook)</span>
      </a>
    </div>
  );
}
