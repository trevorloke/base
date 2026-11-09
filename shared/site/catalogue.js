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
//   image     { url, alt }      { }            url: /media/:id or a site asset path
//   select    one of options    { options: [{ value, label }] }
//   toggle    true / false      { }
//   number    whole number      { min, max }
//   words     list of strings   { max, itemMax }
//   list      list of objects   { max, of: [fields] }
//   campaign  a petition, pledge or letter (id)   { kinds: ['petition', …] }
//   page      a site page (slug)
//
// Defaults here are neutral (the generic template). A client's own words
// come from its seed (server/ext/site/seeds/*.js), never from this file.

export const TONES = [
  { value: 'paper', label: 'Plain' },
  { value: 'surface', label: 'Soft' },
  { value: 'brand', label: 'Brand colour' },
  { value: 'accent', label: 'Accent colour' },
  { value: 'ink', label: 'Dark' },
];

const tone = { key: 'tone', type: 'select', label: 'Background', options: TONES };
const heading = (max = 80) => ({ key: 'title', type: 'text', label: 'Heading', max });
const intro = (max = 500) => ({ key: 'intro', type: 'textarea', label: 'Intro', max });
const button = (key = 'cta', label = 'Button') => ({ key, type: 'link', label });

export const CATEGORIES = [
  { key: 'basics', label: 'Text and pictures' },
  { key: 'actions', label: 'Actions (people land in base.win)' },
  { key: 'live', label: 'Live from base.win' },
  { key: 'org', label: 'About the organization' },
];

