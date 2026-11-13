// A contacts file (Google Contacts' "Google CSV" export, an Outlook-style
// CSV, an iPhone export saved as CSV) read for "Find people I know": only a
// name, one email and one phone per contact. Every other column (Labels,
// group membership, notes, birthdays, addresses, photos) is never read, so
// it never leaves the browser. Used by the browser and the server's tests.
//
//   readContacts({ headers, records })   records: [{ cells }] or [cells]
//     → { rows: [{ ref, name, email, phone }], unusable, total } | { error }
//     A contact with no name, or with neither an email nor a phone, can't be
//     matched: counted, not sent.
//   looksLikeContacts(headers)   Data → Import's hint
//
// Google's exact column names could not be checked from here: these are its
// layouts as remembered (E-mail 1 - Value, Phone 1 - Value, Given Name …) and
// Outlook's (E-mail Address, Mobile Phone …).
export const MAX_CONTACTS = 10_000;
export const normHeader = (h) => String(h || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// Google joins several values in one cell with " ::: ": the first counts.
const firstValue = (v) => String(v ?? '').split(' ::: ')[0].trim();
const fmt = (n) => Number(n).toLocaleString('en-CA');

const columns = (headers) => {
  const norm = headers.map(normHeader);
  const at = (...names) => names.map((n) => norm.indexOf(n)).filter((i) => i >= 0);
  const numbered = (re) => norm.map((h, i) => [h, i]).filter(([h]) => re.test(h))
    .sort((a, b) => Number(a[0].match(re)[1]) - Number(b[0].match(re)[1])).map(([, i]) => i);
  const phoneRank = (h) => (h.includes('mobile') ? 0 : h.includes('primary') ? 1 : h.includes('home') ? 2 : h.includes('business') ? 3 : 4);
  const anyPhone = norm.map((h, i) => [h, i]).filter(([h]) => h.endsWith('phone') || /phone\d$/.test(h))
    .sort((a, b) => phoneRank(a[0]) - phoneRank(b[0]) || a[1] - b[1]).map(([, i]) => i);
  return {
    name: at('name'),
    first: at('firstname', 'givenname'),
    middle: at('middlename', 'additionalname'),
    last: at('lastname', 'familyname'),
    nick: at('nickname'),
    org: at('organizationname', 'organization1name', 'company'),
    email: [...numbered(/^email(\d+)value$/), ...at('emailaddress', 'email', 'email2address', 'email3address')],
    phone: [...numbered(/^phone(\d+)value$/), ...anyPhone],
  };
};

export const readContacts = ({ headers = [], records = [] } = {}) => {
  if (records.length > MAX_CONTACTS) {
    return { error: `That file has ${fmt(records.length)} contacts. Export one label at a time (${fmt(MAX_CONTACTS)} at most).` };
  }
  const c = columns(headers);
  const rows = [];
  let unusable = 0;
  records.forEach((rec, ref) => {
    const cells = Array.isArray(rec) ? rec : (rec?.cells || []);
    const get = (i) => firstValue(cells[i]);
    const pick = (list) => { for (const i of list) { const v = get(i); if (v) return v; } return ''; };
    const joined = [pick(c.first), pick(c.middle), pick(c.last)].filter(Boolean).join(' ');
    const name = (pick(c.name) || joined || pick(c.nick) || pick(c.org)).replace(/\s+/g, ' ').slice(0, 300);
    const email = pick(c.email).toLowerCase().slice(0, 320);
    const phone = pick(c.phone).slice(0, 40);
    if (!name || (!email && !phone)) { unusable += 1; return; }
    rows.push({ ref, name, ...(email ? { email } : {}), ...(phone ? { phone } : {}) });
  });
  return { rows, unusable, total: records.length };
};

export const looksLikeContacts = (headers = []) => {
  const n = new Set(headers.map(normHeader));
  const outlookPhone = [...n].some((h) => h.endsWith('phone'));
  return (n.has('labels') && n.has('email1value'))
    || (n.has('groupmembership') && n.has('email1value'))
    || (n.has('firstname') && n.has('email1value'))
    || (n.has('emailaddress') && outlookPhone && n.has('firstname'));
};
