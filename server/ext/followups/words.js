// A follow-up's words: what the person did, in one line, as the organizer's
// Today and the desk's Follow-ups say it. Each entry of detail.did is one
// thing they did: { kind, from, at, … } (hook.js).
//   kind  'volunteer' | 'message' | 'rsvp'
//   from  'website' (the site's forms, or the intake API), 'door' (Ask the
//         office at a door or on a call), 'mainstreet', 'membership'
export const KINDS = ['volunteer', 'message', 'rsvp'];

const clip = (s, n) => {
  const t = String(s ?? '').trim().replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export const didWords = (d) => {
  if (!d) return '';
  if (d.kind === 'volunteer') {
    if (d.from === 'website') return 'Offered to volunteer on the website';
    if (d.from === 'mainstreet') return d.place ? `Wants to volunteer — met at ${clip(d.place, 60)}` : 'Wants to volunteer — met mainstreeting';
    if (d.from === 'membership') return 'Wants to volunteer — on their membership form';
    return d.asked_by ? `Wants to volunteer — told ${clip(d.asked_by, 60)}` : 'Wants to volunteer';
  }
  if (d.kind === 'message') return d.topic ? `Wrote on the website: ${clip(d.topic, 60)}` : 'Wrote on the website';
  if (d.kind === 'rsvp') return d.shift?.title ? `New — RSVP’d to ${clip(d.shift.title, 80)}` : 'New — RSVP’d on the website';
  return '';
};

// The follow-up's line: the first thing they did, and how many more since.
export const summary = (did) => {
  const list = Array.isArray(did) ? did : [];
  if (!list.length) return 'Follow up';
  const more = list.length - 1;
  return `${didWords(list[0])}${more > 0 ? ` (+${more} more)` : ''}`.slice(0, 300);
};
