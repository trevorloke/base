// Imagine Surrey's preset: everything in base.win that is Imagine Surrey's
// own, in one object. A server uses it only when STARBASE_BRAND is
// imagine-surrey (server/lib/preset.js, the one file that may import this
// folder); every other campaign's server never reads a value from here.
//
// Each value is a copy, character for character, of what the code held
// before the preset existed, so Imagine Surrey's own server answers as it
// always did. Change a value here only when Imagine Surrey asks for it.
//
// Beside this file (loaded only through it, and only under the brand):
//   site-seed.js, site-content.js   its website as first made
//   sample.js                       the "Load sample data" people
//   assets/site/                    its website's logo, photographs, look.css
//   assets/app/                     its star icons

// ── Lists ──
// The Language field's choices (Pick several): the membership form's own
// list, in its order, with Other (the language itself goes in Other language).
const FORM_LANGUAGES = ['English', 'Punjabi', 'Hindi', 'Urdu', 'Mandarin', 'Cantonese', 'Filipino', 'Korean', 'Vietnamese', 'Arabic', 'Farsi', 'Gujarati', 'Spanish', 'French'];
const LANGUAGES = [...FORM_LANGUAGES, 'Other'];
// The membership form's interests, in its order (Interests, Pick several).
const INTERESTS = ['Safer streets', 'Faster commutes', 'Smarter investments', 'Lower costs', 'Stronger services', 'Homes I can afford', 'Support for small business', 'Healthier communities', 'Better schools / school board issues', 'Climate / parks', 'Metro Vancouver / regional issues'];
// School and campus together, one pick.
const CAMPUSES = [
  'Kwantlen Polytechnic University – Surrey',
  'Kwantlen Polytechnic University – Cloverdale',
  'SFU Surrey',
];
// Surrey's largest first (2021 census), the Christian churches together,
// then the rest, then Other religion / No religion / Prefer not to say.
const FAITHS = [
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
const DWELLING_TYPES = [
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

export default {
  key: 'imagine-surrey',
  // A server with no brand set and exactly this name still gets this preset,
  // and its log says to set the brand (server/lib/preset.js brandNote).
  orgNames: ['Imagine Surrey'],

  // ── The place ──
  org: { city: 'Surrey', box: [49.002, -122.92, 49.222, -122.67] },
  // Where maps open. bounds: the city's limits — the Fraser to the north, the
  // border to the south, Delta and Langley either side.
  map: { centre: [49.1913, -122.849], zoom: 12, bounds: [[49.0, -122.93], [49.22, -122.68]] },

  // ── The opponents a new rating scale starts with ──
  candidates: [
    { code: '4D', name: 'McCallum',  label: 'Opposed — Doug McCallum supporter' },
    { code: '4B', name: 'Locke',     label: 'Opposed — Surrey Connect / Brenda Locke' },
    { code: '4F', name: 'Annis',     label: 'Opposed — Surrey First / Linda Annis' },
    { code: '4N', name: 'van Vliet', label: 'Opposed — SurreyNow / Troy van Vliet' },
    { code: '4C', name: 'Randhawa',  label: 'Opposed — Surrey Conservatives / Honveer Randhawa' },
  ],

  // ── The app's look before a manager saves one: Surrey Navy, marigold as
  // the second colour, its wordmark ──
  brand: {
    key: 'imagine-surrey',
    color: '#003979',
    second: '#ffc72c',
    sidebar: 'light',
    corners: 'soft',
    heading: 'inter',
    logo: '/site-assets/imagine-surrey/logo.webp',
    logoDark: '/site-assets/imagine-surrey/logo-light.png',
    learn: 'ImagineU',
    icon: { href: '/star.png', type: 'image/png' },
    touchIcon: '/apple-touch-icon.png',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    sitePlaceholder: 'https://imaginesurrey.ca',
    sampleLede: 'Try it with 52 made-up Surrey voters.',
    // Settings → Brand: what "start again" goes back to.
    startWord: 'Imagine Surrey’s look',
    // The little flag on a map dot.
    mapFlag: '#ffc72c',
  },

  // ── Training ──
  training: { label: 'ImagineU', oldPaths: ['/imagineu'] },

  // ── Profile fields ──
  fields: {
    // Imagine Surrey's standard fields: one for every column of the
    // campaign's list that the core person record has no home for, named
    // exactly as the list's columns.
    standard: [
      { name: 'Home phone', kind: 'text', volunteers: true },
      { name: 'Province', kind: 'text', volunteers: false },
      { name: 'House notes', kind: 'text', volunteers: true },
      { name: 'Building notes', kind: 'text', volunteers: true },
      { name: 'Access type', kind: 'text', volunteers: true },
      { name: 'Dwelling type', kind: 'choice', choices: DWELLING_TYPES, display: 'list', volunteers: true },
      { name: 'Interaction status', kind: 'text', volunteers: false },
      { name: 'Interaction date', kind: 'date', volunteers: false },
      { name: 'Organizer', kind: 'text', volunteers: false },
      { name: 'Email opt-in', kind: 'yesno', volunteers: false },
      { name: 'SMS opt-in', kind: 'yesno', volunteers: false },
      { name: 'Sign', kind: 'yesno', volunteers: true },
      { name: 'Support', kind: 'number', volunteers: false },
      { name: 'Voted', kind: 'yesno', volunteers: false },
      // Not from the list's columns — asked for by the campaign.
      { name: 'Voter eligibility', kind: 'choice', choices: ['Eligible', 'Ineligible'], volunteers: true },
      { name: 'Language', kind: 'choices', choices: LANGUAGES, volunteers: true },
      { name: 'Notes', kind: 'note', volunteers: false },
      // The membership form's: what a member tells the campaign.
      { name: 'Gender', kind: 'text', volunteers: false },
      { name: 'Birth date', kind: 'date', volunteers: false },
      { name: 'Citizenship', kind: 'choice', choices: ['Canadian citizen', 'Permanent resident'], volunteers: false },
      { name: 'Union member', kind: 'yesno', volunteers: false },
      { name: 'Union local', kind: 'text', volunteers: false },
      { name: 'Campus', kind: 'choice', choices: CAMPUSES, volunteers: false },
      { name: 'Other language', kind: 'text', volunteers: true },
      // Private: the office only, and only what the person says.
      { name: 'Faith', kind: 'choice', choices: FAITHS, sensitive: true, volunteers: false },
      { name: 'Interests', kind: 'choices', choices: INTERESTS, volunteers: false },
      { name: 'Interested in being a candidate', kind: 'yesno', volunteers: false },
    ],
    languages: LANGUAGES,
    interests: INTERESTS,
    campuses: CAMPUSES,
    faiths: FAITHS,
    // Lower-case words → the Campus choice they probably mean (a pre-fill
    // for a person to confirm). No guess for a bare kwantlen, kpu or sfu.
    guesses: {
      campus: {
        'Kwantlen Polytechnic University – Surrey': ['kpu surrey', 'kwantlen surrey', 'kpu newton', 'kwantlen newton'],
        'Kwantlen Polytechnic University – Cloverdale': ['kpu cloverdale', 'kwantlen cloverdale'],
        'SFU Surrey': ['sfu surrey', 'simon fraser surrey'],
      },
    },
    // At start-up, a campaign from before a field existed is given it
    // (server/ext/fields/sql.js): kept for Imagine Surrey's database.
    bootBackfill: true,
  },

  // ── The paper membership form, and joining on the website ──
  membership: {
    terms: [1, 4],
    // At least $10 a year, $5 for members aged 14 to 30 on the day they
    // join; members are 14 or older.
    dues: { adult_cents: 1000, youth_cents: 500, youth_ages: [14, 30], min_age: 14 },
    citizenship: ['citizen', 'pr'],
    optIn: true,
    once: [25000, 10000, 5000, 1000],
    monthly: [5000, 2500, 1000, 500],
    // The website's Join form: the usual amounts above the minimum.
    suggested: [1000, 2500, 5000, 10000],
    clubs: [
      { key: 'superstar', label: 'Superstar Club' },
      { key: 'star', label: 'Star Club', schoolBoard: true },
    ],
    schoolBoardLine: 'Star Club to the school board slate (not council)',
    websiteTag: 'Member (joined online)',
    formCity: 'Surrey',
    // What the form offers when the campaign's own fields can't be read
    // (campuses: fields.campuses above).
    fallback: { languages: FORM_LANGUAGES, interests: INTERESTS },
  },

  // ── Donor tiers, worked out from real gifts; the first is the highest ──
  //   superstar: $3,000+ in the calendar year, or $250+ a month
  //   star:      $1,000+ in the calendar year, or $100+ a month
  donorTiers: [
    { key: 'superstar', label: 'Superstar', yearCents: 300000, monthlyCents: 25000 },
    { key: 'star', label: 'Star', yearCents: 100000, monthlyCents: 10000 },
  ],

  // ── The public website ──
  site: {
    // Navy, yellow, ink, surface and line as on imaginesurrey.ca; action is
    // its red for fills with white text (5.1:1), and headings carry the
    // brand's layered red shadow (pop).
    skin: {
      key: 'imagine-surrey',
      label: 'Imagine Surrey',
      colors: { brand: '#003979', brandInk: '#ffffff', accent: '#fff100', accentInk: '#0f1e33', ink: '#0f1e33', paper: '#ffffff', surface: '#f2f4f8', line: '#e3e7ef', link: '#003979', action: '#d81b1e', actionInk: '#ffffff' },
      fonts: { heading: 'montserrat', body: 'montserrat' },
      radius: 'soft',
      logo: { url: '', alt: 'Imagine Surrey' },
      pop: true,
    },
    // Its own stylesheet (the heading shadow), linked after site.css.
    css: 'look.css',
    // Its pictures: served at /site-assets/imagine-surrey/… from this folder.
    assets: { prefix: 'imagine-surrey/', dir: new URL('./assets/site/', import.meta.url) },
    seed: () => import('./site-seed.js'),
    // The present website's addresses (apps/web), for the day its domain
    // points here (SITE.md "On its own domain"): each to the page here that
    // does the same thing, sent on only when that page is live; 'former' —
    // its own links in emails it already sent, its members' and its staff's
    // pages — to the present website at its own address, when
    // STARBASE_SITE_FORMER_URL names it. Retired pages go home, as /stats did.
    oldPaths: [
      ['/stats', '/'],
      ['/join/welcome', '/'],
      ['/donate/thanks', '/donate'],
      ['/act/:slug/print', '/act/:slug'],
      ['/tracker/:page', '/tracker'],
      ['/volunteer/openings/*', '/volunteer'],
      ['/events/:slug', '/events'],
      ['/neighbourhoods', '/'],
      ['/neighbourhoods/:slug', '/'],
      ['/shop', '/'],
      ['/shop/thanks', '/'],
      ['/newsletter/*', 'former'],
      ['/api/newsletter/*', 'former'],
      ['/api/tracker/*', 'former'],
      ['/me', 'former'],
      ['/me/*', 'former'],
      ['/api/me/*', 'former'],
      ['/admin', 'former'],
      ['/admin/*', 'former'],
      ['/api/admin/*', 'former'],
    ],
    // Words on the public site that are this campaign's (the membership's
    // rules, and its own example of a postal code). A saved translation is
    // found by its English sentence, so these stay word for word.
    words: {
      'err.postal_code': 'Enter a postal code like V3T 1A1',
      'field.term': 'How long',
      'field.oneYear': '1 year',
      'field.fourYears': '4 years',
      'srv.members14': 'Members are 14 or older',
      'srv.citizenOrPr': 'Canadian citizen or permanent resident',
      'srv.oneOrFour': 'One year or four',
      'srv.membershipYear': 'The membership is at least {amount} for a year',
      'srv.membershipFour': 'The membership is at least {amount} for four years',
      'srv.membershipYearYouth': 'The membership is at least {amount} for a year (aged 14 to 30)',
      'srv.membershipFourYouth': 'The membership is at least {amount} for four years (aged 14 to 30)',
      'pay.duesOnce': 'Membership dues are paid once.',
      'pay.oneOrFour': 'Choose 1 or 4 years.',
      'pay.birth': 'Your birth date, as YYYY-MM-DD.',
      'pay.citizen': 'Canadian citizen or permanent resident.',
    },
    // Where each new key above sits among the product's fixed words: just
    // before the word named. So the list a translator works through, and a
    // translated page's own data, stay in the order they always had.
    wordsBefore: {
      'field.term': 'field.comment', 'field.oneYear': 'field.comment', 'field.fourYears': 'field.comment',
      'srv.members14': 'srv.pickAmount', 'srv.citizenOrPr': 'srv.pickAmount', 'srv.oneOrFour': 'srv.pickAmount',
      'srv.membershipYear': 'srv.declareJoin', 'srv.membershipFour': 'srv.declareJoin',
      'srv.membershipYearYouth': 'srv.declareJoin', 'srv.membershipFourYouth': 'srv.declareJoin',
      'pay.duesOnce': 'pay.tooLarge',
      'pay.oneOrFour': 'pay.monthlyMost', 'pay.birth': 'pay.monthlyMost', 'pay.citizen': 'pay.monthlyMost',
    },
    // What a new section starts with, laid over the product's own.
    moduleDefaults: {
      band: { title: 'When we organize,', highlight: 'we win', cta: { label: 'Join us', href: '/join' } },
      hero: { primaryCta: { label: 'Join us', href: '/join' } },
    },
    fieldLabels: { 'actNow.showCounts': 'Show live numbers (members, signatures)' },
  },

  // ── The installed app's icons, at the addresses phones already ask for ──
  appFiles: {
    '/star.png': 'assets/app/star.png',
    '/icon-192.png': 'assets/app/icon-192.png',
    '/icon-512.png': 'assets/app/icon-512.png',
    '/apple-touch-icon.png': 'assets/app/apple-touch-icon.png',
  },

  // ── "Load sample data" ──
  sample: {
    lede: 'Try it with 52 made-up Surrey voters.',
    // Profile fields the sample adds, with who has what (by name).
    fields: [
      {
        name: 'Language at home',
        kind: 'choice',
        choices: ['English', 'Punjabi', 'Mandarin', 'Tagalog', 'Hindi', 'Other'],
        volunteers: true,
        values: {
          'Harjit Gill': 'Punjabi', 'Simran Gill': 'Punjabi', 'Gurpreet Sandhu': 'Punjabi', 'Manpreet Dhaliwal': 'Punjabi',
          'Mei Lin': 'Mandarin', 'Maya Chen': 'English', 'Isabel Cruz': 'Tagalog', 'Ravi Shankar': 'Hindi', 'Tom Riley': 'English',
        },
      },
      {
        name: 'Strata council member',
        kind: 'yesno',
        volunteers: false,
        values: { 'Jasmine Wong': true, 'Sofia Petrova': true, 'Hannah Lee': false },
      },
      {
        name: 'Union local',
        kind: 'text',
        volunteers: false,
        values: { 'Kwame Mensah': 'CUPE 402', 'Owen Price': 'UFCW 1518' },
      },
    ],
    // The upcoming Saturday shift the sample makes.
    shift: { title: 'Saturday canvass — Newton (sample)', place: 'Newton Rec Centre, 13730 72 Ave' },
    load: () => import('./sample.js'),
  },

  // ── Example words: the grey words in an empty box, and a few messages.
  // Every other campaign reads the neutral ones written in the code ──
  examples: {
    'list.name': 'Members in Newton',
    'shift.title': 'Saturday doorknock — Fleetwood',
    'team.name': 'New team, e.g. Newton canvass crew',
    'mainstreet.place': 'Newton bus loop · Cloverdale market · the rally',
    'sign.corner': '104 Ave & King George Blvd',
    'bank.name': 'Undecided in Newton — week of Nov 3',
    'bank.tag': 'volunteer, newton…',
    'bank.street': '104 Ave',
    'turf.name': 'e.g. Fleetwood East',
    postal: 'V3T 1V8',
    'postal.short': 'V3W',
    address: '13450 104 Ave',
    phone: '604-555-0100',
    'phone.2': '604-555-0101',
    'phone.3': '604-555-0102',
    'microsite.name': 'Doug Didn’t',
    'import.pastTag': 'Voting Locke',
    'role.community': 'Community (Newton, Whalley, …)',
    domain: 'imaginesurrey.ca',
    colour: '#003979',
  },
};
