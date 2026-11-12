// What someone can do on the website, in the words every screen uses —
// the People filter "Did on the website", a ladder's "Did something on the
// website", a follow-up's card. The server says the same
// (server/ext/webdid/words.js; a test checks the two agree). Plain JS, no
// imports, so the server's tests can read it.
//   web=<kind> · web=campaign:<id> (one petition or pledge) · web=any
export const WEB_KINDS = ['newsletter', 'petition', 'pledge', 'volunteer', 'rsvp', 'contact', 'join', 'donate'];
export const WEB_WORDS = {
  newsletter: 'Signed up for the newsletter',
  petition: 'Signed a petition',
  pledge: 'Took a pledge',
  volunteer: 'Offered to volunteer',
  rsvp: 'RSVP’d to an event',
  contact: 'Sent a message',
  join: 'Filled in the membership form',
  donate: 'Filled in the donation form',
};
export const MONEY_KINDS = ['join', 'donate'];

// A filter value in words: a kind, one campaign (by the picker's labels:
// [{ id, label }]), or "Anything".
export const webLabel = (v, { campaigns = [], sites = [] } = {}) => {
  if (!v) return '';
  if (v === 'any') return 'Anything';
  const m = /^campaign:(.+)$/.exec(v);
  if (m) return campaigns.find((c) => String(c.id) === m[1])?.label || 'A petition or pledge';
  // One of the campaign's other websites, by its name — never its id.
  const s = /^site:(.+)$/.exec(v);
  if (s) return sites.find((x) => String(x.id) === s[1])?.label || 'Another of the campaign’s websites';
  return WEB_WORDS[v] || v;
};
