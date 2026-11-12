// What someone can do on the website (SITE.md "Public forms"), in the words
// the screens use — the People filter "Did on the website", a ladder's
// "Did something on the website" and a follow-up's card all say it the same
// way. Mirrored for the browser in web/src/components/WebDid.js (a test
// checks the two agree).
//
// join and donate are the forms: what was paid lands as a membership and a
// gift (ext/payments), so the words say "form". Both are money: a volunteer
// never sorts people by them.
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
export const MONEY_KINDS = new Set(['join', 'donate']);

// A filter or trigger value: a kind ("petition"), one campaign
// ("campaign:<uuid>", a petition or pledge), or "any".
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const campaignOf = (v) => {
  const m = /^campaign:(.+)$/.exec(String(v || ''));
  return m && UUID.test(m[1]) ? m[1].toLowerCase() : null;
};
// "site:<uuid>": did something (not the money forms) on one of the
// campaign's other websites (server/ext/site microsites.js).
export const siteOfValue = (v) => {
  const m = /^site:(.+)$/.exec(String(v || ''));
  return m && UUID.test(m[1]) ? m[1].toLowerCase() : null;
};
export const isWebValue = (v, { any = false } = {}) => (any && v === 'any') || WEB_KINDS.includes(v) || Boolean(campaignOf(v));

// "Signed: SkyTrain to Langley" for one campaign, given its title.
export const campaignWords = (c) => `${c?.kind === 'pledge' ? 'Pledged' : 'Signed'}: ${c?.title || 'a petition'}`;

// The website's tables are the site server's (server/ext/site). Until they
// exist (a database from before the website), nobody did anything there.
export const hasTable = async (db, name) => Boolean((await db.query('select to_regclass($1) is not null as ok', [name])).rows[0]?.ok);

// The campaign's petitions and pledges, newest first: [{ id, kind, title }].
export const campaignsOf = async (db, ws) => {
  if (!(await hasTable(db, 'site_campaigns'))) return [];
  return (await db.query(
    `select id, kind, title from site_campaigns where workspace_id = $1 and deleted_at is null
     order by created_at desc limit 200`,
    [ws],
  )).rows;
};
