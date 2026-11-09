// Sample sites for the renderer's tests and screenshots
// (site-render.test.js, e2e-site-render.mjs): Imagine Surrey's home page
// built from its website's own words (copied from apps/web/src/content/site.ts
// and apps/web/src/lib/settings.ts; nobody's name — every board seat is
// shown open), and a generic campaign on the Base skin with made-up people.
// News, events and counts are samples, labelled as such.

const DAY = 24 * 3600 * 1000;
// Upcoming dates, a few days from whenever the test runs.
const soon = (days, hourUtc = 18) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
};
const later = (iso, hours) => new Date(new Date(iso).getTime() + hours * 3600 * 1000).toISOString();

export const sampleData = (campaigns = {}) => {
  const e1 = soon(5);
  const e2 = soon(9, 2);
  const e3 = soon(12, 17);
  const e4 = soon(16, 19);
  return {
    posts: [
      { slug: 'sample-post-one', title: 'Sample post: what the news module shows', excerpt: 'A sample post for the renderer’s tests. The newest three show on the home page.', image: null, published_at: soon(-2) },
      { slug: 'sample-post-two', title: 'Sample post: a second headline', excerpt: 'Each card shows its date, its title, a line or two and a link.', image: null, published_at: soon(-6) },
      { slug: 'sample-post-three', title: 'Sample post: a third headline', excerpt: 'Posts are written in Website → News.', image: null, published_at: soon(-11) },
    ],
    events: [
      { id: 'shift-1', title: 'Sample: volunteer orientation', starts_at: e1, ends_at: later(e1, 2), location: 'Campaign office', spots_left: 12, lat: 49.1913, lng: -122.849 },
      { id: 'shift-2', title: 'Sample: phone bank', starts_at: e2, ends_at: later(e2, 2), location: 'Online', spots_left: 2, lat: null, lng: null },
      { id: 'shift-3', title: 'Sample: doorknocking', starts_at: e3, ends_at: later(e3, 3), location: 'Meet at the community centre', spots_left: 0, lat: 49.12, lng: -122.84 },
      { id: 'shift-4', title: 'Sample: town hall', starts_at: e4, ends_at: later(e4, 2), location: 'Library meeting room', spots_left: null, lat: null, lng: null },
    ],
    counts: { members: 1234, signatures: Object.fromEntries(Object.values(campaigns).map((c) => [c.id, c.count])) },
    campaigns,
    payments: { ready: true, limit_cents: 142970, monthly_max_cents: 11900 },
    roles: ['Doorknocking', 'Phoning', 'Mainstreeting', 'Event hosting', 'Data entry', 'Driver', 'Translation', 'Food'],
  };
};

// ── Imagine Surrey (their words; see the note at the top) ──
const IS_CAMPAIGN = {
  id: 'c-skytrain',
  slug: 'skytrain-south-surrey',
  kind: 'petition',
  title: 'Get SkyTrain to South Surrey',
  excerpt: 'We’re also calling on the province to honour its commitment of $250 million for B-Line expansion.',
  statement: 'Commit in writing to SkyTrain reaching at least 64 Avenue, with a target year',
  body: '- Commit in writing to SkyTrain reaching at least 64 Avenue, with a target year\n- Get the extension into TransLink’s next investment plan with a route, a cost, and a funding ask to the province and Ottawa\n- Report to residents every year on what’s funded, what’s designed, and what’s built',
  goal: 2500,
  count: 842,
  status: 'open',
};

