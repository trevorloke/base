// "When", by tap: the kind's usual hours as chips (Burma Shave 6:30–8:30 am,
// Canvass 10–1 · 2–5 · 6–8) and, for anything else, "Another time" — a part
// of the day, a start every half hour from 5 am, a length, and a quarter
// hour either way on each ("Starts", "Ends"): 6:45–8:15, or 8 pm to 1 am the
// next day. Nothing is typed, and the server turns the clock times into
// moments on the campaign's clock.
//
//   value   { slots: ['06:30-08:30', …], other: null | { start, minutes } }
//           slots: the usual hours chosen; other: another time, open —
//           start null until one is tapped, minutes null for a shift that
//           has no end
//   many    several may be chosen at once (the add sheet: a morning and an
//           afternoon); otherwise exactly one (a shift being changed)
//   own     a shift being changed: its own { start, end, minutes } — kept
//           among the chips even where the half-hour grid has none (an
//           11:45 pm start, four and a quarter hours); minutes is how long
//           it really runs, past midnight or not
//
//   timesOf(value)        → [{ start, end, minutes, nextDay }] soonest first,
//                           each start once; end is a clock time, on the
//                           next day when nextDay
//   timeInput(t)          → what a write takes for one of them: the end when
//                           it's the same day, else the length (only that
//                           can say past midnight)
//   whenFor(kind, shift?) → the value a sheet opens with
import { useState } from 'react';
import { WEEK_PARTS, spanWords, weekPartOf } from '@starbase/shared/dayparts';
import './schedule-hours.css';

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (s) => `${s.start}-${s.end}`;
const LENGTHS = [[60, '1 h'], [90, '1½ h'], [120, '2 h'], [180, '3 h'], [240, '4 h'], [360, '6 h']];
// Every half hour from 5:00 am to 11:30 pm.
const STARTS = Array.from({ length: 38 }, (_, i) => `${pad(5 + Math.floor(i / 2))}:${i % 2 ? '30' : '00'}`);
const DAY = 24 * 60;
const STEP = 15;
const LATEST_START = DAY - STEP; // 11:45 pm
const LONGEST = 16 * 60; // the longest shift made by tap
const clockMinutes = (clock) => {
  const [h, m] = clock.split(':').map(Number);
  return h * 60 + m;
};
const clockAt = (t) => `${pad(Math.floor(t / 60) % 24)}:${pad(t % 60)}`;
// Minutes from one clock time to a later one on the same day.
const span = (start, end) => {
  const [h, m] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return (eh * 60 + em) - (h * 60 + m);
};
// A length the chips don't have: "5 h", "2½ h", "45 min", "4 h 15 min".
const lengthWords = (minutes) => {
  const h = Math.floor(minutes / 60);
  const r = minutes % 60;
  if (!h) return `${r} min`;
  if (!r) return `${h} h`;
  return r === 30 ? `${h}½ h` : `${h} h ${r} min`;
};
// How long, the way the Ends row says it: "2 h", "1 h 30 min", "45 min".
const lengthLong = (minutes) => {
  const h = Math.floor(minutes / 60);
  const r = minutes % 60;
  return [h ? `${h} h` : null, r ? `${r} min` : null].filter(Boolean).join(' ');
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
// A stepped time to the minute: "6:45 am", "1:00 am".
const exactWords = (clock) => {
  const [h, m] = clock.split(':').map(Number);
  return `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'am' : 'pm'}`;
};

// One start and length as a time: its end, and whether that is the next day.
const timeOf = (start, minutes) => {
  if (!minutes) return { start, end: null, minutes: null, nextDay: false };
  const t = clockMinutes(start) + minutes;
  return { start, end: clockAt(t), minutes, nextDay: t >= DAY };
};
export const timeInput = (t) => (t.nextDay ? { start: t.start, minutes: t.minutes } : { start: t.start, ...(t.end ? { end: t.end } : {}) });

export const timesOf = (value) => {
  const byStart = new Map();
  for (const key of value.slots) {
    const [start, end] = key.split('-');
    byStart.set(start, timeOf(start, span(start, end)));
  }
  const o = value.other;
  // Another time that starts with a usual one stands in for it.
  if (o?.start) byStart.set(o.start, timeOf(o.start, o.minutes || null));
  return [...byStart.values()].sort((a, b) => a.start.localeCompare(b.start));
};

// A new shift opens on the kind's first usual hours; a shift being changed
// on its own — as a usual chip when it is one, else as another time (its
// own length, past midnight too).
export const whenFor = (kind, at = null) => {
  if (at) {
    const usual = kind.slots.find((s) => s.start === at.start && s.end === at.end);
    if (usual) return { slots: [keyOf(usual)], other: null };
    return { slots: [], other: { start: at.start, minutes: at.minutes ?? (at.end ? span(at.start, at.end) : null) } };
  }
  return kind.slots.length ? { slots: [keyOf(kind.slots[0])], other: null } : { slots: [], other: { start: null, minutes: kind.minutes } };
};

export default function When({ kind, value, onChange, many = false, own = null }) {
  const other = value.other;
  const [part, setPart] = useState(() => weekPartOf(other?.start || '06:00'));
  const [lastUsual, setLastUsual] = useState(null); // the usual chip tapped last, on or off
  const pickUsual = (key) => {
    setLastUsual(key);
    if (!many) { onChange({ slots: [key], other: null }); return; }
    const on = value.slots.includes(key);
    onChange({ ...value, slots: on ? value.slots.filter((k) => k !== key) : [...value.slots, key] });
  };
  // Another time opens on the hours already chosen — the usual chip tapped
  // last, or the kind's first — and that chip goes off, so a nudge never
  // leaves two shifts a quarter hour apart. A kind with no usual hours
  // opens with no start.
  const toggleOther = () => {
    if (!other) {
      const seedKey = lastUsual || value.slots[value.slots.length - 1] || (kind.slots[0] ? keyOf(kind.slots[0]) : null);
      if (!seedKey) { onChange({ slots: many ? value.slots : [], other: { start: null, minutes: kind.minutes } }); return; }
      const [start, end] = seedKey.split('-');
      setPart(weekPartOf(start));
      onChange({ slots: many ? value.slots.filter((k) => k !== seedKey) : [], other: { start, minutes: span(start, end) } });
    }
    // Closing it needs another time to fall back on.
    else if (many || kind.slots.length) onChange({ slots: value.slots.length || many ? value.slots : [keyOf(kind.slots[0])], other: null });
  };
  const setOther = (patch) => onChange({ ...value, other: { ...other, ...patch } });
  // Its own start and length are chips too, whatever they are.
  const ownMinutes = own?.minutes > 0 ? own.minutes : null;
  const starts = (own?.start && !STARTS.includes(own.start) ? [...STARTS, own.start].sort() : STARTS).filter((c) => weekPartOf(c) === part);
  const lengths = ownMinutes && !LENGTHS.some(([m]) => m === ownMinutes)
    ? [...LENGTHS, [ownMinutes, lengthWords(ownMinutes)]].sort((a, b) => a[0] - b[0]) : LENGTHS;
  // Still on its own hours. One that runs past midnight has no end the taps
  // can make (minutes null), so its real length is the one shown chosen.
  const ownOpen = own ? whenFor(kind, own).other : null;
  const shown = other?.minutes ?? null;
  // Another start keeps the length shown; its own start puts its own hours
  // back.
  const pickStart = (c) => setOther(ownOpen && c === ownOpen.start && c !== other.start ? ownOpen : { start: c, minutes: shown });
  // A quarter hour either way. The start stays on its day (12:00 am to
  // 11:45 pm) and keeps its length; the length runs 15 minutes to 16 hours.
  const nudgeStart = (d) => {
    const c = clockAt(clamp(clockMinutes(other.start) + d, 0, LATEST_START));
    setPart(weekPartOf(c));
    setOther({ start: c });
  };
  // (A longer shift the long form made only gets shorter from here: never
  // cut to 16 hours by one tap.)
  const nudgeEnd = (d) => setOther({ minutes: clamp(shown + d, STEP, Math.max(LONGEST, shown)) });
  const t = other?.start ? timeOf(other.start, shown) : null;
  // Its own length at its own start is its own hours again — the way back
  // from a length tapped by mistake, even where it runs to midnight or past.
  // A shift with no end has no chip to go back to: there the chosen length,
  // tapped again, comes off.
  const ownLength = (m) => !!ownOpen && other?.start === ownOpen.start && m === ownMinutes;
  const pickLength = (m) => {
    if (shown !== m) setOther(ownLength(m) ? ownOpen : { minutes: m });
    else if (own && !ownMinutes) setOther({ minutes: null });
  };

  return (
    <div className="sch-when">
      {kind.slots.length > 0 && (
        <div className="sch-chips" role="group" aria-label="Usual times">
          {kind.slots.map((s) => (
            <button key={keyOf(s)} type="button" className="sch-chip" aria-pressed={value.slots.includes(keyOf(s))} onClick={() => pickUsual(keyOf(s))}>
              {spanWords(s.start, s.end)}
            </button>
          ))}
          <button type="button" className="sch-chip" aria-pressed={!!other} aria-expanded={!!other} onClick={toggleOther}>Another time</button>
        </div>
      )}
      {other && (
        <div className="sch-other">
          <div className="ops-seg sch-parts" role="group" aria-label="Part of the day">
            {WEEK_PARTS.map((p) => (
              <button key={p.code} type="button" aria-pressed={part === p.code} onClick={() => setPart(p.code)}>{p.label}</button>
            ))}
          </div>
          <div className="sch-chips" role="group" aria-label="Starts at">
            {starts.map((c) => (
              <button key={c} type="button" className="sch-chip" aria-pressed={other.start === c} onClick={() => pickStart(c)}>
                {spanWords(c)}
              </button>
            ))}
          </div>
          <div className="sch-chips" role="group" aria-label="How long">
            {lengths.map(([m, words]) => (
              <button key={m} type="button" className="sch-chip" aria-pressed={shown === m}
                onClick={() => pickLength(m)}>
                {words}
              </button>
            ))}
          </div>
          {t && (
            <div className="shh-steps" role="group" aria-label="Starts">
              <span className="shh-steps__label">Starts</span>
              <button type="button" className="btn btn-quiet shh-step" aria-label="15 minutes earlier" disabled={clockMinutes(t.start) <= 0} onClick={() => nudgeStart(-STEP)}>− 15 min</button>
              <output className="shh-steps__value" aria-live="polite">{exactWords(t.start)}</output>
              <button type="button" className="btn btn-quiet shh-step" aria-label="15 minutes later" disabled={clockMinutes(t.start) >= LATEST_START} onClick={() => nudgeStart(STEP)}>+ 15 min</button>
            </div>
          )}
          {t?.end && (
            <div className="shh-steps" role="group" aria-label="Ends">
              <span className="shh-steps__label">Ends</span>
              <button type="button" className="btn btn-quiet shh-step" aria-label="15 minutes earlier" disabled={shown <= STEP} onClick={() => nudgeEnd(-STEP)}>− 15 min</button>
              <output className="shh-steps__value" aria-live="polite"><span>{exactWords(t.end)}{t.nextDay ? ' next day' : ''}</span> · <span>{lengthLong(shown)}</span></output>
              <button type="button" className="btn btn-quiet shh-step" aria-label="15 minutes later" disabled={shown >= LONGEST} onClick={() => nudgeEnd(STEP)}>+ 15 min</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
