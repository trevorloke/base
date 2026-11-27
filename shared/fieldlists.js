// The pick lists every campaign starts with — Faith, Dwelling type and
// Language — and the small rules the server and the screens share about
// choices: how two spellings are the same choice (choiceKey), which words
// a person's typed answer probably meant (guessChoice: only ever a
// pre-fill a person confirms), how a long list draws in groups (groupsOf),
// and which words Pick several would read as two (splits).
//
// These are the product's own: general, and the same for every campaign. A
// list that belongs to one campaign (its campuses, its own order of
// languages) is that campaign's server's to send (GET /api/fields), never
// written here.
//
// No choice here contains , ; | / — the characters Pick several splits a
// cell on — so a manager who turns one of these into Pick several loses
// nothing. Apostrophes are the plain ' and the dash between a group and
// its member is an en dash with a space each side ("Christian – Catholic").

// In a–z order: the Christian churches together (a–z, "Other" last of
// them), then Other religion / No religion / Prefer not to say. A campaign
// puts its own order on the list under Profile fields.
// "Just Christian (no church named)" is the census's "Christian, n.o.s.";
// "Evangelical or non-denominational" is how people in independent
// churches describe themselves (not a census row). Two different answers.
export const FAITHS = [
  'Buddhist',
  'Christian – Anglican',
  'Christian – Baptist',
  'Christian – Catholic',
  'Christian – Evangelical or non-denominational',
  'Christian – Greek Orthodox',
  'Christian – Jehovah’s Witness',
  'Christian – Just Christian (no church named)',
  'Christian – Latter Day Saints',
  'Christian – Lutheran',
  'Christian – Mennonite or Anabaptist',
  'Christian – Methodist or Wesleyan',
  'Christian – Other Orthodox',
  'Christian – Pentecostal or Charismatic',
  'Christian – Presbyterian',
  'Christian – Reformed',
  'Christian – Russian Orthodox',
  'Christian – Serbian Orthodox',
  'Christian – Ukrainian Orthodox',
  'Christian – United Church',
  'Christian – Other',
  'Hindu',
  'Indigenous spirituality',
  'Jewish',
  'Muslim',
  'Sikh',
  'Other religion',
  'No religion',
  'Prefer not to say',
];

// The Language field's choices (Pick several): a–z, Other last. A campaign
// changes the list under Profile fields.
export const LANGUAGES = [
  'Arabic', 'Bengali', 'Cantonese', 'Cree', 'English', 'Farsi', 'French', 'German', 'Greek', 'Gujarati', 'Hindi', 'Inuktitut',
  'Italian', 'Japanese', 'Korean', 'Mandarin', 'Polish', 'Portuguese', 'Punjabi', 'Russian', 'Somali', 'Spanish', 'Tagalog',
  'Tamil', 'Ukrainian', 'Urdu', 'Vietnamese', 'Other',
];

// Plain words that make sense in any city or country; floors, not units,
// because a volunteer on the sidewalk can count floors.
export const DWELLING_TYPES = [
  'House',
  'Semi-detached or side-by-side duplex',
  'Townhouse or row house',
  'Suite in a house (basement or upper)',
  'Low-rise apartment (1–4 floors)',
  'High-rise apartment (5+ floors)',
  'Mobile or manufactured home',
  'Seniors’ or care home',
  'Student residence',
  'Other (boat or RV or rooming house)',
  'Not sure',
];

// No campus comes with the product. A campaign that has a list of them is
// sent it by its own server (GET /api/fields → standard.campus).
export const CAMPUSES = [];

// The characters Pick several reads a cell apart on (server kinds.js).
export const MANY_SPLIT = /[;,|/\n]/;
export const splits = (word) => MANY_SPLIT.test(String(word ?? ''));

// Two spellings of one choice: trimmed, any case, runs of spaces as one,
// curly apostrophes as ', and a dash with a space each side as " – "
// ("christian - catholic" is "Christian – Catholic"; "1-4" stays "1-4").
// Its SQL twin is CHOICE_KEY_SQL (server ext/fields/kinds.js).
// The steps are CHOICE_KEY_SQL's, one for one, so the two always agree.
export const choiceKey = (s) => String(s ?? '').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim()
  .replace(/ - /g, ' – ').replace(/ — /g, ' – ').toLowerCase();