export const imagineSurrey = {
  site: {
    theme: { skin: 'imagine-surrey', logo: { url: '/media/is-logo', alt: 'Imagine Surrey' } },
    org: { name: 'Imagine Surrey', email: 'hello@imaginesurrey.ca', privacy_url: '/privacy' },
    nav: {
      items: [
        { label: 'Promise tracker', href: '/tracker' },
        { label: 'Volunteer', href: '/volunteer' },
        { label: 'Events', href: '/events' },
        { label: 'Act', href: '/act' },
        { label: 'Join', href: '/#m-join' },
        { label: 'News', href: '/news' },
      ],
      cta: { label: 'Donate', href: '/donate' },
    },
    footer: {
      acknowledgement: 'We live and work on the shared traditional territories of the Coast Salish peoples, including the Semiahmoo, Katzie, and Kwantlen First Nations. We’re committed to relationships built on respect and reconciliation.',
      links: [
        { label: 'About', href: '/#m-board' },
        { label: 'News', href: '/news' },
        { label: 'Events', href: '/events' },
        { label: 'Promise tracker', href: '/tracker' },
        { label: 'Donate', href: '/donate' },
      ],
    },
    announcement: { enabled: false, text: '' },
    seo: {
      title: 'Imagine Surrey',
      description: 'Imagine Surrey is residents organizing for a City Hall that gets the basics right: safe streets, fast commutes, smart investments, lower costs and strong services.',
      image: { url: '/media/members-rally', alt: 'Imagine Surrey supporters' },
    },
    social: [
      { name: 'Instagram', handle: '@imagine.surrey', url: 'https://www.instagram.com/imagine.surrey', cta: 'Follow on Instagram' },
      { name: 'Facebook', handle: 'Imagine Surrey', url: 'https://www.facebook.com/profile.php?id=61578371604513', cta: 'Follow on Facebook' },
      { name: 'X', handle: '@imaginesurrey', url: 'https://x.com/imaginesurrey', cta: 'Follow on X' },
      { name: 'TikTok', handle: '@imagine.surrey', url: 'https://www.tiktok.com/@imagine.surrey', cta: 'Follow on TikTok' },
      { name: 'LinkedIn', handle: 'Imagine Surrey', url: 'https://www.linkedin.com/in/imaginesurrey', cta: 'Follow on LinkedIn' },
      { name: 'Threads', handle: '@imagine.surrey', url: 'https://www.threads.com/@imagine.surrey', cta: 'Follow on Threads' },
      { name: 'Bluesky', handle: '@imagine-surrey', url: 'https://bsky.app/profile/imagine-surrey.bsky.social', cta: 'Follow on Bluesky' },
    ],
  },
  page: {
    id: 'page-home',
    slug: 'home',
    title: 'Home',
    description: '',
    modules: [
      { id: 'hero', kind: 'hero', props: {
        titlePrefix: 'Fighting for',
        words: ['Surrey', 'affordability', 'SkyTrain', 'commuter rail', 'faster buses', 'affordable homes', 'lower fees', 'faster permits', 'safer streets', 'no service cuts', 'better services', 'child care', 'more parks', 'community centres', 'more sidewalks'],
        text: 'Surrey is the nurse renting in City Centre, the family in Newton, the shop owner in Cloverdale, and the senior in Guildford. They all want the same thing: a City Hall that gets the basics right. Imagine Surrey is residents organizing to make that happen. Become a member and help build it.',
        primaryCta: { label: 'Become a member', href: '/#m-join' },
        secondaryCtas: [{ label: 'Chip in', href: '/donate' }],
        image: { url: '/media/hero-park', alt: 'A park in Surrey City Centre on a clear day: a lotus fountain and flower planters in a reflecting pool, with the SkyTrain line and residential towers behind' },
      } },
      { id: 'actnow', kind: 'actNow', props: { title: 'Act now', showCounts: false } },
      { id: 'stand', kind: 'columns', props: {
        title: 'What we stand for',
        intro: 'Surrey has what it takes to be the best place in Canada to raise a family, start a business, or grow old. What it needs is a City Hall that treats the basics as the whole job. That’s the work.',
        items: [
          { icon: 'shield', title: 'Safe streets', body: 'A police service focused on the crimes hurting Surrey families, from extortion to street racing, and a Crime Prevention Society with its funding restored.' },
          { icon: 'bus', title: 'Fast commutes', body: 'Synchronized traffic lights, expanded key roads, a $70 monthly transit pass for Surrey residents, and 50 km of new sidewalk on streets that have none today.' },
          { icon: 'trend', title: 'Smart investments', body: 'Big projects judged on value, not headlines: an arena on the right land at the right price, three new community centres, and a City Hall that buys from Surrey businesses whenever it can.' },
          { icon: 'tag', title: 'Lower costs', body: 'Property taxes held at or below inflation, recreation fees cut in half, and at least 1,000 affordable homes a year so the people who keep Surrey running can afford to live here.' },
          { icon: 'civic', title: 'Strong services', body: 'Services that show up: more public washrooms, free programs for seniors, one SurreyPass card for every City service, and no cuts to the services people count on.' },
        ],
        ctaText: 'Ready to bring change to Surrey? Become a member!',
        cta: { label: 'Read the 2026 election platform', href: 'https://issuu.com/imaginesurrey/docs/imagine_surrey_platform_2026_-_signed' },
      } },
      { id: 'news', kind: 'news', props: { title: 'Latest news', limit: 3 } },
      { id: 'join', kind: 'join', props: {
        title: 'Become a member',
        intro: 'Imagine Surrey is residents, not a brand. Members set the priorities, have a direct say in what we stand for, and hear first when something is happening in their neighbourhood.',
        benefits: [
          { title: 'Set the priorities', body: 'Members have a direct say in what Imagine Surrey stands for and takes on next.' },
          { title: 'Organize where you live', body: 'Connect with members in your town centre and take on local issues together, from a missing sidewalk to a closed washroom.' },
          { title: 'Hear it first', body: 'Events, actions, and news before anyone else, and a direct line to the people doing the work.' },
        ],
        amountTitle: 'Your membership, by donation',
        amountNote: 'Give what you can. Membership runs for a year, and every dollar goes to organizing in Surrey.',
        photo: { url: '/media/members-rally', alt: 'A packed room of Imagine Surrey supporters cheering and holding up signs that read change that works for you' },
      } },
      { id: 'newsletter', kind: 'newsletter', props: { title: 'Not ready to join? Get the newsletter', intro: 'News and events from around Surrey.', askPhone: false, buttonLabel: 'Subscribe', tone: 'surface' } },
      { id: 'skytrain', kind: 'petition', props: { campaign: 'c-skytrain', eyebrow: 'Petition', tone: 'brand' } },
      { id: 'donate', kind: 'donate', props: {
        title: 'Chip in',
        intro: 'In BC, elector organizations can only take contributions from individuals. No corporate money, no union money. That’s the law, and we’re glad of it. It means Imagine Surrey runs on Surrey residents who give what they can.',
        text: 'Your contribution pays for the unglamorous work: organizers, printing, outreach in every town centre, and keeping the lights on.',
        amounts: ['25', '50', '100', '250'],
        allowMonthly: true,
        monthlyNote: 'Monthly donors automatically support the Imagine Victory Fund, our war chest for the next election.',
        clubNote: '',
      } },
      { id: 'organize', kind: 'band', props: { title: 'When we organize,', highlight: 'Surrey wins', cta: { label: 'Become a member', href: '/#m-join' }, tone: 'accent' } },
      { id: 'board', kind: 'people', props: {
        title: 'Board of directors',
        intro: 'The board keeps Imagine Surrey running and answers to the members. Eight director seats are open: one for each neighbourhood, one for youth and campus clubs, and one for seniors.',
        seats: ['President', 'Vice-President', 'Secretary-Treasurer', 'Director, Newton', 'Director, Whalley', 'Director, Fleetwood', 'Director, Cloverdale', 'Director, Guildford'].map((role) => ({ role, name: '', bio: '' })),
      } },
      { id: 'committees', kind: 'groups', props: {
        title: 'Committees',
        intro: 'Committees do the work between board meetings. Pick the one that matches what you’re good at, the one for your neighbourhood, or the one on your campus.',
        items: [
          { title: 'Communications', body: 'The website, the newsletter, social media, and getting the message out.' },
          { title: 'Outreach', body: 'Events, door-knocking, and showing up where people already gather.' },
          { title: 'Membership', body: 'Signing up new members, welcoming them in, and keeping renewals on track.' },
          { title: 'Fundraising', body: 'Donors, events, and the Star Club. Keeping the lights on.' },
          { title: 'Nominations', body: 'Board nominations, bylaws, and keeping the organization accountable to its members.' },
          { title: 'Policy', body: 'Digging into Surrey’s issues and turning them into positions the board can act on.' },
        ],
      } },
      { id: 'events', kind: 'events', props: { title: 'Come and meet us', limit: 3 } },
      { id: 'social', kind: 'social', props: { intro: 'The latest from our feeds: events, actions, and news from around Surrey.', accounts: [] } },
    ],
  },
  campaign: IS_CAMPAIGN,
  data: sampleData({ [IS_CAMPAIGN.id]: IS_CAMPAIGN }),
};

