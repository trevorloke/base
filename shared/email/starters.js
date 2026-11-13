// The ready-made templates every campaign starts with: four newsletters
// first, then the rest of supporter email, the two voting-day reminders
// last (kept for a by-election), and a press release for Media. Built into
// base.win, the same on every brand (never by brandKey()): a wording fix
// reaches every campaign in a release, and a manager hides one with
// template.starters (ext/templates). Read-only — "Make a copy" makes a
// campaign's own.
//
// Words in [square brackets] are placeholders the writer replaces; an email
// started from one can't go out with one still in it (email/check.js).
// "[first name]" and "[campaign]" fill themselves in (stored as codes).
// "[link: Read more]" is a placeholder too: select it and press Link.
// No starter states a fact about any campaign: no names, places, amounts,
// dates, addresses or numbers.
import { placeholders, toCodes } from './words.js';

// One line is one paragraph; lines starting "- " run together as a list.
const md = (lines) => lines.reduce((out, line, i) => {
  if (i === 0) return line;
  const list = line.startsWith('- ') && lines[i - 1].startsWith('- ');
  return `${out}${list ? '\n' : '\n\n'}${line}`;
}, '');
const starter = (key, use, name, subject, lines) => ({ key, use, name, subject: toCodes(subject), body: toCodes(md(lines)) });

export const STARTERS = [
  starter('monthly', 'email', 'Monthly newsletter', '[Month] update from [campaign]', [
    'Hi [first name],',
    'Here’s what [campaign] has been up to this month.',
    '**[Headline one]**',
    '[Two or three sentences.] [link: Read more]',
    '**[Headline two]**',
    '[Two or three sentences.]',
    '**Coming up**',
    '- [Date] · [Event] · [Place]',
    '- [Date] · [Event] · [Place]',
    '**One thing you can do this month:** [one action, with a link]',
    'Thanks for being part of this,',
    '[Signer’s name], [role]',
  ]),
  starter('short-update', 'email', 'Short update', '[Topic]: what’s new', [
    'Hi [first name],',
    '**[Headline]**',
    '[Three or four sentences: what happened, and why it matters to people here.]',
    '[link: Read more]',
    '**One thing you can do:** [one action, with a link]',
    'Thanks,',
    '[Signer’s name]',
  ]),
  starter('spotlight', 'email', 'Issue spotlight', '[Issue]: where things stand', [
    'Hi [first name],',
    '**What’s happening**',
    '[Two or three sentences on the issue as it stands today.]',
    '**Why it matters**',
    '[Two or three sentences on who it affects and how.]',
    '**What you can do**',
    '- [First action, with a link]',
    '- [Second action — or delete this line]',
    '[link: Read more about this issue]',
    'Thanks for caring about this,',
    '[Signer’s name], [role]',
  ]),
  starter('season', 'email', 'Looking back, looking ahead', '[Season] update from [campaign]', [
    'Hi [first name],',
    '**Thank you**',
    '[Two or three sentences on what people did together this past season.]',
    '**What’s next**',
    '[Two or three sentences on what [campaign] is working on now.]',
    '**Dates to keep**',
    '- [Date] · [Event] · [Place]',
    '- [Date] · [Event] · [Place]',
    '[link: Get involved]',
    'See you soon,',
    '[Signer’s name], [role]',
  ]),
  starter('event', 'email', 'Event invitation', 'You’re invited: [event name], [day]', [
    'Hi [first name],',
    'Join us for [event name].',
    '**When:** [Day, date], [start]–[end]',
    '**Where:** [Place], [street address]',
    '**What to expect:** [one or two sentences]',
    '[link: RSVP]',
    '[Accessibility, parking or transit note — or delete this line]',
    'See you there,',
    '[Signer’s name]',
  ]),
  starter('volunteer', 'email', 'Volunteer call-out', 'Can you help on [day]?', [
    'Hi [first name],',
    'We need [number] people to [task] on [day or dates]. A shift is [length], and no experience is needed: we’ll show you what to do.',
    'Why it matters: [one sentence].',
    '[link: Pick a shift]',
    'Can’t make it? Reply and tell us what you’d like to help with instead.',
    'Thank you,',
    '[Volunteer coordinator’s name]',
  ]),
  starter('donate', 'email', 'Donation ask', '[Short reason], can you chip in?', [
    'Hi [first name],',
    '[One or two sentences on what the money will do, with a concrete number: “[amount] pays for [thing]”.]',
    '[link: Donate]',
    'Every gift helps, large or small.',
    '[Signer’s name]',
    '*Only individuals who live in B.C. and are Canadian citizens or permanent residents may give. Contributions are not tax-deductible. [The yearly limit — or a link to your donate page, which states it]*',
  ]),
  starter('thanks', 'email', 'Thank you', 'Thank you, [first name]', [
    'Hi [first name],',
    'Thank you for [what they did: volunteering on [day], your gift, coming to [event]].',
    '[One or two sentences on the difference it made.]',
    '[One next step, with a link — or delete this line]',
    'With thanks,',
    '[Signer’s name]',
  ]),
  starter('statement', 'email', 'Campaign statement', 'Statement: [topic]', [
    '**[Headline in sentence case]**',
    '[City], [date]: [first paragraph — who, what, when, why, in two sentences.]',
    '“[Quote],” said [name], [role].',
    '[Second paragraph: details.]',
    '[link: Read the full statement]',
    'Media contact: [name], [phone], [email]',
  ]),
  starter('welcome', 'email', 'Welcome', 'Welcome to [campaign]', [
    'Hi [first name],',
    'Thanks for signing up. [One sentence on what the campaign is for.]',
    'Here’s how to get involved:',
    '- [link: Volunteer]',
    '- [link: Come to an event]',
    '- [link: Donate]',
    'You’ll hear from us about [how often]. You can unsubscribe any time with the link at the bottom.',
  ]),
  starter('advance', 'email', 'Advance voting is open', 'Advance voting is open', [
    'Hi [first name],',
    'Advance voting is open on [dates], [hours]. You can vote at any advance voting place in [municipality].',
    '[link: Find where to vote — the municipality’s official voting page]',
    'Bring ID that shows your name and address. [link: What ID to bring]',
    'Do you have a plan? Reply and tell us when you’ll vote.',
  ]),
  starter('election-day', 'email', 'Election day (go vote only)', 'Today is election day', [
    'Hi [first name],',
    'Today is General Voting Day. Voting places are open [hours].',
    '[link: Find where to vote]',
    'If you’ve already voted, thank you. If not, there’s still time.',
  ]),
  starter('press-release', 'press', 'Press release', '[Headline in sentence case]', [
    '**For immediate release**',
    '[City], [date]: [first paragraph — who, what, when, why, in two sentences.]',
    '“[Quote],” said [name], [role].',
    '[Second paragraph: details, and where to see the video or photos — paste the link.]',
    '[Background in one or two sentences — or delete this line]',
    '**Media contact:** [name], [phone], [email]',
  ]),
];

export const STARTER_KEYS = STARTERS.map((s) => s.key);
export const starterOf = (key) => STARTERS.find((s) => s.key === key) || null;

// Every placeholder any starter uses, worked out from the texts above (never
// typed by hand): an email holding one can't go out, however it was written.
export const STARTER_PLACEHOLDERS = new Set(STARTERS.flatMap((s) => placeholders(`${s.subject}\n${s.body}`)));
