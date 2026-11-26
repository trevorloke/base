// Every fixed word a visitor can read on the campaign's websites (TR
// decision 21), in English, by key. Components call rc.w('key', { slot })
// on the server; islands get their words already translated in their props
// (wordsFor below) and fall back to these. On an English page rc.w returns
// exactly these, so English pages are unchanged. Slots are in braces and
// are never translated ({amount}, {org}, {name}). A new visitor word goes
// here first (HOME, VG, WA: see TR's Seams); the "no English left" test in
// server/test/site-lang.test.js finds a miss.
//
// These are the product's words, for every campaign. A campaign whose
// set-up brings words of its own (the rules of its membership, say) has
// them laid over these on its own server (server/ext/site/from-preset.js
// siteWords), under their own keys; nothing of one campaign is written here.
export const UI_WORDS = {
  // Around every page
  'shell.skip': 'Skip to content',
  'shell.preview': 'This is a draft: only people with this link can see it, and it isn’t on the public site yet.',
  'shell.previewTitle': 'Preview.',
  'shell.announcement': 'Announcement',
  'shell.mainNav': 'Main',
  'shell.home': 'Home',
  'shell.follow': 'Follow',
  'shell.links': 'Links',
  'shell.on': '{org} on {network}',
  'shell.platform': 'Read the platform',
  'shell.privacy': 'Privacy',
  'shell.websiteBy': 'A website by {name}',
  'shell.donate': 'Donate',
  'menu.label': 'Menu',
  'lang.nav': 'Language',

  // Pages of the site's own
  'page.notFound': 'Page not found',
  'page.notFoundLede': 'We couldn’t find that page. It may have moved, or the link may have a typo.',
  'page.tryThese': 'Try one of these instead',
  'page.homePage': 'Home page',
  'page.website': 'Website',
  'news.title': 'News',
  'news.all': 'All news',
  'news.allBack': '← All news',
  'news.readMore': 'Read more',
  'news.empty': 'News will appear here as soon as it’s published.',
  'act.title': 'Take action',
  'act.nothing': 'Nothing is open to sign right now.',
  'act.petition': 'Petition',
  'act.pledge': 'Pledge',
  'act.thePetition': 'The petition',
  'act.thePledge': 'The pledge',
  'act.closedPetition': 'This petition is closed.',
  'act.closedPledge': 'This pledge is closed.',
  'act.thanksSigned': 'Thank you to everyone who signed.',
  'act.morePetition': 'More about this petition',
  'act.morePledge': 'More about this pledge',
  'act.gonePetition': 'This petition isn’t available any more.',
  'act.choose': 'Choose a petition or pledge for this module.',
  'act.signers': 'have signed',
  'act.signatures': 'signatures',
  'act.of': 'of {goal}',
  'act.ofTotal': '{count} of {goal}',
  'act.signedShare': 'I signed “{title}”. Add your name:',
  'act.sharePetition': 'Share this petition',
  'act.sharePledge': 'Share this pledge',
  'act.signedCount': '{count} signed',
  'share.this': 'Share this',
  'share.it': 'Share it',

  // Modules
  'mod.watchVideo': 'Watch the video',
  'mod.video': '{provider} video',
  'mod.noPicture': 'No picture chosen yet',
  'mod.followAlong': 'Follow along',
  'mod.followOn': 'Follow on {network}',
  'mod.seatOpen': 'Seat open',
  'mod.putName': 'Put your name forward',
  'mod.nextUp': 'Next up',
  'mod.event': 'Event',
  'mod.volunteer': 'Volunteer',
  'mod.pickShift': 'Pick a volunteer shift',
  'mod.shiftHint': 'Door-knocking, phone banks and events, a few hours at a time.',
  'mod.soFar': 'So far',
  'mod.latest': 'Latest',
  'mod.members': 'members',
  'mod.signatures': 'signatures',
  'mod.newsWord': 'News',
  'mod.nextEvent': 'Next event',
  'mod.events': 'Events',
  'mod.eventsCalendar': 'Get our events in your calendar',
  'mod.eventsSoon': 'New events are on the way',
  'mod.eventsNewsletter': 'Get the newsletter and we’ll tell you as soon as the next one is booked.',
  'mod.checkBack': 'Check back soon.',
  'mod.getNewsletter': 'Get the newsletter',
  'mod.noOpenings': 'No openings right now.',
  'mod.tellUs': 'Tell us how you’d like to help',
  'mod.newEveryWeek': 'New ones are added every week.',
  'mod.mapHint': 'Tap a place to see it on a map.',
  'mod.promisesBy': 'Promises by status',
  'mod.due': 'Due {due}',
  'mod.whatHappened': 'What happened',
  'mod.source': 'Source',
  'mod.promisesSoon': 'Promises will be listed here.',
  'tracker.kept': 'Kept',
  'tracker.progress': 'In progress',
  'tracker.stalled': 'Stalled',
  'tracker.broken': 'Broken',
  'tracker.pending': 'Not started',
  'mod.notReadyGiving': 'Online giving isn’t set up yet.',
  'mod.notReadyMembership': 'Online membership isn’t set up yet.',
  'mod.notReadyGive': 'To give now, email',
  'mod.notReadyJoin': 'To join now, email',
  'mod.checkBackSoon': 'Please check back soon.',

  // Forms: fields
  'field.first': 'First name',
  'field.last': 'Last name',
  'field.email': 'Email',
  'field.phone': 'Mobile number',
  'field.postal': 'Postal code',
  'field.address': 'Street address',
  'field.city': 'City',
  'field.birth': 'Date of birth',
  'field.citizenship': 'Citizenship',
  'join.citizen': 'Canadian citizen',
  'join.pr': 'Permanent resident',
  'field.comment': 'Add a comment',
  'field.whySigning': 'Why you’re signing',
  'field.roles': 'What would you like to do?',
  'field.availability': 'When are you free?',
  'field.availabilityHint': 'For example: weekday evenings, Saturday mornings',
  'field.note': 'Anything else we should know?',
  'field.topic': 'What it’s about',
  'field.message': 'Your message',
  'field.details': 'Your details',
  'field.optional': '(optional)',
  'field.chooseOne': 'Choose one',
  'field.leaveEmpty': 'Leave this empty',
  'field.error': 'Error:',

  // Forms: titles, buttons, thank-yous
  'form.joinOnline': 'Join online',
  'form.membershipAmount': 'Your membership contribution',
  'form.joinPay': 'Join and pay',
  'form.joinThanks': 'Welcome aboard',
  'form.joinThanksBody': 'Thanks for joining. Watch your inbox for a note from us.',
  'form.donate': 'Donate',
  'form.donateThanks': 'Thank you',
  'form.donateThanksBody': 'Your gift is on its way. Watch your inbox for the receipt.',
  'form.signUp': 'Sign up',
  'form.newsletterThanks': 'You’re on the list',
  'form.newsletterThanksBody': 'Thanks for signing up. Watch your inbox for the next one.',
  'form.addName': 'Add your name',
  'form.signPledge': 'Sign the pledge',
  'form.addMyName': 'Add my name',
  'form.signedPledge': 'You’ve signed the pledge',
  'form.signedPetition': 'Your name is on the petition',
  'form.signedBody': 'Thank you. It counts for more when friends sign too — share it with a neighbour:',
  'form.signMeUp': 'Sign me up',
  'form.volunteerThanks': 'Thanks for offering to help',
  'form.volunteerThanksBody': 'An organizer will be in touch within a day.',
  'form.send': 'Send',
  'form.contactThanks': 'Thanks, your message is on its way',
  'form.contactThanksBody': 'Someone from the campaign will get back to you soon.',
  'form.thanks': 'Thank you',
  'form.sending': 'Sending…',
  'form.privacyPolicy': 'Privacy policy',
  'form.howOften': 'How often?',
  'form.once': 'Once',
  'form.monthly': 'Monthly',
  'form.chooseAmount': 'Choose an amount',
  'form.otherAmount': 'Other amount',
  'form.aMonth': 'a month',
  'form.checkField': 'Please check the highlighted field.',
  'form.checkFields': 'Please check the {count} highlighted fields.',
  'form.wrong': 'Something went wrong. Please try again.',
  'form.offline': 'We couldn’t send that. Check your connection and try again.',
  'form.busy': 'Too many tries from here. Please wait a minute and try again.',
  'form.unavailable': 'This can’t be sent online right now. Please try again later.',
  'form.needed': 'This is needed',
  'form.emailLike': 'Enter an email address like name@example.org',
  'form.emailOrPhone': 'Enter your email or a phone number',
  'form.smsNeedsPhone': 'Add a mobile number so we can text you, or untick the text box',
  'form.atLeast': 'Enter an amount of at least {amount}',
  'form.mostYear': 'The most you can give is {amount} this year',
  'form.mostMonth': 'The most you can give is {amount} a month',
  'form.reload': 'This page changed — please reload it and send again',

  // The errors a plain post comes back with (context.js ERROR_WORDS)
  'err.first_name': 'Enter your first name',
  'err.last_name': 'Enter your last name',
  'err.email': 'Enter your email address (or a phone number)',
  'err.emailAddress': 'Enter your email address',
  'err.phone': 'Enter a phone number with its area code',
  'err.postal_code': 'Enter a postal code like A1A 1A1',
  'err.postal': 'Enter your postal code',
  'err.address': 'Enter your street address',
  'err.city': 'Enter your city',
  'err.birth_date': 'Enter your date of birth',
  'err.citizenship': 'Choose one',
  'err.declaration': 'Tick the box to confirm',
  'err.amount_cents': 'Choose an amount',
  'err.term': 'Choose how long',
  'err.message': 'Write your message',
  'err.comment': 'Keep it under 1,000 characters',
  'err.campaign': 'This one isn’t taking names right now',
  'err.shift_id': 'That opening isn’t available any more',
  'err.consent_email': 'Tick the box to get email from us',
  'err.roles': 'Pick at least one',
  'err.busy': 'Too many tries from here — wait a minute and try again.',
  'err.payments': 'Online payments aren’t working right now — please try again in a few minutes, or get in touch to give another way.',
  'err.check': 'Please check the form and try again.',
  // The server's answers to a form (ext/site/forms.js, ext/payments)
  'srv.words': '{label}: words, please',
  'srv.tooLong': '{label} is too long — {max} characters at most',
  'srv.emailWrong': 'That email address doesn’t look right — check it and try again',
  'srv.phoneWrong': 'That phone number doesn’t look right — check it and try again',
  'srv.emailOrPhone': 'Add your email or your phone number',
  'srv.smsPhone': 'Add your mobile number to get texts',
  'srv.newsletterEmail': 'Add your email to get the newsletter',
  'srv.newsletterTick': 'Tick the box to get the newsletter',
  'srv.pickPledge': 'Pick a pledge to sign',
  'srv.pickPetition': 'Pick a petition to sign',
  'srv.rolesMax': 'Pick at most 20 ways to help',
  'srv.rolesList': 'Pick from the list',
  'srv.roleLong': 'Each way to help is 60 characters at most',
  'srv.pickEvent': 'Pick an event',
  'srv.joinEmail': 'Add your email to join',
  'srv.giveEmail': 'Add your email to give',
  'srv.birthLike': 'Your birth date, like 1990-04-21',
  'srv.pickAmount': 'Pick an amount',
  'srv.smaller': 'Pick a smaller amount',
  'srv.smallestGift': 'The smallest gift online is $5',
  'srv.onceOrMonthly': 'Once or monthly',
  'srv.pickSlate': 'Pick one of the slates',
  'srv.petitionGone': 'This petition isn’t on the site any more',
  'srv.notPledge': 'That isn’t a pledge',
  'srv.notPetition': 'That isn’t a petition',
  'srv.closedPetition': 'This petition is closed — thank you for your support',
  'srv.closedPledge': 'This pledge is closed — thank you for your support',
  'srv.eventClosed': 'That event isn’t taking sign-ups',
  'srv.eventOver': 'That event is over',
  'srv.eventFull': 'That event is full — pick another',
  'srv.mostYear': 'One person may give at most {amount} in a year',
  'srv.mostMonthly': 'A monthly gift is at most {amount} — the yearly limit over twelve months',
  'srv.declareJoin': 'Tick the declaration to join',
  'srv.declareGive': 'Tick the declaration: you’re a Canadian citizen or permanent resident living in BC, giving your own money',
  'srv.tooMany': 'Too many tries from here — wait a minute and try again.',
  'srv.wrong': 'Something went wrong on our side — please try again in a minute.',
  'pay.notSetUp': 'Online payments aren’t set up yet.',
  'pay.onceOrMonthly': 'Choose once or monthly.',
  'pay.tooLarge': 'That amount is too large.',
  'pay.forWho': 'Choose who the gift is for.',
  'pay.declare': 'Please confirm you can give: tick the declaration.',
  'pay.monthlyMost': 'The most a monthly gift can be this year is {amount}.',
  'pay.smallest': 'The smallest amount we can take online is {amount}.',
  // Stripe's line item (kept with the checkout: a retry sends the same name)
  'stripe.gift': 'Contribution to {org}',
  'stripe.monthly': 'Monthly contribution to {org}',
  'stripe.membership': '{org} membership ({term} years)',
  'stripe.membershipOne': '{org} membership (1 year)',

  // Openings and events (openings.js)
  'open.addCal': 'Add it to your calendar:',
  'open.appleOthers': 'Apple & others',
  'open.busy': 'Too many tries from here. Please wait a minute.',
  'open.failed': 'That didn’t go through. Please try again.',
  'open.signedUpName': 'You’re signed up, {name}. See you there!',
  'open.signedUp': 'You’re signed up. See you there!',
  'open.full': 'This one is full.',
  'open.signingUp': 'Signing you up…',
  'open.signMeUp': 'Sign me up',
  'open.signUp': 'Sign up',
  'open.there': 'I’ll be there',
  'open.seeMap': 'See the map',
  'open.mapNewTab': '(map, opens in a new tab)',
  'open.signingAs': 'Signing up as',
  'open.notYou': 'Not you?',
  'open.dropIn': 'drop in',
  'open.spot': '{count} spot left',
  'open.spots': '{count} spots left',
  'open.firstName': 'Enter your first name',

  // Sharing (share.js)
  'share.label': 'Share',
  'share.whatsapp': 'WhatsApp',
  'share.sms': 'Text',
  'share.facebook': 'Facebook',
  'share.x': 'X',
  'share.email': 'Email',
  'share.copy': 'Copy link',
  'share.newTab': '(opens in a new tab)',
  'share.copied': 'Link copied.',
  'share.selected': 'The link is selected: press Ctrl+C (or long-press) to copy it.',
  'share.link': 'The link to share',

  // The hero's rotating words (words.js)
  'words.pause': 'Pause the rotating words',
  'words.play': 'Play the rotating words',

  // The plain pages: a supporter's own choices, unsubscribe, expired links
  'plain.choicesTitle': 'Your email and texts',
  'plain.choose': 'Choose what {who} gets from us.',
  'plain.you': 'you',
  'plain.email': 'Email',
  'plain.texts': 'Texts',
  'plain.noEmail': 'We don’t have an email address for you.',
  'plain.noPhone': 'We don’t have a mobile number for you.',
  'plain.save': 'Save my choices',
  'plain.saved': 'Saved.',
  'plain.shareLink': 'Your link to share',
  'plain.shareHint': 'When someone signs up through it, we know you brought them in:',
  'plain.getEmails': 'You’ll get our emails',
  'plain.noEmails': 'No emails',
  'plain.textsOn': 'texts are on',
  'plain.noTexts': 'no texts',
  'plain.nothing': 'Nothing to change.',
  'plain.unsubTitle': 'Unsubscribe',
  'plain.unsubAsk': 'Stop emails from {org}?',
  'plain.unsubWont': '{email} won’t get our newsletters or other emails.',
  'plain.unsubButton': 'Unsubscribe',
  'plain.chooseInstead': 'Choose what you get instead',
  'plain.unsubDone': 'You’re unsubscribed',
  'plain.unsubDoneTitle': 'Unsubscribed',
  'plain.unsubDoneBody': '{email} won’t get emails from {org} any more.',
  'plain.changeMind': 'Change your mind, or your texts',
  'plain.expiredTitle': 'This link has expired',
  'plain.expired': 'This link doesn’t work any more',
  'plain.expiredBody': 'Links in our emails stop working after a while. Use the link in a newer email from us, or reply to one and we’ll change it for you.',
  'plain.back': 'Back to {org}',
  'plain.websiteBy': 'A website by',

  // The voter guide (VG): its module and island, the banner, the embed.
  // The product's words around the campaign's facts — never a fact itself.
  'vg.notOut': 'Voting information isn’t out yet.',
  'vg.notOutWhen': 'We’ll post where and when to vote as soon as {office} releases it.',
  'vg.theOffice': 'the elections office',
  'vg.remind': 'Tell me when it’s out',
  'vg.official': 'Official information: {label}',
  'vg.starts': 'Voting starts {day}',
  'vg.openNow': 'Voting is open now · until {time}',
  'vg.opensToday': 'Voting opens today at {time}',
  'vg.next': 'Next day to vote: {day} · {hours}',
  'vg.days': 'Days you can vote',
  'vg.advance': 'Advance',
  'vg.general': 'Election day',
  'vg.today': 'Today',
  'vg.done': 'Done',
  'vg.where': 'Where to vote',
  'vg.anywhere': 'Vote at any voting place on the day you choose.',
  'vg.checkWhere': 'Check where you vote: {label}',
  'vg.useLocation': 'Use my location',
  'vg.typeAddress': 'Or type your house number and street',
  'vg.find': 'Find',
  'vg.filters': 'Show voting places',
  'vg.openToday': 'Open today',
  'vg.search': 'Search by name or street',
  'vg.searchButton': 'Search',
  'vg.accessible': 'Accessible',
  'vg.curbside': 'Curbside',
  'vg.closed': 'Closed: {note}',
  'vg.closedToday': 'Closed today',
  'vg.changed': 'Changed {time}',
  'vg.directions': 'Directions',
  'vg.directionsTo': 'Directions to {name} in Google Maps',
  'vg.nearest': 'Nearest to you',
  'vg.nearArea': 'Nearest to this area',
  'vg.noMatch': 'No voting place matches.',
  'vg.clear': 'Clear the search',
  'vg.wait': 'See wait times at voting places',
  'vg.mail': 'Voting by mail',
  'vg.mailBy': 'Ask by {day}',
  'vg.mailAsk': 'Ask for a mail ballot',
  'vg.bring': 'What to bring',
  'vg.bringListed': 'If you’re on the voters list',
  'vg.bringUnlisted': 'If you’re not on the list yet',
  'vg.who': 'Who can vote',
  'vg.access': 'Getting there',
  'vg.ride': 'Need a ride to vote? Call or text {phone}',
  'vg.ballot': 'Look for these names',
  'vg.voteFor': '{office} · vote for up to {n}',
  'vg.voteForOne': '{office} · vote for 1',
  'vg.ours': 'Our candidate',
  'vg.source': 'From {label} · checked {day}',
  'vg.over': 'Voting is over. Thank you for voting.',
  'vg.results': 'Official results and information: {label}',
  'vg.noLocation': 'Your location isn’t available. Type your street address instead.',
  'vg.notFound': 'We couldn’t find that address. Try the house number and street name.',
  'vg.lookupOff': 'Looking up addresses isn’t available. Use your location or search by street.',
  'vg.busy': 'Busy — use your location or search by street',
  'vg.tooMany': 'Too many tries from here — wait a minute and try again',
  'vg.banner': 'Voting',
  'vg.bannerBefore': 'Voting starts {day}.',
  'vg.bannerOpen': 'Vote today until {time}.',
  'vg.bannerToday': 'Voting opens today at {time}.',
  'vg.bannerNext': 'Next day to vote: {day}.',
  'vg.bannerLink': 'Where to vote →',
  'vg.by': 'A voter guide by {org}',
};

