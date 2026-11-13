// What the command bar (CommandBar.jsx) offers, and how it ranks it — pure
// (no React, no browser), so the server's tests check it too
// (server/test/commandbar.test.js).
//
//   commandsFor(me, nav) → { actions, screens } this person may open
//   rank(items, query)   → the items matching every word typed, best first

// The same rule as Shell's hasArea: the areas the server gave, else a desk
// role's usual ones; managers have every area. A screen a role may not open
// (App.jsx's guards) isn't offered — and the server refuses its data anyway.
const isDesk = (me) => Boolean(me?.role) && me.role !== 'volunteer';
const areasOf = (me) => (Array.isArray(me?.areas) ? me.areas : (isDesk(me) ? ['people', 'map', 'shifts', 'money', 'signs', 'outreach', 'data'] : []));
export const allowed = (me, item) => {
  if (item.manager && me?.role !== 'manager') return false;
  if (item.roles && !item.roles.includes(me?.role)) return false;
  if (item.desk && !isDesk(me)) return false;
  // Google sign-in on here and this person hasn't linked theirs (/auth/me).
  if (item.google && !(me?.google?.on && !me.google.linked)) return false;
  return !item.area || me?.role === 'manager' || areasOf(me).includes(item.area);
};

// Jobs, in the words of the buttons they press.
export const ACTIONS = [
  { label: 'Add person', to: '/people?new=1', area: 'people', desk: true, words: 'new person contact supporter voter' },
  { label: 'Log a gift', to: '/money?new=1', area: 'money', words: 'donation donate money cheque' },
  { label: 'Enter a membership form', to: '/people/membership-form', area: 'money', desk: true, words: 'member paper join' },
  { label: 'Draw a turf', to: '/map?draw=1', area: 'map', desk: true, words: 'cut turf walk list map area polygon' },
  { label: 'New shift', to: '/shifts?add=1', area: 'shifts', desk: true, words: 'schedule event canvass shift' },
  { label: 'Write an email', to: '/outreach/email?new=1', area: 'outreach', desk: true, words: 'email newsletter blast send' },
  { label: 'Write a text', to: '/outreach/texting?new=1', area: 'outreach', desk: true, words: 'text sms blast message' },
  { label: 'Link Google account', to: '/profile', google: true, words: 'google sign in link' },
];

