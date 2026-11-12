// The words a visitor ticks on the website — the consent boxes and the join
// and donate declarations — in one place: the renderer draws exactly these
// (shared/site/components), and the server keeps exactly these: with each
// consent (ext/site), and with each checkout and the gift it becomes
// (ext/payments). What a person saw is what the record says.

// Whose name the consent words carry: the organization's short name, else
// its name, else the site's title — the name the site itself shows.
export const consentName = (org, seo) => String(
  org?.shortName || org?.short_name || org?.name || seo?.title || '',
).replace(/\s+/g, ' ').trim() || 'the campaign';

// email and sms: the words beside those boxes; newsletter: the words beside
// the newsletter's button (sending that form is the yes to email).
export const consentWords = (name) => ({
  email: `Yes, ${name} can email me news and ways to help. I can unsubscribe at any time.`,
  sms: `Yes, ${name} can text me about events and volunteering. Reply STOP at any time. Message and data rates may apply.`,
  newsletter: `By signing up you agree to get email from ${name}. Unsubscribe at any time.`,
});

// The declarations (BC's Local Elections Campaign Financing Act): a
// contribution comes from a Canadian citizen or permanent resident who lives
// in BC, out of their own money — no one pays them back. Membership dues
// count as a contribution, so joining declares it too.
export const DONATE_DECLARATION = 'I’m a Canadian citizen or permanent resident. I live in British Columbia. This contribution is my own money, and no one will pay me back for it.';
export const JOIN_DECLARATION = 'I declare that what I’ve written here is true and that I’m eligible to be a member: I’m a Canadian citizen or permanent resident, I live in British Columbia, and my dues are my own money — no one will pay me back for them.';

// "Authorized by …": the line B.C. election rules ask for on advertising,
// on every page of every website (the footer, and the plain pages: coming
// soon, closed). The financial agent and a way to reach them; before they
// were asked for, the line as typed (authorizationLine). One place, so new
// wording from Elections BC is one edit.
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
export const authorizedBy = (org) => {
  const name = clean(org?.agentName ?? org?.agent_name);
  const contact = clean(org?.agentContact ?? org?.agent_contact);
  if (name) return `Authorized by ${name}${contact ? `, ${contact}` : ''}`;
  return clean(org?.authorizationLine ?? org?.authorization ?? org?.authorized_by);
};

// Under every form, before its "Privacy policy" link: who keeps what a
// visitor sends, and why.
export const PRIVACY_LINE = (name) => `${clean(name) || 'The campaign'} keeps what you send to stay in touch about our work and elections.`;