export const MODULES = [
  // ── Text and pictures ──
  {
    kind: 'hero',
    category: 'basics',
    label: 'Hero',
    description: 'The big headline at the top: optional rotating words, a paragraph, buttons and a picture.',
    fields: [
      { key: 'titlePrefix', type: 'text', label: 'Headline', max: 80 },
      { key: 'words', type: 'words', label: 'Rotating words after the headline (optional)', max: 30, itemMax: 40 },
      { key: 'text', type: 'textarea', label: 'Paragraph', max: 600 },
      button('primaryCta', 'Main button'),
      { key: 'secondaryCtas', type: 'list', label: 'Other buttons', max: 3, of: [{ key: 'label', type: 'text', label: 'Label', max: 40 }, { key: 'href', type: 'url', label: 'Link' }] },
      { key: 'image', type: 'image', label: 'Picture' },
    ],
    defaults: {
      titlePrefix: 'Your campaign headline',
      words: [],
      text: 'One or two sentences on what you stand for and what you want visitors to do next.',
      primaryCta: { label: 'Join us', href: '/join' },
      secondaryCtas: [{ label: 'Donate', href: '/donate' }],
      image: { url: '', alt: '' },
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
        { key: 'icon', type: 'select', label: 'Icon', options: ['shield', 'bus', 'trend', 'tag', 'civic', 'home', 'leaf', 'heart', 'people', 'school'].map((v) => ({ value: v, label: v })) },
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
    fields: [heading(), { key: 'highlight', type: 'text', label: 'Highlighted words', max: 40 }, button(), tone],
    defaults: { title: 'When we organize,', highlight: 'we win', cta: { label: 'Join us', href: '/join' }, tone: 'accent' },
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
    fields: [{ key: 'quote', type: 'textarea', label: 'Quote', max: 600, required: true }, { key: 'name', type: 'text', label: 'Name', max: 80 }, { key: 'role', type: 'text', label: 'Who they are', max: 120 }, { key: 'photo', type: 'image', label: 'Photo' }, tone],
    defaults: { quote: '', name: '', role: '', photo: { url: '', alt: '' }, tone: 'surface' },
  },

  // ── Actions: every submission is a person and an action in base.win ──
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
    fields: [heading(), intro(), { key: 'benefits', type: 'list', label: 'Why join', max: 6, of: [{ key: 'title', type: 'text', label: 'Title', max: 60 }, { key: 'body', type: 'textarea', label: 'Text', max: 300 }] }, { key: 'amountTitle', type: 'text', label: 'Above the amounts', max: 80 }, { key: 'amountNote', type: 'textarea', label: 'Note under the amounts', max: 300 }, { key: 'photo', type: 'image', label: 'Photo' }],
    defaults: { title: 'Become a member', intro: '', benefits: [], amountTitle: 'Your membership', amountNote: '', photo: { url: '', alt: '' } },
  },
  {
    kind: 'donate',
    category: 'actions',
    label: 'Donate',
    description: 'Amounts, once or monthly, paid online; each gift is checked against the contribution limit and gets its receipt.',
    fields: [heading(60), intro(600), { key: 'text', type: 'textarea', label: 'Second paragraph', max: 400 }, { key: 'amounts', type: 'words', label: 'Suggested amounts in dollars', max: 6, itemMax: 8 }, { key: 'allowMonthly', type: 'toggle', label: 'Offer monthly giving' }, { key: 'monthlyNote', type: 'textarea', label: 'Monthly note', max: 300 }, { key: 'clubNote', type: 'textarea', label: 'Note about giving the maximum', max: 500 }],
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
    description: 'Name, contact, what they would like to do and when they are free; they reach a named organizer in base.win within a day.',
    fields: [heading(), intro(300), { key: 'roles', type: 'words', label: 'What they can pick (the volunteer roles)', max: 20, itemMax: 60 }, { key: 'askAvailability', type: 'toggle', label: 'Ask when they are free' }, tone],
    defaults: { title: 'Volunteer', intro: 'Tell us how you would like to help. An organizer will be in touch within a day.', roles: [], askAvailability: true, tone: 'paper' },
  },
  {
    kind: 'shifts',
    category: 'actions',
    label: 'Volunteer openings',
    description: 'Upcoming public shifts and events from base.win, with one-tap sign-up.',
    fields: [heading(), intro(300), { key: 'limit', type: 'number', label: 'How many to show', min: 1, max: 24 }, { key: 'showMap', type: 'toggle', label: 'Show a map' }],
    defaults: { title: 'Volunteer openings', intro: '', limit: 6, showMap: true },
  },
  {
    kind: 'contact',
    category: 'actions',
    label: 'Contact form',
    description: 'A message to the campaign; it lands in base.win as a follow-up.',
    fields: [heading(), intro(300), { key: 'topics', type: 'words', label: 'Topics they can pick', max: 10, itemMax: 60 }],
    defaults: { title: 'Get in touch', intro: '', topics: [] },
  },

  // ── Live from base.win ──
  {
    kind: 'actNow',
    category: 'live',
    label: 'Act now',
    description: 'Live numbers, the next event and shift, and what changed lately.',
    fields: [heading(), { key: 'showCounts', type: 'toggle', label: 'Show live numbers (members, signatures)' }],
    defaults: { title: 'Act now', showCounts: true },
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

  // ── About the organization ──
  {
    kind: 'people',
    category: 'org',
    label: 'Board or team',
    description: 'Seats or people with a role, a name, a photo and a short bio; leave the name blank for an open seat.',
    fields: [heading(), intro(), { key: 'seats', type: 'list', label: 'People', max: 40, of: [{ key: 'role', type: 'text', label: 'Role', max: 80 }, { key: 'name', type: 'text', label: 'Name', max: 80 }, { key: 'photo', type: 'image', label: 'Photo' }, { key: 'bio', type: 'textarea', label: 'Bio', max: 600 }] }],
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
    fields: [intro(300), { key: 'accounts', type: 'list', label: 'Accounts', max: 12, of: [{ key: 'name', type: 'text', label: 'Network', max: 40 }, { key: 'handle', type: 'text', label: 'Handle', max: 60 }, { key: 'url', type: 'url', label: 'Link' }, { key: 'cta', type: 'text', label: 'Button', max: 40 }] }],
    defaults: { intro: '', accounts: [] },
  },
];

export const MODULE_BY_KIND = Object.fromEntries(MODULES.map((m) => [m.kind, m]));
export const MODULE_KINDS = MODULES.map((m) => m.kind);

// A fresh module instance of a kind, with its defaults (deep-copied).
export function newModule(kind, id) {
  const m = MODULE_BY_KIND[kind];
  if (!m) throw new Error(`unknown module kind: ${kind}`);
  return { id, kind, hidden: false, props: JSON.parse(JSON.stringify(m.defaults)) };
}

// ── Checking what an admin saves ──
// Returns { props } with every field coerced to its type and trimmed to its
// limits, unknown keys dropped and missing ones filled from the defaults; or
// throws an Error naming the field. Pure: the server runs it on save and the
// admin runs it before sending.
const isSafeUrl = (s) => s === '' || /^(\/(?!\/)|#|https?:\/\/|mailto:|tel:)/i.test(s);

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
      return { url, alt: checkField({ key: 'alt', type: 'text', max: 300 }, o.alt, where) };
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
// incomplete; a published page may not.
export function checkProps(kind, props, { strict = false } = {}) {
  const m = MODULE_BY_KIND[kind];
  if (!m) throw new Error(`unknown module kind: ${kind}`);
  const src = { ...JSON.parse(JSON.stringify(m.defaults)), ...(props && typeof props === 'object' ? props : {}) };
  const out = {};
  for (const f of m.fields) out[f.key] = checkField(f, src[f.key], '', strict);
  return out;
}

// A whole page's module list: known kinds, unique ids, at most 60 modules.
export function checkModules(list, { strict = false } = {}) {
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
    return { id, kind: m.kind, hidden: Boolean(m.hidden), props: checkProps(m.kind, m.props, { strict: strict && !m.hidden }) };
  });
}
