// The person behind a website form: found on file or added, tagged, given a
// referral code, credited to whoever sent them.
//
// Found the way the intake API finds people (ext/intake matchWebsitePerson):
// the same email; else the same name and phone; else — the site's own last
// step — the same name and postal code. Only an email match fills what the
// record is missing (phone, address, city, postal code; a name for a record
// that only had its email's first part); a match by phone, or by name and
// postal code, gets the action, the tags and the consent and nothing else,
// and an email typed there is kept beside the record (attrs.typed_email) for
// the desk. Nothing on file is ever overwritten, and the answer never says
// whether someone was on file.
//
// Money (join, donate: { strong: true }) is only ever the same email's, or
// someone new's: a name and phone, or a name and postal code, is no proof
// of who is paying — the gift, its receipt and the year's limit would land
// on a voter who never gave (and two people with one name at one address
// are common).
import { randomInt } from 'node:crypto';
import { newId } from '../../lib/events.js';
import { civic } from '../../lib/address.js';
import { splitFirst, joinName } from '@starbase/shared/names';
import { matchWebsitePerson } from '../intake/index.js';
import { parseJ } from './store.js';
import { samePostal } from '../duplicates/same.js';

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const lower = (s) => norm(s).toLowerCase();
export const tagsOf = (p) => {
  const t = parseJ(p?.tags, []);
  return Array.isArray(t) ? t.map(String) : [];
};
// A person keeps at most 50 tags of at most 40 characters (person.update's rule).
const addTags = (had, add) => {
  const out = [...had];
  for (const t of add) if (t && t.length <= 40 && !out.includes(t) && out.length < 50) out.push(t);
  return out;
};

// "v3t1v8", "V3T-1V8" → "V3T 1V8"; anything else as typed, upper-cased.
export const postalOf = (raw) => {
  const s = String(raw ?? '').toUpperCase().replace(/\s+/g, '');
  const code = s.replace(/-/g, '');
  return /^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : s;
};

