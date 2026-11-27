// The website's module catalogue — one list read by the server (to check
// what an admin saves), the page renderer (to draw each module) and the
// Website admin (to build each module's form). A page is an ordered list of
// module instances: { id, kind, hidden, props }. Adding a module kind means
// adding it here, a renderer (server/ext/site/render) and nothing else: the
// admin form and the validation follow from `fields`.
//
// Field types (all optional unless `required`):
//   text      one line          { max }
//   textarea  a paragraph       { max }
//   markdown  rich text         { max }        rendered sanitized
//   url       a link            { }            relative (/donate, /#join) or http(s)
//   link      { label, href }   { }            a button or link
//   image     { url, alt, width?, height?, sizes?, focus?, decorative? }
//                               { }            url: /media/:id or a site asset path;
//                                              sizes: up to 3 smaller copies
//                                              [{ url: /media/:id, w }]; focus:
//                                              { x, y } 0–100, the spot kept in view
//   select    one of options    { options: [{ value, label }] }
//   toggle    true / false      { }
//   number    whole number      { min, max }
//   words     list of strings   { max, itemMax }
//   list      list of objects   { max, of: [fields] }
//   campaign  a petition, pledge or letter (id)   { kinds: ['petition', …] }
//   page      a site page (slug)
//
// translate (TR, shared/site/segments.js): left out, a text field's words
// are translated on the language pages; false never (people's names,
// handles, amounts); 'label' only an option's label (its value posted stays
// English); 'check-first' shown translated only once a person checked it
// (words beside money, words in a real person's mouth); 'composed' one
// segment with the field beside it (a headline built from parts).
//
// Defaults here are neutral (the generic template). A campaign's own words
// come from its seed, never from this file. A campaign whose set-up brings
// its own starting words for a section has them laid over these when the
// program starts (presetModuleDefaults below).

import { samplePath } from './placeholders.js';
import { describeWords, newUndescribed } from './pictures.js';

export const TONES = [
  { value: 'paper', label: 'Plain' },
  { value: 'surface', label: 'Soft' },
  { value: 'brand', label: 'Brand colour' },
  { value: 'accent', label: 'Accent colour' },
  { value: 'ink', label: 'Dark' },
];

// The columns' icons (shared/site/components/icons.js), by name.
const ICONS = [['shield', 'Shield'], ['bus', 'Bus'], ['trend', 'Rising line'], ['tag', 'Price tag'], ['civic', 'City hall'], ['home', 'Home'], ['leaf', 'Leaf'], ['heart', 'Heart'], ['people', 'People'], ['school', 'School']]
  .map(([value, label]) => ({ value, label }));

const tone = { key: 'tone', type: 'select', label: 'Background', options: TONES };
const heading = (max = 80) => ({ key: 'title', type: 'text', label: 'Heading', max });
const intro = (max = 500) => ({ key: 'intro', type: 'textarea', label: 'Intro', max });
const button = (key = 'cta', label = 'Button') => ({ key, type: 'link', label });

export const CATEGORIES = [
  { key: 'basics', label: 'Words and pictures' },
  { key: 'actions', label: 'Ask people to act' },
  { key: 'live', label: 'Show what’s on' },
  { key: 'org', label: 'About us' },
];

