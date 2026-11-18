// Sample words that must never go on the site (WA decision 18): the page
// starters' words (shared/site/starters.js, which re-exports this) and the
// catalogue's own hero sample. Keyed by kind and field — a list item's by
// its list and sub-field with a * for the item ('columns.items.*.title').
// A draft may hold them; Publish (the catalogue's strict check) refuses any
// box whose trimmed words are exactly one of these, and opens that box.
// Nothing here is about any one campaign.
export const PLACEHOLDERS = {
  'hero.titlePrefix': [
    'Your campaign headline',
    'Your issue’s headline',
    'Your event’s name',
    'What your petition asks for',
    'Who we are',
    'Get involved',
  ],
  'hero.text': [
    'One or two sentences on what you stand for and what you want visitors to do next.',
    'One or two sentences on the problem and what you’d do about it.',
    'When and where it is, and why people should come.',
    'Why it matters, in one or two sentences.',
    'One or two sentences on who you are and what you want for your community.',
    'One or two sentences on why people should join in.',
  ],
  'text.title': ['What’s happening', 'What to expect', 'Why this matters', 'Our story', 'How to reach us'],
  'text.body': [
    'Explain the issue in plain words. Short paragraphs read best on phones.',
    'Who it’s for, what will happen, and anything to bring.',
    'Give the reasons in plain words. Short paragraphs read best on phones.',
    'How you started and what you’re working for.',
    'Tell people the best way to reach you and when you’ll answer.',
  ],
  'columns.items.*.title': ['A point'],
  'columns.items.*.body': ['One or two sentences on this point.'],
  'people.seats.*.role': ['Their role'],
  'people.seats.*.name': ['Their name'],
  'people.seats.*.bio': ['A sentence or two about them.'],
  'quote.quote': ['A few words from someone who supports you.'],
  'quote.name': ['Their name'],
  'quote.role': ['Who they are'],
  'groups.items.*.title': ['A group’s name'],
  'groups.items.*.body': ['What this group does, in a sentence.'],
};

// Typed with a plain apostrophe, the sample is still the sample.
const norm = (s) => String(s ?? '').trim().replace(/'/g, '’');
const SETS = Object.fromEntries(Object.entries(PLACEHOLDERS).map(([k, v]) => [k, new Set(v.map(norm))]));

// The first box of a module's (checked) props still holding sample words,
// as the catalogue's path ('titlePrefix', 'items[2].title'), or null.
export function samplePath(kind, props) {
  const p = props && typeof props === 'object' ? props : {};
  for (const [key, set] of Object.entries(SETS)) {
    const [k, field, star, sub] = key.split('.');
    if (k !== kind) continue;
    if (star === '*') {
      const list = Array.isArray(p[field]) ? p[field] : [];
      for (let i = 0; i < list.length; i += 1) {
        const v = list[i]?.[sub];
        if (typeof v === 'string' && set.has(norm(v))) return `${field}[${i}].${sub}`;
      }
    } else if (typeof p[field] === 'string' && set.has(norm(p[field]))) {
      return field;
    }
  }
  return null;
}