// The same postal code as ext/duplicates reads it (same.js): letters and
// digits only, so one typed with a hyphen on file still matches.
const byNameAndPostal = async (tx, ws, name, postal) => {
  const p = String(postal || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
  if (!name || p.length < 3) return null;
  return (await tx.query(
    `select id, name, email, phone, address, house_number, unit, city, postal, lat, tags, attrs from persons
      where workspace_id = $1 and deleted_at is null and lower(name) = lower($2)
        and ${samePostal('postal')} = $3
      order by created_at limit 1`,
    [ws, name, p],
  )).rows[0] || null;
};

// who: { first_name, last_name, email, phone, postal, address, city }
// strong: only the same email matches (money); else someone new
// → { id, name, created, by: 'email' | 'phone' | 'postal' | null }
export const takePerson = async (tx, ws, who, { tags = [], source = 'website', strong = false }, emit) => {
  const email = lower(who.email);
  const phone = norm(who.phone);
  const cut = splitFirst(norm(who.first_name));
  const first = cut ? cut.first : norm(who.first_name);
  const middle = cut ? cut.middle : '';
  const last = norm(who.last_name);
  const typedName = joinName(first, middle, last);
  const postal = postalOf(who.postal);
  const addr = norm(who.address) ? civic({ address: norm(who.address) }) : null;
  const city = norm(who.city);

  let found = email ? await matchWebsitePerson(tx, ws, { email }) : null;
  if (!found && !strong && phone && typedName) found = await matchWebsitePerson(tx, ws, { phone, name: typedName });
  if (!found && !strong && typedName && postal) {
    const r = await byNameAndPostal(tx, ws, typedName, postal);
    if (r) found = { person: r, by: 'postal' };
  }

  if (found) {
    const p = found.person;
    const patch = {};
    const attrs = parseJ(p.attrs, {}) || {};
    let attrsChanged = false;
    if (found.by === 'email') {
      if (!p.phone && phone) patch.phone = phone;
      if (!p.address && addr?.address) Object.assign(patch, { address: addr.address, house_number: addr.house_number || null });
      if (!p.city && city) patch.city = city;
      if (!p.postal && postal) patch.postal = postal;
      // A record that only had its email's first part as a name takes the
      // name they give now.
      if (attrs.name_from_email && typedName) {
        Object.assign(patch, { first_name: first || null, middle_name: middle || null, last_name: last || null });
        delete attrs.name_from_email;
        attrsChanged = true;
      }
    } else if (email && lower(p.email) !== email && attrs.typed_email !== email) {
      attrs.typed_email = email;
      attrsChanged = true;
    }
    const had = tagsOf(p);
    const next = addTags(had, tags);
    if (next.length !== had.length) patch.tags = next;
    const keys = Object.keys(patch);
    if (keys.length || attrsChanged) {
      const sets = keys.map((k, i) => (k === 'tags' ? `tags = $${i + 3}::jsonb` : `${k} = $${i + 3}`));
      if (attrsChanged) sets.push(`attrs = $${keys.length + 3}::jsonb`);
      await tx.query(
        `update persons set ${sets.join(', ')}, updated_at = now() where id = $1 and workspace_id = $2`,
        [p.id, ws, ...keys.map((k) => (k === 'tags' ? JSON.stringify(patch[k]) : patch[k])), ...(attrsChanged ? [JSON.stringify(attrs)] : [])],
      );
      const named = (await tx.query('select name, first_name, middle_name, last_name from persons where id = $1', [p.id])).rows[0];
      emit('person', p.id, 'update', {
        ...patch, ...(patch.first_name !== undefined ? named : {}),
        ...(attrsChanged && attrs.typed_email ? { typed_email: attrs.typed_email } : {}), source,
      });
      return { id: p.id, name: named.name, created: false, by: found.by };
    }
    return { id: p.id, name: p.name, created: false, by: found.by };
  }

  // Someone new. No name given: the first part of their email (taken over
  // by the name they give next time), else their phone number.
  const id = newId();
  const fromEmail = !typedName && email ? email.split('@')[0] : '';
  const name = typedName || fromEmail || phone || 'Website supporter';
  const attrs = { ref_code: await freshCode(tx, ws), ...(fromEmail ? { name_from_email: true } : {}) };
  await tx.query(
    `insert into persons (id, workspace_id, kind, name, first_name, middle_name, last_name, email, phone, address, house_number, city, postal, tags, socials, attrs)
     values ($1, $2, 'person', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, '{}', $14)`,
    [id, ws, name, first || null, middle || null, last || null, email || null, phone || null, addr?.address || null,
     addr?.house_number || null, city || null, postal || null, JSON.stringify(addTags([], tags)), JSON.stringify(attrs)],
  );
  const named = (await tx.query('select name, first_name, middle_name, last_name from persons where id = $1', [id])).rows[0];
  emit('person', id, 'create', {
    id, kind: 'person', ...named, email: email || null, phone: phone || null,
    address: addr?.address || null, house_number: addr?.house_number || null, city: city || null, postal: postal || null,
    tags: addTags([], tags), ref_code: attrs.ref_code, source,
  });
  return { id, name: named.name, created: true, by: null };
};

// ── Referral codes: one per person, for /r/:code ──
// Looked up through persons_ref_code_idx (sql.js), a partial index: a query
// uses it only when it says the index's own condition (attrs ? 'ref_code'),
// so every lookup here does — without it each one reads the whole voter file.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const CODE_RE = /^[a-z0-9]{6,16}$/;
const makeCode = () => Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
const freshCode = async (tx, ws) => {
  for (let i = 0; i < 8; i += 1) {
    const code = makeCode();
    const taken = (await tx.query("select 1 from persons where workspace_id = $1 and attrs ? 'ref_code' and attrs->>'ref_code' = $2 limit 1", [ws, code])).rows[0];
    if (!taken) return code;
  }
  throw new Error('no free referral code');
};

// The person's code, made the first time it's asked for.
export const refCodeFor = async (tx, ws, personId, emit) => {
  const p = (await tx.query("select attrs->>'ref_code' as code from persons where id = $1 and workspace_id = $2", [personId, ws])).rows[0];
  if (!p) return null;
  if (p.code) return p.code;
  const code = await freshCode(tx, ws);
  await tx.query(
    `update persons set attrs = jsonb_set(coalesce(attrs, '{}'::jsonb), '{ref_code}', to_jsonb($3::text)) where id = $1 and workspace_id = $2`,
    [personId, ws, code],
  );
  emit('person', personId, 'update', { ref_code: code, source: 'website' });
  return code;
};

// Who a code belongs to (a record merged into another: that one) → id | null.
export const personOfCode = async (q, ws, code) => {
  if (!CODE_RE.test(String(code || ''))) return null;
  const r = (await q.query(
    `select id, deleted_at, attrs->>'merged_into' as merged_into from persons
      where workspace_id = $1 and attrs ? 'ref_code' and attrs->>'ref_code' = $2 order by deleted_at nulls first, created_at limit 1`,
    [ws, code],
  )).rows[0];
  if (!r) return null;
  if (!r.deleted_at) return r.id;
  if (!r.merged_into) return null;
  const into = (await q.query('select id from persons where id = $1 and workspace_id = $2 and deleted_at is null', [r.merged_into, ws])).rows[0];
  return into?.id || null;
};

// "Brought in by": a new person who came through someone's link.
export const broughtInBy = async (tx, ws, personId, referrerId, emit) => {
  if (!referrerId || referrerId === personId) return null;
  const [a, b] = personId < referrerId ? [personId, referrerId] : [referrerId, personId];
  const live = (await tx.query(
    'select id from relationships where workspace_id = $1 and person_a = $2 and person_b = $3 and removed_at is null', [ws, a, b],
  )).rows[0];
  if (live) return live.id;
  const id = newId();
  await tx.query(
    `insert into relationships (id, workspace_id, person_a, person_b, kind, note, brought_in, from_person, created_by)
     values ($1, $2, $3, $4, 'other', 'Came through their link on the website', $5, $6, null)`,
    [id, ws, a, b, personId, referrerId],
  );
  emit('relationship', id, 'create', {
    id, person_a: a, person_b: b, kind: 'other', note: 'Came through their link on the website', brought_in: personId, from: referrerId,
  });
  return id;
};