// Screens past the tab bar (the tabs themselves come from the Shell's nav,
// so a new tab — the Website — is offered by itself).
export const SCREENS = [
  { label: 'Calls', to: '/calls', words: 'phone call list dial' },
  { label: 'Turfs and walk lists', to: '/turfs', words: 'walk list turf canvass doors' },
  { label: 'Text inbox', to: '/inbox', words: 'texts replies messages sms' },
  { label: 'Phone banks', to: '/banks', desk: true, words: 'call lists phone bank' },
  { label: 'My people', to: '/my-people', words: 'relational friends know' },
  { label: 'Volunteers', to: '/shifts/volunteers', desk: true, words: 'roster volunteer roles' },
  { label: 'Import people', to: '/people/import', area: 'people', desk: true, words: 'upload csv spreadsheet excel voter file list' },
  { label: 'Import & export', to: '/data', area: 'data', words: 'download backup spreadsheet export data' },
  { label: 'Lists', to: '/lists', area: 'people', words: 'saved list audience filter' },
  { label: 'Reports', to: '/reports', area: 'data', words: 'numbers csv report' },
  { label: 'Field, by turf', to: '/field-report', area: 'data', words: 'field report coverage turf canvassers' },
  { label: 'Duplicates', to: '/people/duplicates', desk: true, words: 'merge same person double' },
  { label: 'Most connected', to: '/people/connected', area: 'people', words: 'relationships connectors who knows' },
  { label: 'Requests from the doors', to: '/requests', area: 'people', words: 'needs you ask the office requests' },
  { label: 'Get out the vote', to: '/voted', area: 'people', words: 'gotv voted election day voting' },
  { label: 'Passes', to: '/passes', area: 'map', words: 'sweep pass universe' },
  { label: 'Receipts', to: '/money/receipts', area: 'money', words: 'tax receipt donation' },
  // Never the word "gift" here: typed, the bar lists screens before jobs, and "gift" + Enter must stay Log a gift.
  // The financial agent's people bring a file in (Donations → More offers it to them alone).
  { label: 'Import donations', to: '/money/import', area: 'money', roles: ['manager', 'treasurer'], words: 'file csv spreadsheet excel another tool upload' },
  { label: 'Stewardship', to: '/money/stewardship', area: 'money', words: 'thank donors lapsed top donors' },
  { label: 'Ladders', to: '/ladders', area: 'outreach', words: 'automatic emails automation engagement' },
  // Never "email" or "newsletter" here: typed, the bar lists screens before jobs, and "newsletter" + Enter must stay Write an email.
  { label: 'Templates', to: '/outreach/templates', area: 'outreach', desk: true, words: 'template starter saved' },
  { label: 'Follow-ups', to: '/follow-ups', area: 'outreach', words: 'follow up ladder' },
  { label: 'Surveys', to: '/surveys', area: 'outreach', words: 'questions survey' },
  { label: 'Scripts', to: '/scripts', area: 'outreach', words: 'door phone what to say script' },
  { label: 'Texting settings', to: '/inbox/settings', area: 'outreach', words: 'quiet hours texting number' },
  { label: 'Members', to: '/settings', hint: 'Settings', area: 'admin', manager: true, words: 'settings invite team roles remove two-step' },
  { label: 'Teams', to: '/settings/teams', hint: 'Settings', area: 'admin', manager: true, words: 'settings crews groups' },
  { label: 'Permissions', to: '/settings/permissions', hint: 'Settings', area: 'admin', manager: true, words: 'settings areas access' },
  { label: 'Services', to: '/settings/services', hint: 'Settings', area: 'admin', manager: true, words: 'settings email texting keys integrations google' },
  { label: 'Campaign name', to: '/settings/campaign', hint: 'Settings', area: 'admin', manager: true, words: 'settings rename' },
  { label: 'Brand', to: '/settings/brand', hint: 'Settings', area: 'admin', manager: true, words: 'settings logo colour color look theme icon' },
  { label: 'Profile fields', to: '/people/fields', area: 'admin', manager: true, words: 'custom fields profile' },
  { label: 'Rating scale', to: '/rating-scale', area: 'admin', manager: true, words: 'support scale voting for candidates' },
  { label: 'Your profile', to: '/profile', words: 'account two-step sign-in authenticator me' },
];

// What this person may open and do. nav: the tabs the Shell shows them
// (already their areas), first among the screens.
export function commandsFor(me, nav = []) {
  const tabs = nav.map((n) => ({ label: n.label, to: n.to, words: n.words || '' }));
  const seen = new Set(tabs.map((t) => t.to));
  const screens = [...tabs, ...SCREENS.filter((s) => allowed(me, s) && !seen.has(s.to))]
    .map((s) => ({ ...s, kind: 'screen', key: `screen:${s.to}` }));
  const actions = ACTIONS.filter((a) => allowed(me, a)).map((a) => ({ ...a, kind: 'action', key: `action:${a.to}` }));
  return { actions, screens };
}

// Lower case, no accents, single spaces: "Café  Éxample" → "cafe example".
export const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// Every word typed must be found; the label counts most, its start most of all.
export const scoreItem = (item, query) => {
  const q = fold(query);
  if (!q) return 1;
  const label = fold(item.label);
  const rest = fold(`${item.hint || ''} ${item.words || ''}`);
  let score = 0;
  for (const w of q.split(' ')) {
    const at = label.indexOf(w);
    if (label.startsWith(w)) score += 100;
    else if (at > 0 && label[at - 1] === ' ') score += 80;
    else if (at >= 0) score += 50;
    else if (rest.split(' ').some((r) => r.startsWith(w))) score += 30;
    else if (rest.includes(w)) score += 10;
    else return 0;
  }
  if (label === q) score += 50;
  return score;
};

export const rank = (items, query) => items
  .map((it, i) => ({ it, i, s: scoreItem(it, query) }))
  .filter((x) => x.s > 0)
  .sort((a, b) => b.s - a.s || a.i - b.i)
  .map((x) => x.it);
