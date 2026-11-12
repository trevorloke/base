// Whose gift is it? A row of a gift file names its donor in words; this
// finds the record on file — or says there is no sure one, and the gift
// waits for a person (never a guess).
//
//   1. The same email. One record has it: that person. Several share it (a
//      couple with one address): the one with the row's first and last
//      name, if exactly one.
//   2. Else the same first and last name with the same phone, whole postal
//      code or street address — compared as ext/duplicates compares records
//      and as the limit adds up what may be one donor (ext/payments
//      limits.js likelySameDonors). Exactly one: that person.
//   No record, or more than one it could be: it waits. So does a row whose
//   email is on a record under another name while a record with the row's
//   own name and phone, postal code or street exists — two people it could
//   be.
//
// Read a chunk at a time through the persons indexes (email; last and first
// name), so a city's voter file costs each row only its own lookups.
import { sameText, samePhone, samePostal, sharedWords } from '../duplicates/same.js';

// A row's first and last name: as its columns give them, else the whole
// name split the way the database splits one (ext/names).
const FIRST = `case when coalesce(trim(t.first), '') <> '' or coalesce(trim(t.last), '') <> '' then t.first else (persons_split_name(t.name))[1] end`;
const LAST = `case when coalesce(trim(t.first), '') <> '' or coalesce(trim(t.last), '') <> '' then t.last else (persons_split_name(t.name))[3] end`;
const MOST = 6; // enough to say "one", "several", and show who

const byEmail = async (q, wsId, rows) => {
  const with_ = rows.filter((r) => r.donor.email);
  if (!with_.length) return [];
  return (await q.query(
    `select k.i, p.id, p.name, p.email, p.phone, p.address, p.postal,
            (k.fn <> '' and k.ln <> '' and ${sameText('p.first_name')} = k.fn and ${sameText('p.last_name')} = k.ln) as same_name
       from (select t.i, t.email, ${sameText(FIRST)} as fn, ${sameText(LAST)} as ln
               from unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::text[]) as t(i, email, first, last, name)) k
       cross join lateral (
         select id, name, email, phone, address, postal, first_name, last_name from persons
          where workspace_id = $1 and deleted_at is null and lower(email) = k.email
          order by created_at, id limit ${MOST} offset 0) p`,
    [wsId, with_.map((r) => r.i), with_.map((r) => r.donor.email), with_.map((r) => r.donor.first), with_.map((r) => r.donor.last), with_.map((r) => r.donor.name)],
  )).rows;
};

const byName = async (q, wsId, rows) => {
  const with_ = rows.filter((r) => r.donor.name && (r.donor.phone || r.donor.postal || r.donor.address));
  if (!with_.length) return [];
  const shares = `(length(k.ph) >= 7 and ${samePhone('p.phone')} = k.ph) as by_phone,
                  (k.ad <> '' and ${sameText('p.address')} = k.ad) as by_address,
                  (length(k.pc) >= 6 and ${samePostal('p.postal')} = k.pc) as by_postal`;
  return (await q.query(
    `select k.i, p.* from (
       select t.i, ${sameText(FIRST)} as fn, ${sameText(LAST)} as ln,
              ${samePhone('t.phone')} as ph, ${samePostal('t.postal')} as pc, ${sameText('t.address')} as ad
         from unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])
              as t(i, first, last, name, phone, postal, address)) k
       cross join lateral (
         select * from (
           select p.id, p.name, p.email, p.phone, p.address, p.postal, p.created_at, ${shares}
             from persons p
            where p.workspace_id = $1 and p.deleted_at is null and p.kind = 'person'
              and ${sameText('p.last_name')} = k.ln and ${sameText('p.first_name')} = k.fn) x
          where x.by_phone or x.by_address or x.by_postal
          order by x.created_at, x.id limit ${MOST} offset 0) p
      where k.fn <> '' and k.ln <> ''`,
    [wsId, with_.map((r) => r.i), with_.map((r) => r.donor.first), with_.map((r) => r.donor.last), with_.map((r) => r.donor.name),
     with_.map((r) => r.donor.phone), with_.map((r) => r.donor.postal), with_.map((r) => r.donor.address)],
  )).rows;
};

const shown = (p, why) => ({ id: p.id, name: p.name, email: p.email || null, phone: p.phone || null, address: p.address || null, postal: p.postal || null, why });

// rows: [{ i, donor: { name, first, last, email, phone, address, postal } }]
// → Map: i → { person: { id, name } | null, by, name_differs, candidates }
//   person       the one sure record, or null (the gift waits)
//   by           what made it sure: 'email', or what it shares ('phone',
//                'address and postal code')
//   candidates   when it waits: the records it could be, each with why
export const findDonors = async (q, wsId, rows) => {
  const emails = new Map(); const names = new Map();
  for (const p of await byEmail(q, wsId, rows)) emails.set(p.i, [...(emails.get(p.i) || []), p]);
  for (const p of await byName(q, wsId, rows)) names.set(p.i, [...(names.get(p.i) || []), p]);
  const out = new Map();
  for (const r of rows) {
    const E = emails.get(r.i) || [];
    const N = names.get(r.i) || [];
    const named = E.filter((p) => p.same_name);
    const pick = E.length === 1 ? E[0] : named.length === 1 ? named[0] : null;
    const both = () => {
      const seen = new Set();
      return [...E.map((p) => shown(p, 'same email')), ...N.map((p) => shown(p, `same name and ${sharedWords(p)}`))]
        .filter((p) => !seen.has(p.id) && seen.add(p.id));
    };
    if (pick && (pick.same_name || !N.some((p) => p.id !== pick.id))) {
      out.set(r.i, { person: { id: pick.id, name: pick.name }, by: 'email', name_differs: !pick.same_name, candidates: [] });
    } else if (!E.length && N.length === 1) {
      out.set(r.i, { person: { id: N[0].id, name: N[0].name }, by: sharedWords(N[0]), name_differs: false, candidates: [] });
    } else {
      out.set(r.i, { person: null, by: null, name_differs: false, candidates: both() });
    }
  }
  return out;
};
