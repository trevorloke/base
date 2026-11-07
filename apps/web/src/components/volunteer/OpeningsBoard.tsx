"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { AddToCalendar } from "@/components/AddToCalendar";
import { SelectField } from "@/components/forms/Field";
import { ShareButtons } from "@/components/ShareButtons";
import { shareLinks } from "@/lib/share";
import { formatDay, formatLongDate, groupByWeek, SLOT_BY_ID, textColorFor, type PublicOpening, type SignupConfirmation } from "@/lib/shifts";
import { SignupForm } from "./SignupForm";

const CITY_WIDE = "__city";

/**
 * The volunteer page's openings: filters by neighbourhood and task, weeks of
 * cards with spots left, and a sign-up form that opens inside each card. A
 * successful sign-up turns the card into a confirmation with calendar links
 * and share buttons, without leaving the page.
 */
export function OpeningsBoard({ openings, notesHtml }: { openings: PublicOpening[]; notesHtml: Record<string, string> }) {
  const [hood, setHood] = useState("all");
  const [task, setTask] = useState("all");
  const [openForm, setOpenForm] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, SignupConfirmation>>({});
  const [taken, setTaken] = useState<Record<string, number>>({});

  const hoods = useMemo(() => [...new Set(openings.map((o) => o.neighbourhood).filter((n): n is string => Boolean(n)))].sort(), [openings]);
  const tasks = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of openings) if (o.taskId && o.taskName) m.set(o.taskId, o.taskName);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [openings]);
  const hasCityWide = openings.some((o) => !o.neighbourhood);

  const filtered = openings.filter((o) => (hood === "all" || (hood === CITY_WIDE ? !o.neighbourhood : o.neighbourhood === hood)) && (task === "all" || o.taskId === task));
  const weeks = groupByWeek(filtered);

  // A link to /volunteer#opening-<id> opens that card.
  useEffect(() => {
    const m = /^#opening-([0-9a-f-]+)$/.exec(window.location.hash);
    if (m) requestAnimationFrame(() => document.getElementById(`opening-${m[1]}`)?.scrollIntoView({ block: "start" }));
  }, []);

  return (
    <div className="stack" style={{ gap: 28 }}>
      <div className="filters">
        <SelectField id="filter-neighbourhood" label="Neighbourhood" value={hood} onChange={(e) => setHood(e.target.value)}>
          <option value="all">All of Surrey</option>
          {hoods.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
          {hasCityWide && <option value={CITY_WIDE}>City-wide only</option>}
        </SelectField>
        <SelectField id="filter-task" label="What you'd be doing" value={task} onChange={(e) => setTask(e.target.value)}>
          <option value="all">Anything</option>
          {tasks.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </SelectField>
        <p className="filters-count small" role="status">
          {filtered.length === openings.length ? `${openings.length} shift${openings.length === 1 ? "" : "s"} coming up.` : `${filtered.length} of ${openings.length} shifts match.`}
        </p>
      </div>

      {weeks.length === 0 ? (
        <p className="empty-state">
          {openings.length === 0 ? "No shifts are posted right now." : "No shifts match those filters."}{" "}
          <Link href="/#join">Join as a member</Link> and we&apos;ll tell you when the next ones go up.
        </p>
      ) : (
        weeks.map((week) => (
          <section key={week.sunday} className="week" aria-labelledby={`week-${week.sunday}`}>
            <h2 id={`week-${week.sunday}`} className="week-heading">
              Week of {week.label}
            </h2>
            <ul className="opening-list">
              {week.items.map((o) => (
                <OpeningCard
                  key={o.id}
                  opening={o}
                  notesHtml={notesHtml[o.id]}
                  spotsLeft={Math.max(0, o.spotsLeft - (taken[o.id] ?? 0))}
                  confirmation={done[o.id]}
                  formOpen={openForm === o.id}
                  onToggle={() => setOpenForm(openForm === o.id ? null : o.id)}
                  onDone={(c) => {
                    setDone((d) => ({ ...d, [o.id]: c }));
                    setTaken((t) => ({ ...t, [o.id]: (t[o.id] ?? 0) + 1 }));
                    setOpenForm(null);
                  }}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

function OpeningCard({
  opening: o,
  notesHtml,
  spotsLeft,
  confirmation,
  formOpen,
  onToggle,
  onDone,
}: {
  opening: PublicOpening;
  notesHtml?: string;
  spotsLeft: number;
  confirmation?: SignupConfirmation;
  formOpen: boolean;
  onToggle: () => void;
  onDone: (c: SignupConfirmation) => void;
}) {
  const confirmRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (confirmation) confirmRef.current?.focus();
  }, [confirmation]);

  // Cancelling the form puts focus back on the button that opened it.
  const signUpRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (!formOpen && returnFocus.current) {
      returnFocus.current = false;
      signUpRef.current?.focus();
    }
  }, [formOpen]);
  const cancel = () => {
    returnFocus.current = true;
    onToggle();
  };

  const slot = SLOT_BY_ID[o.slot];
  const { date: dayLabel } = formatDay(o.date);
  const [mon, day] = dayLabel.replace(".", "").split(" ");
  const full = spotsLeft === 0;

  return (
    <li id={`opening-${o.id}`} className={`opening-card ${full ? "is-full" : ""}`}>
      <div className="opening-date" aria-hidden="true">
        <span className="day">{day}</span>
        <span className="mon">{mon}</span>
      </div>
      <div className="opening-body">
        <p className="opening-when">
          {formatLongDate(o.date)} · {slot.label} {slot.hours}
        </p>
        <h3 className="opening-title">{o.title}</h3>
        <p className="opening-meta">
          <span className={`badge ${o.neighbourhood ? "" : "badge--citywide"}`}>{o.neighbourhood ?? "City-wide"}</span>
          {o.taskName && (
            <span className="badge badge--task" style={o.taskColor ? { background: o.taskColor, color: textColorFor(o.taskColor) } : undefined}>
              {o.taskName}
            </span>
          )}
          {o.location && <span>{o.location}</span>}
        </p>
        {notesHtml && <div className="opening-notes" dangerouslySetInnerHTML={{ __html: notesHtml }} />}
        <p className={`spots ${full ? "spots--full" : spotsLeft <= 2 ? "spots--low" : ""}`}>
          {full ? "Full" : `${spotsLeft} of ${o.capacity} spot${spotsLeft === 1 ? "" : "s"} left`}
        </p>
        {confirmation ? (
          <div ref={confirmRef} tabIndex={-1} role="status" className="success-card opening-confirm">
            <h3>You&apos;re signed up</h3>
            <p>
              <strong>{confirmation.title}</strong>: {confirmation.dateLabel}, {confirmation.slotLabel}
              {confirmation.location ? `, ${confirmation.location}` : ""}. Add it to your calendar so it&apos;s there when the day comes.
            </p>
            <AddToCalendar googleUrl={confirmation.googleUrl} icsUrl={confirmation.icsUrl} title={confirmation.title} />
            <ShareButtons
              heading="Bring a neighbour"
              label="Share this shift"
              links={shareLinks({
                url: confirmation.shareUrl,
                text: `I'm volunteering with Imagine Surrey: ${confirmation.title}, ${confirmation.dateLabel}. Come with me!`,
                subject: `Volunteer with me: ${confirmation.title}`,
              })}
            />
          </div>
        ) : full ? (
          <p className="small" style={{ margin: 0 }}>
            This one&apos;s full. Pick another shift, or <Link href="/#join">join</Link> to hear about the next ones first.
          </p>
        ) : (
          <>
            {!formOpen && (
              <button ref={signUpRef} type="button" className="btn btn--red" style={{ alignSelf: "flex-start" }} onClick={onToggle}>
                Sign up<span className="visually-hidden"> for {o.title}</span>
              </button>
            )}
            {formOpen && <SignupForm opening={o} onDone={onDone} onCancel={cancel} />}
          </>
        )}
      </div>
    </li>
  );
}
