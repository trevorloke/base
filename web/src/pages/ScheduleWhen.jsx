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
//   own     a shift being changed: its own { start, end, minutes } — kept
//           among the chips even where the half-hour grid has none (an
//           11 pm start, 5:45 am, four and a quarter hours); minutes is
//           how long it really runs, past midnight or not
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
// Minutes from one clock time to a later one on the same day.
const span = (start, end) => {
  const [h, m] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return (eh * 60 + em) - (h * 60 + m);
};
// A length the four chips don't have: "4 h", "2½ h", "45 min", "4 h 15 min".
const lengthWords = (minutes) => {
  const h = Math.floor(minutes / 60);
  const r = minutes % 60;
  if (!h) return `${r} min`;
  if (!r) return `${h} h`;
  return r === 30 ? `${h}½ h` : `${h} h ${r} min`;
};

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
    return { slots: [], other: { start: at.start, minutes: at.end ? span(at.start, at.end) : null } };
  }
  return kind.slots.length ? { slots: [keyOf(kind.slots[0])], other: null } : { slots: [], other: { start: null, minutes: kind.minutes } };
};

export default function When({ kind, value, onChange, many = false, own = null }) {
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
  // Its own start and length are chips too, whatever they are.
  const ownMinutes = own?.minutes > 0 ? own.minutes : null;
  const starts = (own?.start && !STARTS.includes(own.start) ? [...STARTS, own.start].sort() : STARTS).filter((c) => weekPartOf(c) === part);
  const lengths = ownMinutes && !LENGTHS.some(([m]) => m === ownMinutes)
    ? [...LENGTHS, [ownMinutes, lengthWords(ownMinutes)]].sort((a, b) => a[0] - b[0]) : LENGTHS;
  // Still on its own hours. One that runs past midnight has no end the taps
  // can make (minutes null), so its real length is the one shown chosen.
  const ownOpen = own ? whenFor(kind, own).other : null;
  const onOwn = !!ownOpen && other?.start === ownOpen.start && other.minutes === ownOpen.minutes;
  const shown = other?.minutes ?? (onOwn ? ownMinutes : null);
  // Another start keeps the length shown, or an hour where that would run
  // past midnight; its own start puts its own hours back.
  const pickStart = (c) => setOther(ownOpen && c === ownOpen.start && c !== other.start ? ownOpen
    : { start: c, minutes: shown && !addClock(c, shown) ? 60 : shown });
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
                disabled={!!other.start && !addClock(other.start, m) && shown !== m && !ownLength(m)}
                onClick={() => pickLength(m)}>
                {words}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
