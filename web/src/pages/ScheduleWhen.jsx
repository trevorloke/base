// "When", by tap: the kind's usual hours as chips (Burma Shave 6:30–8:30 am,
// Canvass 10–1 · 2–5 · 6–8) and, for anything else, "Another time" — a part
// of the day, a start every half hour from 6 am, and a length. Nothing is
// typed, and the server turns the clock times into moments on the
// campaign's clock.
//
//   value   { slots: ['06:30-08:30', …], other: null | { start, minutes } }
//           slots: the usual hours chosen; other: another time, open —
//           start null until one is tapped, minutes null for a shift that
//           has no end
//   many    several may be chosen at once (the add sheet: a morning and an
//           afternoon); otherwise exactly one (a shift being changed)
//
//   timesOf(value)        → [{ start, end }] soonest first, each start once
//   whenFor(kind, shift?) → the value a sheet opens with
import { useState } from 'react';
import { WEEK_PARTS, addClock, spanWords, weekPartOf } from '@starbase/shared/dayparts';

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (s) => `${s.start}-${s.end}`;
const LENGTHS = [[60, '1 h'], [90, '1½ h'], [120, '2 h'], [180, '3 h']];
// Every half hour from 6:00 am to 9:30 pm.
const STARTS = Array.from({ length: 32 }, (_, i) => `${pad(6 + Math.floor(i / 2))}:${i % 2 ? '30' : '00'}`);

export const timesOf = (value) => {
  const byStart = new Map();
  for (const key of value.slots) {
    const [start, end] = key.split('-');
    byStart.set(start, { start, end });
  }
  const o = value.other;
  // Another time that starts with a usual one stands in for it.
  if (o?.start) {
    const end = o.minutes ? addClock(o.start, o.minutes) : null;
    if (end || !o.minutes) byStart.set(o.start, { start: o.start, end });
  }
  return [...byStart.values()].sort((a, b) => a.start.localeCompare(b.start));
};

// A new shift opens on the kind's first usual hours; a shift being changed
// on its own — as a usual chip when it is one, else as another time.
export const whenFor = (kind, at = null) => {
  if (at) {
    const usual = kind.slots.find((s) => s.start === at.start && s.end === at.end);
    if (usual) return { slots: [keyOf(usual)], other: null };
    const [h, m] = at.start.split(':').map(Number);
    const [eh, em] = (at.end || '').split(':').map(Number);
    return { slots: [], other: { start: at.start, minutes: at.end ? (eh * 60 + em) - (h * 60 + m) : null } };
  }
  return kind.slots.length ? { slots: [keyOf(kind.slots[0])], other: null } : { slots: [], other: { start: null, minutes: kind.minutes } };
};

export default function When({ kind, value, onChange, many = false }) {
  const other = value.other;
  const [part, setPart] = useState(() => weekPartOf(other?.start || '06:00'));
  const pickUsual = (key) => {
    if (!many) { onChange({ slots: [key], other: null }); return; }
    const on = value.slots.includes(key);
    onChange({ ...value, slots: on ? value.slots.filter((k) => k !== key) : [...value.slots, key] });
  };
  const toggleOther = () => {
    if (!other) onChange({ slots: many ? value.slots : [], other: { start: null, minutes: kind.minutes } });
    // Closing it needs another time to fall back on.
    else if (many || kind.slots.length) onChange({ slots: value.slots.length || many ? value.slots : [keyOf(kind.slots[0])], other: null });
  };
  const setOther = (patch) => onChange({ ...value, other: { ...other, ...patch } });
  const starts = STARTS.filter((c) => weekPartOf(c) === part);

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
              <button key={c} type="button" className="sch-chip" aria-pressed={other.start === c}
                onClick={() => setOther({ start: c, minutes: other.minutes && !addClock(c, other.minutes) ? 60 : other.minutes })}>
                {spanWords(c)}
              </button>
            ))}
          </div>
          <div className="sch-chips" role="group" aria-label="How long">
            {LENGTHS.map(([m, words]) => (
              <button key={m} type="button" className="sch-chip" aria-pressed={other.minutes === m}
                disabled={!!other.start && !addClock(other.start, m)} onClick={() => setOther({ minutes: m })}>
                {words}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