export const MODULES = [
  // ── Words and pictures ──
  {
    kind: 'hero',
    category: 'basics',
    label: 'Hero',
    description: 'The big headline at the top: optional rotating words, a paragraph, buttons and a picture.',
    fields: [
      { key: 'titlePrefix', type: 'text', label: 'Headline', max: 80, translate: 'composed' },
      { key: 'words', type: 'words', label: 'Rotating words after the headline (optional)', max: 30, itemMax: 40, translate: 'composed' },
      { key: 'text', type: 'textarea', label: 'Paragraph', max: 600 },
      button('primaryCta', 'Main button'),
      { key: 'secondaryCtas', type: 'list', label: 'Other buttons', max: 3, of: [{ key: 'label', type: 'text', label: 'Label', max: 40 }, { key: 'href', type: 'url', label: 'Link' }] },
      { key: 'image', type: 'image', label: 'Picture' },
      // Where the picture goes (WEB decision 31): beside the words, as every
      // hero was drawn before, or behind them, the words on a panel of the
      // brand colour.
      { key: 'layout', type: 'select', label: 'Where the picture goes', translate: false, options: [{ value: 'beside', label: 'Beside the words' }, { value: 'behind', label: 'Behind the words' }] },
    ],
    defaults: {
      titlePrefix: 'Your campaign headline',
      words: [],
      text: 'One or two sentences on what you stand for and what you want visitors to do next.',
      primaryCta: { label: 'Volunteer', href: '/volunteer' },
      secondaryCtas: [{ label: 'Donate', href: '/donate' }],
      image: { url: '', alt: '' },
      layout: 'beside',
    },
  },
  {
    kind: 'text',
    category: 'basics',
    label: 'Text block',
    description: 'A heading, some text and an optional button.',
    fields: [heading(120), { key: 'body', type: 'markdown', label: 'Text', max: 8000 }, button(), tone],
    defaults: { title: '', body: '', cta: { label: '', href: '' }, tone: 'paper' },
  },
  {
    kind: 'image',
    category: 'basics',
    label: 'Picture',
    description: 'A full-width picture with a caption.',
    fields: [{ key: 'image', type: 'image', label: 'Picture', required: true }, { key: 'caption', type: 'text', label: 'Caption', max: 200 }],
    defaults: { image: { url: '', alt: '' }, caption: '' },
  },
  {
    kind: 'video',
    category: 'basics',
    label: 'Video',
    description: 'A YouTube or Vimeo video.',
    fields: [heading(), { key: 'url', type: 'url', label: 'YouTube or Vimeo link', required: true }, { key: 'caption', type: 'text', label: 'Caption', max: 200 }],
    defaults: { title: '', url: '', caption: '' },
  },
  {
    kind: 'columns',
    category: 'basics',
    label: 'What we stand for',
    description: 'A row of short points, each with an icon, a title and a sentence or two.',
    fields: [
      heading(), intro(),
      { key: 'items', type: 'list', label: 'Points', max: 8, of: [
        { key: 'icon', type: 'select', label: 'Icon', options: ICONS },
        { key: 'title', type: 'text', label: 'Title', max: 60 },
        { key: 'body', type: 'textarea', label: 'Text', max: 400 },
      ] },
      { key: 'ctaText', type: 'text', label: 'Line under the points (optional)', max: 120 },
      button(),
    ],
    defaults: { title: 'What we stand for', intro: '', items: [], ctaText: '', cta: { label: '', href: '' } },
  },
  {
    kind: 'band',
    category: 'basics',
    label: 'Call to action band',
    description: 'A bold one-line call with a button, in the brand colours.',
    fields: [{ ...heading(), translate: 'composed' }, { key: 'highlight', type: 'text', label: 'Highlighted words', max: 40, translate: 'composed' }, button(), tone],
    // Sample words (shared/site/placeholders.js): Publish asks for real ones.
    defaults: { title: 'Your headline,', highlight: 'in a few words', cta: { label: 'Volunteer', href: '/volunteer' }, tone: 'accent' },
  },
  {
    kind: 'faq',
    category: 'basics',
    label: 'Questions and answers',
    description: 'A list of questions that open to show their answers.',
    fields: [heading(), { key: 'items', type: 'list', label: 'Questions', max: 30, of: [{ key: 'q', type: 'text', label: 'Question', max: 200 }, { key: 'a', type: 'markdown', label: 'Answer', max: 2000 }] }],
    defaults: { title: 'Questions', items: [] },
  },
  {
    kind: 'quote',
    category: 'basics',
    label: 'Quote',
    description: 'A quote with who said it and a photo.',
    fields: [{ key: 'quote', type: 'textarea', label: 'Quote', max: 600, required: true, translate: 'check-first' }, { key: 'name', type: 'text', label: 'Name', max: 80, translate: false }, { key: 'role', type: 'text', label: 'Who they are', max: 120 }, { key: 'photo', type: 'image', label: 'Photo' }, tone],
    defaults: { quote: '', name: '', role: '', photo: { url: '', alt: '' }, tone: 'surface' },
  },

  // ── Ask people to act: every submission is a person and an action in base.win ──
  {
    kind: 'newsletter',
    category: 'actions',
    label: 'Newsletter sign-up',
    description: 'Name, email and (optionally) phone; they join the email list with their consent recorded.',
    fields: [heading(), intro(300), { key: 'askPhone', type: 'toggle', label: 'Ask for a mobile number (texts)' }, { key: 'buttonLabel', type: 'text', label: 'Button', max: 40 }, tone],
    defaults: { title: 'Get the newsletter', intro: 'News and events. Unsubscribe anytime.', askPhone: false, buttonLabel: 'Sign up', tone: 'surface' },
  },
  {
    kind: 'join',
    category: 'actions',
    label: 'Become a member',
    description: 'The membership form: their details, the eligibility declaration and the membership contribution (paid online).',
    fields: [heading(), intro(), { key: 'benefits', type: 'list', label: 'Why join', max: 6, of: [{ key: 'title', type: 'text', label: 'Title', max: 60 }, { key: 'body', type: 'textarea', label: 'Text', max: 300 }] }, { key: 'amountTitle', type: 'text', label: 'Above the amounts', max: 80 }, { key: 'amountNote', type: 'textarea', label: 'Note under the amounts', max: 300, translate: 'check-first' }, { key: 'photo', type: 'image', label: 'Photo' }],
    defaults: { title: 'Become a member', intro: '', benefits: [], amountTitle: 'Your membership', amountNote: '', photo: { url: '', alt: '' } },
  },
  {
    kind: 'donate',
    category: 'actions',
    label: 'Donate',
    description: 'Amounts, once or monthly, paid online; each gift is checked against the contribution limit and gets its receipt.',
    fields: [heading(60), { ...intro(600), translate: 'check-first' }, { key: 'text', type: 'textarea', label: 'Second paragraph', max: 400, translate: 'check-first' }, { key: 'amounts', type: 'words', label: 'Suggested amounts in dollars', max: 6, itemMax: 8, translate: false }, { key: 'allowMonthly', type: 'toggle', label: 'Offer monthly giving' }, { key: 'monthlyNote', type: 'textarea', label: 'Monthly note', max: 300, translate: 'check-first' }, { key: 'clubNote', type: 'textarea', label: 'Note about giving the maximum', max: 500, translate: 'check-first' }],
    defaults: { title: 'Donate', intro: '', text: '', amounts: ['25', '50', '100', '250'], allowMonthly: true, monthlyNote: '', clubNote: '' },
  },
  {
    kind: 'petition',
    category: 'actions',
    label: 'Petition or pledge',
    description: 'One of your petitions or pledges with its sign-up form and share buttons.',
    fields: [{ key: 'campaign', type: 'campaign', label: 'Which one', kinds: ['petition', 'pledge'], required: true }, { key: 'eyebrow', type: 'text', label: 'Small heading above (optional)', max: 40 }, tone],
    defaults: { campaign: '', eyebrow: '', tone: 'paper' },
  },
  {
    kind: 'volunteer',
    category: 'actions',
    label: 'Volunteer sign-up',
    description: 'Name, contact, what they would like to do and when they are free; a named organizer gets back to them within a day.',
    fields: [heading(), intro(300), { key: 'roles', type: 'words', label: 'What they can pick (the volunteer roles)', max: 20, itemMax: 60, translate: 'label' }, { key: 'askAvailability', type: 'toggle', label: 'Ask when they are free' }, tone],
    defaults: { title: 'Volunteer', intro: 'Tell us how you would like to help. An organizer will be in touch within a day.', roles: [], askAvailability: true, tone: 'paper' },
  },
  {
    kind: 'shifts',
    category: 'actions',
    label: 'Volunteer openings',
    description: 'Upcoming public shifts and events, with one-tap sign-up.',
    fields: [heading(), intro(300), { key: 'limit', type: 'number', label: 'How many to show', min: 1, max: 24 }, { key: 'showMap', type: 'toggle', label: 'Show a map' }],
    defaults: { title: 'Volunteer openings', intro: '', limit: 6, showMap: true },
  },
  {
    kind: 'contact',
    category: 'actions',
    label: 'Contact form',
    description: 'A message to the campaign; someone follows it up.',
    fields: [heading(), intro(300), { key: 'topics', type: 'words', label: 'Topics they can pick', max: 10, itemMax: 60, translate: 'label' }],
    defaults: { title: 'Get in touch', intro: '', topics: [] },
  },

  // ── Show what's on (live from base.win) ──
  {
    kind: 'actNow',
    category: 'live',
    label: 'Act now',
    description: 'Live numbers, the next event and shift, and what changed lately.',
    fields: [heading(), { key: 'showCounts', type: 'toggle', label: 'Show live numbers (signatures)' }],
    defaults: { title: 'Act now', showCounts: true },
  },
  {
    kind: 'voterguide',
    category: 'live',
    label: 'Voter guide',
    description: 'Where and when to vote, from the guide you keep under Website → Voter guide.',
    fields: [heading(), intro(400), { key: 'showBallot', type: 'toggle', label: 'Show the names on the ballot' }, button('cta', 'Button')],
    defaults: { title: 'How to vote', intro: '', showBallot: true, cta: { label: '', href: '' } },
  },
  {
    kind: 'events',
    category: 'live',
    label: 'Events',
    description: 'The next public events, with RSVP.',
    fields: [heading(), { key: 'limit', type: 'number', label: 'How many to show', min: 1, max: 24 }],
    defaults: { title: 'Upcoming events', limit: 3 },
  },
  {
    kind: 'news',
    category: 'live',
    label: 'News',
    description: 'The latest news posts.',
    fields: [heading(), { key: 'limit', type: 'number', label: 'How many to show', min: 1, max: 24 }],
    defaults: { title: 'News', limit: 3 },
  },
  {
    kind: 'tracker',
    category: 'live',
    label: 'Promise tracker',
    description: 'Promises, their status and the evidence, so the public can hold office-holders to account.',
    fields: [heading(), intro(500), { key: 'items', type: 'list', label: 'Promises', max: 200, of: [
      { key: 'title', type: 'text', label: 'Promise', max: 200 },
      { key: 'status', type: 'select', label: 'Status', options: [{ value: 'kept', label: 'Kept' }, { value: 'progress', label: 'In progress' }, { value: 'stalled', label: 'Stalled' }, { value: 'broken', label: 'Broken' }, { value: 'pending', label: 'Not started' }] },
      { key: 'due', type: 'text', label: 'Due (optional)', max: 40 },
      { key: 'note', type: 'textarea', label: 'What happened', max: 1000 },
      { key: 'source', type: 'url', label: 'Source link' },
    ] }],
    defaults: { title: 'Promise tracker', intro: '', items: [] },
  },

  // ── About us ──
  {
    kind: 'people',
    category: 'org',
    label: 'Board or team',
    description: 'Seats or people with a role, a name, a photo and a short bio; leave the name blank for an open seat.',
    fields: [heading(), intro(), { key: 'seats', type: 'list', label: 'People', max: 40, of: [{ key: 'role', type: 'text', label: 'Role', max: 80 }, { key: 'name', type: 'text', label: 'Name', max: 80, translate: false }, { key: 'photo', type: 'image', label: 'Photo' }, { key: 'bio', type: 'textarea', label: 'Bio', max: 600 }] }],
    defaults: { title: 'Our team', intro: '', seats: [] },
  },
  {
    kind: 'groups',
    category: 'org',
    label: 'Committees and groups',
    description: 'Committees, neighbourhood teams or clubs, each with a short description.',
    fields: [heading(), intro(), { key: 'items', type: 'list', label: 'Groups', max: 24, of: [{ key: 'title', type: 'text', label: 'Name', max: 60 }, { key: 'body', type: 'textarea', label: 'Text', max: 300 }] }],
    defaults: { title: 'Get involved locally', intro: '', items: [] },
  },
  {
    kind: 'social',
    category: 'org',
    label: 'Follow along',
    description: 'Your social media accounts.',
    fields: [intro(300), { key: 'accounts', type: 'list', label: 'Accounts', max: 12, of: [{ key: 'name', type: 'text', label: 'Network', max: 40, translate: false }, { key: 'handle', type: 'text', label: 'Handle', max: 60, translate: false }, { key: 'url', type: 'url', label: 'Link' }, { key: 'cta', type: 'text', label: 'Button', max: 40 }] }],
    defaults: { intro: '', accounts: [] },
  },
];

