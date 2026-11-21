// The three pick lists a campaign starts with — Faith, Dwelling type and
// Campus — and the small rules the server and the screens share about
// choices: how two spellings are the same choice (choiceKey), which words
// a person's typed answer probably meant (guessChoice: only ever a
// pre-fill a person confirms), how a long list draws in groups (groupsOf),
// and which words Pick several would read as two (splits).
//
// No choice here contains , ; | / — the characters Pick several splits a
// cell on — so a manager who turns one of these into Pick several loses
// nothing. Apostrophes are the plain ' and the dash between a group and
// its member is an en dash with a space each side ("Christian – Catholic").

// Surrey's largest first (2021 census), the Christian churches together,
// then the rest, then Other religion / No religion / Prefer not to say.
// "Just Christian (no church named)" is the census's "Christian, n.o.s.";
// "Evangelical or non-denominational" is how people in independent
// churches describe themselves (not a census row). Two different answers.
export const FAITHS = [
  'Sikh',
  'Christian – Just Christian (no church named)',
  'Christian – Catholic',
  'Christian – Anglican',
  'Christian – United Church',
  'Christian – Baptist',
  'Christian – Pentecostal or Charismatic',
  'Christian – Evangelical or non-denominational',
  'Christian – Greek Orthodox',
  'Christian – Serbian Orthodox',
  'Christian – Russian Orthodox',
  'Christian – Ukrainian Orthodox',
  'Christian – Other Orthodox',
  'Christian – Lutheran',
  'Christian – Presbyterian',
  'Christian – Jehovah’s Witness',
  'Christian – Mennonite or Anabaptist',
  'Christian – Reformed',
  'Christian – Latter Day Saints',
  'Christian – Methodist or Wesleyan',
  'Christian – Other',
  'Muslim',
  'Hindu',
  'Buddhist',
  'Jewish',
  'Indigenous spirituality',
  'Other religion',
  'No religion',
  'Prefer not to say',
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

// School and campus together, one pick.
export const CAMPUSES = [
  'Kwantlen Polytechnic University – Surrey',
  'Kwantlen Polytechnic University – Cloverdale',
  'SFU Surrey',
];

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
// for a bare apartment, condo or flat (how tall?), or a bare kwantlen, kpu
// or sfu (which campus?).
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
const CAMPUS_GUESS = {
  'Kwantlen Polytechnic University – Surrey': ['kpu surrey', 'kwantlen surrey', 'kpu newton', 'kwantlen newton'],
  'Kwantlen Polytechnic University – Cloverdale': ['kpu cloverdale', 'kwantlen cloverdale'],
  'SFU Surrey': ['sfu surrey', 'simon fraser surrey'],
};
const flip = (m) => Object.fromEntries(Object.entries(m).flatMap(([to, words]) => words.map((w) => [w, to])));
export const GUESSES = { 'dwelling type': flip(DWELLING_GUESS), campus: flip(CAMPUS_GUESS) };

// → the choice a word probably means, or null: the choice itself in any
// spelling first, then the field's guesses (when that choice is still on
// its list).
export const guessChoice = (fieldName, word, choices = []) => {
  const k = choiceKey(word);
  if (!k) return null;
  const hit = choices.find((c) => choiceKey(c) === k);
  if (hit) return hit;
  const to = GUESSES[choiceKey(fieldName)]?.[k];
  return to ? choices.find((c) => choiceKey(c) === choiceKey(to)) || null : null;
};

// How a control draws a long list: [{ choice }] and [{ group, members:
// [{ choice, short }] }] in the list's order. Choices "A – B" with the same
// A, two or more, are one group at the place of the first; short is B.
// Only for a field of more than GROUP_OVER choices (Faith), so a short list
// such as Campus stays plain buttons.
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