// ── A generic campaign on the Base skin (made up) ──
const BASE_CAMPAIGN = {
  id: 'c-parks',
  slug: 'keep-the-pool-open',
  kind: 'pledge',
  title: 'Keep the Harbourside pool open',
  excerpt: 'A sample pledge: the city plans to close the only public pool on the east side.',
  statement: 'I pledge to stand up for the Harbourside pool: I’ll write to council, come to the hearing and tell my neighbours.',
  body: 'The **Harbourside pool** is where half the east side learned to swim. This is a sample pledge for the renderer’s tests.\n\n- Write to council\n- Come to the hearing\n- Tell your neighbours',
  goal: 500,
  count: 312,
  status: 'open',
};

export const baseSample = {
  site: {
    theme: { skin: 'base' },
    org: { name: 'Harbour City Together', email: 'hello@example.org', phone: '604-555-0100', address: '100 Example Street, Harbour City', authorization: 'Authorized by Ada Example, financial agent, 604-555-0100', privacy_url: '/privacy' },
    nav: { items: [{ label: 'About us', href: '/about' }, { label: 'Volunteer', href: '/volunteer' }, { label: 'News', href: '/news' }], bar: [{ label: 'Our plan', href: '/plan' }], cta: { label: 'Donate', href: '/donate' } },
    footer: { acknowledgement: 'We work on the unceded territory of the **sample nations** — written in Website → Footer.', links: [{ label: 'About us', href: '/about' }, { label: 'Contact', href: '/contact' }] },
    announcement: { enabled: true, text: 'Sample announcement: the next town hall is on Thursday.', link: { label: 'Save your seat', href: '/#m-events' } },
    seo: { title: 'Harbour City Together', description: 'A sample campaign site on the Base skin.' },
    social: [{ name: 'Instagram', handle: '@example', url: 'https://www.instagram.com/example' }, { name: 'Bluesky', handle: '@example.org', url: 'https://bsky.app/profile/example.org' }],
  },
  page: {
    id: 'page-base-home',
    slug: 'home',
    title: 'Home',
    description: 'A sample campaign site.',
    modules: [
      { id: 'hero', kind: 'hero', props: { titlePrefix: 'A city that works for', words: ['everyone', 'renters', 'families', 'seniors'], text: 'Harbour City Together is a sample campaign: neighbours organizing for safe streets, homes people can afford and a council that listens.\n\nJoin us, chip in or come to the next town hall.', primaryCta: { label: 'Join us', href: '/#m-join' }, secondaryCtas: [{ label: 'Volunteer', href: '/#m-volunteer' }] } },
      { id: 'actnow', kind: 'actNow', props: { title: 'Act now', showCounts: true } },
      { id: 'plan', kind: 'columns', props: { title: 'What we stand for', intro: 'Three things, done well.', items: [{ icon: 'home', title: 'Homes', body: 'More homes near transit, and rules that keep renters in them.' }, { icon: 'leaf', title: 'Parks', body: 'A park within a ten-minute walk of every home.' }, { icon: 'people', title: 'People first', body: 'A council that answers its email.' }], ctaText: '', cta: { label: '', href: '' } } },
      { id: 'pledge', kind: 'petition', props: { campaign: 'c-parks', eyebrow: '', tone: 'paper' } },
      { id: 'story', kind: 'text', props: { title: 'Why we started', body: 'We are **neighbours**, not a party. Read [our plan](/plan) or [email us](mailto:hello@example.org).\n\n> Change starts on your street.', cta: { label: 'Read the plan', href: '/plan' }, tone: 'surface' } },
      { id: 'quote', kind: 'quote', props: { quote: 'I joined because the bus stop on my corner had no shelter for six years. It has one now.', name: 'Sam Example', role: 'Volunteer, east side', photo: { url: '', alt: '' }, tone: 'paper' } },
      { id: 'donate', kind: 'donate', props: { title: 'Chip in', intro: 'Every gift is from a person, never a company or a union.', text: 'It pays for printing and the office.', amounts: ['10', '25', '50', '100', '500'], allowMonthly: true, monthlyNote: 'Monthly gifts let us plan ahead.', clubNote: '' } },
      { id: 'volunteer', kind: 'volunteer', props: { title: 'Volunteer', intro: 'Tell us how you would like to help. An organizer will be in touch within a day.', roles: [], askAvailability: true, tone: 'paper' } },
      { id: 'openings', kind: 'shifts', props: { title: 'Volunteer openings', intro: 'Pick a shift: two or three hours, with people who’ve done it before.', limit: 4, showMap: true } },
      { id: 'events', kind: 'events', props: { title: 'Upcoming events', limit: 3 } },
      { id: 'band', kind: 'band', props: { title: 'When we organize,', highlight: 'we win', cta: { label: 'Join us', href: '/#m-join' }, tone: 'brand' } },
      { id: 'questions', kind: 'faq', props: { title: 'Questions', items: [{ q: 'Who can join?', a: 'Anyone who lives in **Harbour City** and is 14 or older.' }, { q: 'Where does the money go?', a: 'Printing, the office and [our events](/events).' }] } },
      { id: 'tracker', kind: 'tracker', props: { title: 'Promise tracker', intro: 'What council promised, and what happened.', items: [{ title: 'A new library branch on the east side', status: 'progress', due: '2027', note: 'Design approved; construction not funded yet.', source: 'https://example.org/minutes' }, { title: 'Free transit for under-13s', status: 'kept', due: '', note: 'Started in September.', source: '' }, { title: 'Fix the Harbour Road crossing', status: 'broken', due: '2026', note: '', source: '' }, { title: 'Publish every council vote online', status: 'pending', due: '', note: '', source: '' }] } },
      { id: 'news', kind: 'news', props: { title: 'News', limit: 3 } },
      { id: 'team', kind: 'people', props: { title: 'Our team', intro: 'Volunteers, all of us.', seats: [{ role: 'Chair', name: 'Ada Example', photo: { url: '', alt: '' }, bio: 'Teacher, east side.' }, { role: 'Treasurer', name: 'Sam Example', photo: { url: '', alt: '' }, bio: '' }, { role: 'Youth seat', name: '', photo: { url: '', alt: '' }, bio: '' }] } },
      { id: 'groups', kind: 'groups', props: { title: 'Get involved locally', intro: 'A team in every neighbourhood.', items: [{ title: 'East side', body: 'Meets on Tuesdays.' }, { title: 'Downtown', body: 'Meets on Thursdays.' }] } },
      { id: 'video', kind: 'video', props: { title: 'Watch: our first town hall', url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE', caption: 'A sample video.' } },
      { id: 'join', kind: 'join', props: { title: 'Become a member', intro: 'Members choose our priorities.', benefits: [{ title: 'A vote', body: 'On what we work on next.' }], amountTitle: 'Your membership', amountNote: '', photo: { url: '', alt: '' } } },
      { id: 'newsletter', kind: 'newsletter', props: { title: 'Get the newsletter', intro: 'News and events. Unsubscribe anytime.', askPhone: true, buttonLabel: 'Sign up', tone: 'surface' } },
      { id: 'contact', kind: 'contact', props: { title: 'Get in touch', intro: 'We read everything.', topics: ['Volunteering', 'Media', 'Something else'] } },
      { id: 'social', kind: 'social', props: { intro: 'Follow along.', accounts: [] } },
    ],
  },
  campaign: BASE_CAMPAIGN,
  data: sampleData({ [BASE_CAMPAIGN.id]: BASE_CAMPAIGN }),
};

// A news post for the post template.
export const samplePost = {
  slug: 'sample-post-one',
  title: 'Sample post: what the news module shows',
  excerpt: 'A sample post for the renderer’s tests.',
  body: '# A heading\n\nA paragraph with **bold**, *italic* and [a link](/about).\n\n- one\n- two\n\n![A sample picture](/media/hero-park)',
  image: { url: '/media/hero-park', alt: 'A sample picture' },
  published_at: '2026-11-02T17:00:00Z',
};