export const MODULE_BY_KIND = Object.fromEntries(MODULES.map((m) => [m.kind, m]));
export const MODULE_KINDS = MODULES.map((m) => m.kind);

// A campaign's own starting words for a section ({ band: { title, … } }),
// laid over the defaults above. Whoever runs this code says what they are —
// the server from its settings (server/ext/site/from-preset.js), the Website
// screens from GET /api/site (moduleDefaults), a draft's preview from the
// page's own data — and they are asked each time. Nothing registered: none.
let ownDefaults = () => ({});
export const presetModuleDefaults = (fn) => { ownDefaults = typeof fn === 'function' ? fn : () => ({}); };
const registered = () => {
  try { const o = ownDefaults(); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
};
// A kind's defaults (deep-copied), with `over[kind]` laid over them.
// over: left out, the registered ones.
export function defaultsFor(kind, over = registered()) {
  const m = MODULE_BY_KIND[kind];
  if (!m) throw new Error(`unknown module kind: ${kind}`);
  const mine = over && typeof over === 'object' && over[kind] && typeof over[kind] === 'object' ? over[kind] : {};
  const known = new Set(m.fields.map((f) => f.key));
  return JSON.parse(JSON.stringify({ ...m.defaults, ...Object.fromEntries(Object.entries(mine).filter(([k]) => known.has(k))) }));
}

// A fresh module instance of a kind, with its defaults.
export function newModule(kind, id, over) {
  return { id, kind, hidden: false, props: defaultsFor(kind, over) };
}

// ── Checking what an admin saves ──
// Returns { props } with every field coerced to its type and trimmed to its
// limits, unknown keys dropped and missing ones filled from the defaults; or
// throws an Error naming the field. Pure: the server runs it on save and the
// admin runs it before sending.
// Exported: the renderer links only what passes this rule.
export const isSafeUrl = (s) => s === '' || /^(\/(?!\/)|#|https?:\/\/|mailto:|tel:)/i.test(s);

function checkField(f, v, path, strict = false) {
  const where = path ? `${path}.${f.key}` : f.key;
  const str = (max) => {
    if (v == null) return '';
    if (typeof v !== 'string') throw new Error(`${where}: text expected`);
    const s = v.trim();
    if (max && s.length > max) throw new Error(`${where}: at most ${max} characters`);
    return s;
  };
  switch (f.type) {
    case 'text': case 'textarea': case 'markdown': {
      const s = str(f.max || (f.type === 'markdown' ? 20000 : 2000));
      if (strict && f.required && !s) throw new Error(`${where}: required`);
      return s;
    }
    case 'url': {
      const s = str(500);
      if (!isSafeUrl(s)) throw new Error(`${where}: a link starting with /, # or https://`);
      if (strict && f.required && !s) throw new Error(`${where}: required`);
      return s;
    }
    case 'link': {
      const o = v && typeof v === 'object' ? v : {};
      const label = checkField({ key: 'label', type: 'text', max: 60 }, o.label, where);
      const href = checkField({ key: 'href', type: 'url' }, o.href, where);
      return { label, href };
    }
    case 'image': {
      const o = v && typeof v === 'object' ? v : {};
      const url = checkField({ key: 'url', type: 'url' }, o.url, where);
      if (strict && f.required && !url) throw new Error(`${where}: a picture is required`);
      const out = { url, alt: checkField({ key: 'alt', type: 'text', max: 300 }, o.alt, where) };
      if (!url) return out;
      const px = (n) => (Number.isInteger(n) && n >= 1 && n <= 20000 ? n : null);
      if (px(o.width) && px(o.height)) { out.width = o.width; out.height = o.height; }
      if (o.sizes != null) {
        if (!Array.isArray(o.sizes) || o.sizes.length > 3) throw new Error(`${where}: at most 3 sizes`);
        const sizes = o.sizes.map((z) => {
          const u = String(z?.url ?? '').trim();
          if (!/^\/media\/[0-9a-f-]{36}$/i.test(u) || !px(z?.w)) throw new Error(`${where}: a size must be an uploaded picture`);
          return { url: u, w: z.w };
        });
        if (sizes.length) out.sizes = sizes;
      }
      if (o.focus != null) {
        const pct = (n) => Number.isInteger(n) && n >= 0 && n <= 100;
        if (!pct(o.focus?.x) || !pct(o.focus?.y)) throw new Error(`${where}: the spot to keep in view is off the picture`);
        if (o.focus.x !== 50 || o.focus.y !== 50) out.focus = { x: o.focus.x, y: o.focus.y };
      }
      if (o.decorative === true) out.decorative = true;
      return out;
    }
    case 'select': {
      const allowed = (f.options || []).map((o) => o.value);
      if (v == null || v === '') return allowed[0] ?? '';
      if (!allowed.includes(v)) throw new Error(`${where}: not one of the choices`);
      return v;
    }
    case 'toggle': return v === true || v === 'true' || v === 1;
    case 'number': {
      if (v == null || v === '') return f.min ?? 0;
      const n = Math.round(Number(v));
      if (!Number.isFinite(n)) throw new Error(`${where}: a number`);
      return Math.min(f.max ?? n, Math.max(f.min ?? n, n));
    }
    case 'words': {
      const arr = Array.isArray(v) ? v : [];
      if (f.max && arr.length > f.max) throw new Error(`${where}: at most ${f.max}`);
      return arr.map((w, i) => checkField({ key: String(i), type: 'text', max: f.itemMax || 80 }, w, where)).filter(Boolean);
    }
    case 'list': {
      const arr = Array.isArray(v) ? v : [];
      if (f.max && arr.length > f.max) throw new Error(`${where}: at most ${f.max}`);
      return arr.map((item, i) => {
        const o = item && typeof item === 'object' ? item : {};
        const out = {};
        for (const sub of f.of) out[sub.key] = checkField(sub, o[sub.key], `${where}[${i}]`, strict);
        return out;
      });
    }
    case 'campaign': case 'page': {
      const s = str(100);
      if (strict && f.required && !s) throw new Error(`${where}: pick one`);
      return s;
    }
    default: throw new Error(`${where}: unknown field type ${f.type}`);
  }
}

// strict: also every `required` field filled (publishing). A draft may be
// incomplete; a published page may not. samples (with strict, unless said
// otherwise): no box may hold sample words — a seed, whose words are
// placeholders by design, says false. known (with strict): the picture
// addresses already on the site (pictures.js knownPictures) — any other
// picture must be described or marked decorative.
// over: a campaign's own starting words (defaultsFor); left out, the
// registered ones.
export function checkProps(kind, props, { strict = false, samples = strict, known = null, over } = {}) {
  const m = MODULE_BY_KIND[kind];
  if (!m) throw new Error(`unknown module kind: ${kind}`);
  const src = { ...defaultsFor(kind, over), ...(props && typeof props === 'object' ? props : {}) };
  const out = {};
  for (const f of m.fields) out[f.key] = checkField(f, src[f.key], '', strict);
  // Publishing: no box may still hold a starter's (or this catalogue's)
  // sample words (shared/site/placeholders.js).
  const sample = strict && samples ? samplePath(kind, out) : null;
  if (sample) throw new Error(`${sample}: still has the sample words`);
  const pic = strict && known ? newUndescribed(m.fields, out, known) : null;
  if (pic) throw new Error(`${pic.path}: ${describeWords(pic)}`);
  return out;
}

// One picture's value outside a module (a post's picture), checked the same way.
export const checkImage = (v, where = 'image') => checkField({ key: where, type: 'image' }, v, '');

// A whole page's module list: known kinds, unique ids, at most 60 modules.
export function checkModules(list, { strict = false, samples = strict, known = null, over } = {}) {
  if (!Array.isArray(list)) throw new Error('modules: a list expected');
  if (list.length > 60) throw new Error('modules: at most 60 on a page');
  const ids = new Set();
  return list.map((m, i) => {
    if (!m || typeof m !== 'object') throw new Error(`modules[${i}]: a module expected`);
    const id = String(m.id || '').slice(0, 64);
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) throw new Error(`modules[${i}]: a bad id`);
    if (ids.has(id)) throw new Error(`modules[${i}]: the same id twice`);
    ids.add(id);
    // Hidden modules aren't shown, so they needn't be complete to publish.
    return { id, kind: m.kind, hidden: Boolean(m.hidden), props: checkProps(m.kind, m.props, { strict: strict && !m.hidden, samples: samples && !m.hidden, known, over }) };
  });
}
