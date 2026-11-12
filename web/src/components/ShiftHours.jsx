// A person's own part of a shift — the hours they said they'll do (a
// booking's arrive_at / leave_at: the plan, not who came). One picker for
// the volunteer's "Change my hours" and the desk's person sheet, built from
// the shift's own moments on the campaign's clock, so a shift that runs
// past midnight works the same.
//
//   ownHours(shift, booking)  → { from, to } — null/null for the whole shift
//   hoursWords(shift, booking, tz) → "4:30–6 pm", or null for the whole shift
//   canPickHours(shift, now)  → it has an end, runs an hour or more, isn't over
//   <HoursPicker shift tz value onChange />  The whole time · From · Until
import { hoursOf } from '@starbase/shared/shifthours';
import { timeRange, clockText } from './shiftTime.js';
import '../pages/schedule-hours.css';

const HALF = 30 * 60e3;
const ms = (iso) => new Date(iso).getTime();

export const ownHours = (booking) => (booking?.arrive_at && booking?.leave_at
  ? { from: booking.arrive_at, to: booking.leave_at } : { from: null, to: null });

export const hoursWords = (shift, booking, tz) => {
  const h = hoursOf(shift, booking);
  return h.part ? timeRange(h.starts_at, h.ends_at, tz) : null;
};

export const canPickHours = (shift, now = new Date()) => !!shift?.ends_at
  && ms(shift.ends_at) - ms(shift.starts_at) >= 2 * HALF && ms(shift.ends_at) > now.getTime();

// The shift's start, then every :00 and :30 inside it, up to half an hour
// before the end.
const fromChoices = (start, end) => {
  const out = [start];
  for (let t = Math.ceil((start + 1) / HALF) * HALF; t <= end - HALF; t += HALF) out.push(t);
  return out;
};
// Every :00 and :30 from half an hour after "From" to the end, and the end.
const untilChoices = (from, end) => {
  const out = [];
  for (let t = Math.ceil((from + HALF) / HALF) * HALF; t < end; t += HALF) out.push(t);
  out.push(end);
  return out;
};

export function HoursPicker({ shift, tz, value, onChange, disabled = false }) {
  const start = ms(shift.starts_at);
  const end = ms(shift.ends_at);
  const from = value.from ? ms(value.from) : start;
  const to = value.to ? ms(value.to) : end;
  const whole = from === start && to === end;
  const iso = (t) => new Date(t).toISOString();
  // Exactly the whole shift is said as null/null (the server stores it so).
  const set = (f, t) => onChange(f === start && t === end ? { from: null, to: null } : { from: iso(f), to: iso(t) });
  // A new "From" keeps "Until" when it still leaves half an hour.
  const pickFrom = (f) => set(f, to - f >= HALF ? to : end);
  const chip = (t, pressed, onClick, label) => (
    <button key={t} type="button" className="sch-chip" aria-pressed={pressed} disabled={disabled} onClick={onClick}>{label}</button>
  );
  return (
    <div className="shh-pick">
      <div className="sch-chips">
        {chip('whole', whole, () => set(start, end), 'The whole time')}
      </div>
      <p className="shh-pick__label" id={`shh-from-${shift.id}`}>From</p>
      <div className="sch-chips" role="group" aria-labelledby={`shh-from-${shift.id}`}>
        {fromChoices(start, end).map((t) => chip(t, t === from, () => pickFrom(t), clockText(t, tz)))}
      </div>
      <p className="shh-pick__label" id={`shh-until-${shift.id}`}>Until</p>
      <div className="sch-chips" role="group" aria-labelledby={`shh-until-${shift.id}`}>
        {untilChoices(from, end).map((t) => chip(t, t === to, () => set(from, t), clockText(t, tz)))}
      </div>
      <p className="ops-sr" aria-live="polite">{whole ? 'The whole time' : timeRange(iso(from), iso(to), tz)}</p>
    </div>
  );
}