// A campaign's own words laid over these: a key that is here gets the
// campaign's words in its place; a new key goes just before the key
// `before` names for it (so the list reads in one order wherever it is
// made), or last when it names none. Nothing of its own: these, as they are.
export const layWords = (own, before) => {
  const mine = Object.entries(own && typeof own === 'object' ? own : {}).filter(([, v]) => typeof v === 'string');
  if (!mine.length) return UI_WORDS;
  const at = before && typeof before === 'object' ? before : {};
  const added = mine.filter(([k]) => !Object.hasOwn(UI_WORDS, k));
  const over = Object.fromEntries(mine);
  const out = {};
  for (const [k, v] of Object.entries(UI_WORDS)) {
    for (const [nk, nv] of added) if (at[nk] === k) out[nk] = nv;
    out[k] = Object.hasOwn(over, k) ? over[k] : v;
  }
  for (const [nk, nv] of added) if (!Object.hasOwn(out, nk)) out[nk] = nv;
  return out;
};

// A template with its slots filled (a slot with no value stays as typed).
export const fillWords = (t, slots = {}) => String(t ?? '').replace(/\{([a-z]+)\}/gi, (m, k) => (slots[k] !== undefined && slots[k] !== null ? String(slots[k]) : m));

// The words an island needs, by key prefix, already translated by w (the
// page's rc.w without slots): { key: words }. Left out on English pages,
// so their props (and the page) are as they were.
export const ISLAND_WORDS = {
  form: ['field.', 'form.', 'share.', 'err.', 'open.'],
  openings: ['open.', 'form.', 'field.'],
  share: ['share.'],
  words: ['words.'],
  menu: ['menu.'],
  voteguide: ['vg.'],
};
// table: the words to pick from — these, or a campaign's own laid over them.
export const wordsFor = (island, w, table = UI_WORDS) => {
  const prefixes = ISLAND_WORDS[island] || [];
  return Object.fromEntries(Object.keys(table).filter((k) => prefixes.some((p) => k.startsWith(p))).map((k) => [k, w(k)]));
};
// The campaign's own English words an island may ask for ({} for most).
export const ownWordsFor = (island, own) => {
  const prefixes = ISLAND_WORDS[island] || [];
  return Object.fromEntries(Object.entries(own || {}).filter(([k, v]) => typeof v === 'string' && prefixes.some((p) => k.startsWith(p))));
};
// In an island: its own words when the page gave them (a translated page),
// else the campaign's own English (`own`, when the page sent any), else the
// English here.
export const wordsIn = (given, own) => (key, slots) => fillWords(
  given && typeof given[key] === 'string' ? given[key] : own && typeof own[key] === 'string' ? own[key] : UI_WORDS[key], slots,
);

// The English of a server's answer → the same answer in the page's
// language, when it is one of these (its slots matched and kept).
const RX = new Map();
const rxOf = (t) => {
  if (!RX.has(t)) {
    const names = [];
    const src = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{([a-z]+)\\\}/gi, (m, k) => { names.push(k); return '(.+?)'; });
    RX.set(t, { re: new RegExp(`^${src}$`), names });
  }
  return RX.get(t);
};
export const translateMessage = (english, w, table = UI_WORDS) => {
  const msg = String(english ?? '');
  for (const [k, t] of Object.entries(table)) {
    if (!/^(srv|pay|err|form)\./.test(k)) continue;
    const { re, names } = rxOf(t);
    const m = re.exec(msg);
    if (m) return w(k, Object.fromEntries(names.map((n, i) => [n, m[i + 1]])));
  }
  return msg;
};
