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

// The three lists a contact may be on, any or all of them (LTE): who gets an
// op-ed pitch, a letter's paper, a show booking. Mirrored in Media.jsx.
// Never "host" — that tag is an event host (shared/canvass.js).
export const LISTS = ['op_ed', 'letters', 'show'];
export const LIST_WORDS = { op_ed: 'Op-ed editors', letters: 'Letters editors', show: 'Show hosts' };
// A set, de-duplicated, in LISTS order.
export const listsOf = (v) => LISTS.filter((k) => (Array.isArray(v) ? v : []).includes(k));
// SQL: the media_contacts row `alias` is still on the media list (not left)
// and on any of `lists`. The words are LISTS' own, so inlined.
export const onLists = (alias, lists) => {
  const ls = listsOf(lists);
  return `(${alias}.left_at is null and ${alias}.lists ?| array[${(ls.length ? ls : LISTS).map((k) => `'${k}'`).join(',')}]::text[])`;
};
