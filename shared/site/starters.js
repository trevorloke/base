// Page starters (WA decision 18): "What's this page for?" → a page of ready
// sections. Every word a starter adds beyond the catalogue's defaults is in
// PLACEHOLDERS (shared/site/placeholders.js), so Publish won't put it on the
// site; fields not named keep the catalogue's defaults, which are real,
// usable words ("Upcoming events", "Sign up") — but for the hero's and the
// band's headline, which are samples too and in PLACEHOLDERS. A campaign
// whose set-up brings its own starting words has those instead
// (catalogue.js presetModuleDefaults).
//
//   STARTERS                     [{ key, label, sections: [kinds] }] in the sheet's order
//   starterModules(key, { newId, social })
//                                the sections, as a page's modules; social:
//                                Settings → Social accounts (the Contact
//                                starter's Follow along only when there are any)
import { MODULE_BY_KIND, newModule } from './catalogue.js';

export { PLACEHOLDERS, samplePath } from './placeholders.js';

const point = (icon) => ({ icon, title: 'A point', body: 'One or two sentences on this point.' });
const seat = () => ({ role: 'Their role', name: 'Their name', photo: { url: '', alt: '' }, bio: 'A sentence or two about them.' });
const group = () => ({ title: 'A group’s name', body: 'What this group does, in a sentence.' });
const hero = (titlePrefix, text) => ['hero', { titlePrefix, text }];
const text = (title, body) => ['text', { title, body }];

const PLAN = {
  issue: [
    hero('Your issue’s headline', 'One or two sentences on the problem and what you’d do about it.'),
    text('What’s happening', 'Explain the issue in plain words. Short paragraphs read best on phones.'),
    ['columns', { items: [point('civic'), point('people'), point('home')] }],
    ['petition', {}],
    ['band', {}],
  ],
  event: [
    hero('Your event’s name', 'When and where it is, and why people should come.'),
    text('What to expect', 'Who it’s for, what will happen, and anything to bring.'),
    ['events', {}],
    ['volunteer', {}],
  ],
  petition: [
    hero('What your petition asks for', 'Why it matters, in one or two sentences.'),
    ['petition', {}],
    text('Why this matters', 'Give the reasons in plain words. Short paragraphs read best on phones.'),
    ['newsletter', {}],
  ],
  about: [
    hero('Who we are', 'One or two sentences on who you are and what you want for your community.'),
    text('Our story', 'How you started and what you’re working for.'),
    ['people', { seats: [seat(), seat()] }],
    ['quote', { quote: 'A few words from someone who supports you.', name: 'Their name', role: 'Who they are' }],
    ['groups', { items: [group(), group()] }],
  ],
  contact: [
    text('How to reach us', 'Tell people the best way to reach you and when you’ll answer.'),
    ['contact', {}],
    ['social', {}],
  ],
  involved: [
    hero('Get involved', 'One or two sentences on why people should join in.'),
    ['volunteer', {}], ['shifts', {}], ['donate', {}], ['newsletter', {}],
  ],
  blank: [],
};

export const STARTERS = [
  { key: 'issue', label: 'An issue' },
  { key: 'event', label: 'An event' },
  { key: 'petition', label: 'A petition' },
  { key: 'about', label: 'About us' },
  { key: 'contact', label: 'Contact' },
  { key: 'involved', label: 'Get involved' },
  { key: 'blank', label: 'Blank' },
].map((s) => ({ ...s, sections: PLAN[s.key].map(([kind]) => kind) }));

// Settings → Social accounts ({ accounts: [{ name, handle, url }] }) as the Follow along
// section's accounts: only ones with a link.
const accountsOf = (social) => (Array.isArray(social) ? social : Array.isArray(social?.accounts) ? social.accounts : [])
  .filter((a) => a && typeof a.url === 'string' && /^https?:\/\//i.test(a.url.trim()))
  .slice(0, MODULE_BY_KIND.social.fields.find((f) => f.key === 'accounts').max)
  .map((a) => ({ name: String(a.name || a.network || '').slice(0, 40), handle: String(a.handle || '').slice(0, 60), url: a.url.trim(), cta: '' }));

// newId(taken): a fresh section id (the builder's newModuleId).
export function starterModules(key, { newId, social = [] } = {}) {
  const plan = PLAN[key];
  if (!plan) throw new Error(`unknown starter: ${key}`);
  const out = [];
  for (const [kind, words] of plan) {
    let props = words;
    if (kind === 'social') {
      const accounts = accountsOf(social);
      if (!accounts.length) continue;
      props = { accounts };
    }
    const m = newModule(kind, newId(out.map((x) => x.id)));
    m.props = { ...m.props, ...JSON.parse(JSON.stringify(props)) };
    out.push(m);
  }
  return out;
}
