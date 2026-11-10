// What a shift is, on screen (shared/shiftkinds.js): its mark, drawn by the
// icon name the catalogue gives, in the kind's own colour.
//
//   <KindIcon kind={kind} />    the mark — decoration: the kind's label is
//                               always in words beside it
//   kindVars(kind)              style for an element that wears the kind's
//                               colour: { '--kind': 'var(--warn)' } — a CSS
//                               variable the app already has, never a hex
//   cardWords(shift)            what a card says: { kind, title, place } —
//                               the kind's label and the place for a made
//                               name ("Burma Shave" / "King George Blvd &
//                               88 Ave"), the typed name where one was typed
import { kindOf, madeTitle } from '@starbase/shared/shiftkinds';

// Line icons on the app's 24-unit grid, drawn like the tab bar's (Shell.jsx).
const PATHS = {
  door: <><path d="M6.5 20.5V5a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 17.5 5v15.5" /><path d="M4 20.5h16" /><path d="M14.2 12.3h.01" /></>,
  phone: <path d="M6.5 3.5h3l1.6 4.3-2.1 1.4a10.5 10.5 0 0 0 5.8 5.8l1.4-2.1 4.3 1.6v3a2 2 0 0 1-2.1 2A15.5 15.5 0 0 1 4.5 5.6a2 2 0 0 1 2-2.1z" />,
  storefront: <><path d="M4.5 10.5v10h15v-10" /><path d="M3 9l1.8-5.5h14.4L21 9a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0z" /><path d="M10 20.5V15h4v5.5" /></>,
  wave: <><path d="M9 12.5V5.6a1.4 1.4 0 0 1 2.8 0v5.2" /><path d="M11.8 10.8V4.4a1.4 1.4 0 0 1 2.8 0v6.6" /><path d="M14.6 11V6.2a1.4 1.4 0 0 1 2.8 0v8.3c0 3.6-2.5 6-6 6-2.6 0-4.1-1.1-5.4-3.3l-2-3.5a1.4 1.4 0 0 1 2.4-1.4L9 15" /></>,
  leaflet: <><path d="M6.5 3.5h7.5l4 4v13h-11.5z" /><path d="M14 3.5v4h4" /><path d="M9.5 12h5M9.5 15.5h5" /></>,
  sign: <><rect x="4" y="4" width="16" height="10" rx="1" /><path d="M12 14v7M9 21h6" /></>,
  calendar: <><rect x="3.5" y="5" width="17" height="15.5" rx="1.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
  desk: <><path d="M3 10h18" /><path d="M5 10v9.5M19 10v9.5" /><path d="M12.5 10v5.5h6.5" /><path d="M8 6.5h5V10H8z" /></>,
  dot: <circle cx="12" cy="12" r="3.5" />,
};

export function KindIcon({ kind }) {
  return (
    <svg className="sk-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[kind?.icon] || PATHS.dot}
    </svg>
  );
}

export const kindVars = (kind) => ({ '--kind': `var(${kind?.color || '--text-4'})` });

const has = (text, part) => String(text || '').toLowerCase().includes(String(part || '').toLowerCase());

export const cardWords = (shift) => {
  const kind = kindOf(shift);
  const place = String(shift.location || '').trim();
  // A made name is its kind and its place: say each once.
  if (shift.title === madeTitle(kind.code, place)) return { kind, title: kind.name || kind.label, place: place || null };
  return { kind, title: shift.title, place: place && !has(shift.title, place) ? place : null };
};