// A Text field "suits a list" when it has at most this many different
// words, or its LIST_TOP most common words cover LIST_COVER of the people
// who have one (ext/fields: Turn into a list).
export const LIST_WORDS_MAX = 500;
export const LIST_TOP = 40;
export const LIST_COVER = 0.8;
export const suitsList = ({ words, top40, people }) => words <= LIST_WORDS_MAX || (people > 0 && top40 >= LIST_COVER * people);

// Lower-case words → the choice they probably mean, by the field's name.
// Only a pre-fill for a person to confirm, never saved on its own. No guess
// for a bare apartment, condo or flat (how tall?).
const DWELLING_GUESS = {
  House: ['house', 'detached', 'single detached', 'single-detached house', 'single family'],
  'Semi-detached or side-by-side duplex': ['semi', 'semi-detached', 'duplex', 'side by side'],
  'Townhouse or row house': ['townhouse', 'townhome', 'town house', 'row house', 'rowhouse'],
  'Suite in a house (basement or upper)': ['suite', 'basement', 'basement suite', 'secondary suite', 'in-law suite'],
  'High-rise apartment (5+ floors)': ['high-rise', 'highrise', 'tower'],
  'Low-rise apartment (1–4 floors)': ['low-rise', 'lowrise', 'walk-up', 'walkup'],
  'Mobile or manufactured home': ['mobile', 'mobile home', 'manufactured', 'trailer'],
  'Seniors’ or care home': ['care home', 'nursing home', 'seniors', 'assisted living'],
  'Student residence': ['dorm', 'residence', 'student residence'],
  'Not sure': ['unknown', 'not sure', '?'],
};
// { choice: [its words] } → { word: choice }.
export const flipGuesses = (m) => Object.fromEntries(Object.entries(m || {}).flatMap(([to, words]) => words.map((w) => [w, to])));
export const GUESSES = { 'dwelling type': flipGuesses(DWELLING_GUESS) };

// → the choice a word probably means, or null: the choice itself in any
// spelling first, then the field's guesses (when that choice is still on
// its list). extra: the campaign's own guesses as its server sends them
// (GET /api/fields → guesses), in the shape of GUESSES.
export const guessChoice = (fieldName, word, choices = [], extra = null) => {
  const k = choiceKey(word);
  if (!k) return null;
  const hit = choices.find((c) => choiceKey(c) === k);
  if (hit) return hit;
  const name = choiceKey(fieldName);
  const own = extra && typeof extra === 'object' ? extra[name] : null;
  const to = GUESSES[name]?.[k] ?? (own && typeof own === 'object' && typeof own[k] === 'string' ? own[k] : null);
  return to ? choices.find((c) => choiceKey(c) === choiceKey(to)) || null : null;
};

// How a control draws a long list: [{ choice }] and [{ group, members:
// [{ choice, short }] }] in the list's order. Choices "A – B" with the same
// A, two or more, are one group at the place of the first; short is B.
// Only for a field of more than GROUP_OVER choices (Faith), so a short list
// stays plain buttons.
export const GROUP_OVER = 12;
const GROUP_RE = /\s[–-]\s/;
const partsOf = (c) => {
  const m = GROUP_RE.exec(c);
  return m ? { head: c.slice(0, m.index).trim(), short: c.slice(m.index + m[0].length).trim() } : null;
};
export const groupsOf = (choices = []) => {
  if (choices.length <= GROUP_OVER) return choices.map((choice) => ({ choice }));
  const count = new Map();
  for (const c of choices) { const p = partsOf(c); if (p) count.set(choiceKey(p.head), (count.get(choiceKey(p.head)) || 0) + 1); }
  const out = [];
  const seen = new Map();
  for (const choice of choices) {
    const p = partsOf(choice);
    const key = p && choiceKey(p.head);
    if (!p || count.get(key) < 2) { out.push({ choice }); continue; }
    if (!seen.has(key)) { const g = { group: p.head, members: [] }; seen.set(key, g); out.push(g); }
    seen.get(key).members.push({ choice, short: p.short });
  }
  return out;
};
// The choices of the group a filter names ("Christian – *"), or null when
// the words don't name a group.
export const groupMembers = (choices, want) => {
  const m = /^(.*\S)\s[–-]\s\*$/.exec(String(want ?? '').trim());
  if (!m) return null;
  const g = groupsOf(choices).find((x) => x.group && choiceKey(x.group) === choiceKey(m[1]));
  return g ? g.members.map((x) => x.choice) : [];
};
