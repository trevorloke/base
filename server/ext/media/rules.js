// Who is on the media list: a person tagged media or influencer, whatever
// the capitals ("Media" typed at the desk counts), as lib/reach.js reads a
// do-not tag. A person tagged both is media. One helper, used by every read
// and by the press audience (actions/field.js blast.send).
export const KINDS = ['media', 'influencer'];
export const DESK_ROLES = ['manager', 'treasurer', 'staff'];
export const isDesk = (ctx) => DESK_ROLES.includes(ctx?.role);

const tagged = (alias, kind) => `lower(${alias}.tags::text) like '%"${kind}"%'`;
// SQL: the persons row `alias` is on the list for any of `kinds`.
export const onMedia = (alias = 'p', kinds = KINDS) => {
  const ks = kinds.filter((k) => KINDS.includes(k));
  return `(${(ks.length ? ks : ['media']).map((k) => tagged(alias, k)).join(' or ')})`;
};
// The same, for one person's tags as they are now (a send's re-check).
export const onMediaTags = (tags, kinds = KINDS) => {
  const low = (Array.isArray(tags) ? tags : []).map((t) => String(t).trim().toLowerCase());
  return kinds.some((k) => low.includes(k));
};
// Their kind: media wins when both.
export const kindOf = (tags) => (onMediaTags(tags, ['media']) ? 'media' : 'influencer');
// Their tags with both media tags taken off, whatever the capitals.
export const offMedia = (tags) => (Array.isArray(tags) ? tags : []).filter((t) => !KINDS.includes(String(t).trim().toLowerCase()));
