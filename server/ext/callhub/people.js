// Who goes to the dialer from a list or a phone bank, and who never does.
//   · a number e164() takes (ext/texting/rules.js); anything else stays
//   · never someone tagged do-not-contact or do-not-call — and never a
//     number one of them is on, whoever else shares it (a household line):
//     a dialer rings the number, not the person
//   · one contact per number: everyone on the list with it is remembered,
//     and the first by name is the one sent (and the one results land on)
// Nothing here writes, and nothing here talks to CallHub.
import { httpError } from '../../actions/util.js';
import { loadList, whereFor } from '../lists/audience.js';
import { e164, NO_CONTACT_TAG, NO_CALL_TAG } from '../texting/rules.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// CallHub takes 3,600 contacts a day: a list bigger than this would be on
// its way for more than a week, and is better cut down first.
export const MAX_PEOPLE = 25_000;
const COLS = 'p.id, p.kind, p.name, p.first_name, p.last_name, p.city, p.phone, p.tags';
export const tagsOf = (row) => {
  try { return (typeof row?.tags === 'string' ? JSON.parse(row.tags) : row?.tags) || []; } catch { return []; }
};
export const notToBeCalled = (row) => { const t = tagsOf(row); return t.includes(NO_CONTACT_TAG) || t.includes(NO_CALL_TAG); };

// What is being sent: a list (everyone it names today) or a phone bank
// (its numbers still to call). → { kind, id, name, rows } in name order.
export const sourceOf = async (q, ctx, { list_id: listId = null, bank_id: bankId = null }) => {
  const ws = ctx.workspaceId;
  if (listId) {
    const list = await loadList(q, ws, listId);
    if (!list) throw httpError(404, 'list not found');
    const { where, params } = await whereFor(q, ctx, { list });
    const n = (await q.query(`select count(*)::int as n from persons p where ${where}`, params)).rows[0].n;
    if (n > MAX_PEOPLE) {
      throw httpError(409, `This list names ${n.toLocaleString('en-CA')} people. CallHub takes 3,600 a day — send a list of ${MAX_PEOPLE.toLocaleString('en-CA')} or fewer`);
    }
    const { rows } = await q.query(`select ${COLS} from persons p where ${where} order by lower(p.name), p.id`, params);
    return { kind: 'list', id: list.id, name: list.name, rows };
  }
  if (!UUID.test(String(bankId || ''))) throw httpError(404, 'phone bank not found');
  const bank = (await q.query('select id, name, closed_at from call_banks where id = $1 and workspace_id = $2 and deleted_at is null', [bankId, ws])).rows[0];
  if (!bank) throw httpError(404, 'phone bank not found');
  if (bank.closed_at) throw httpError(409, 'This phone bank is closed — reopen it to send it');
  const { rows } = await q.query(
    `select ${COLS} from call_bank_numbers n join persons p on p.id = n.person_id
      where n.bank_id = $1 and n.workspace_id = $2 and n.done_at is null and p.deleted_at is null
      order by lower(p.name), p.id`, [bank.id, ws],
  );
  return { kind: 'bank', id: bank.id, name: bank.name, rows };
};

// The campaign's own do-not-call list, as numbers → what each must not get,
// in CallHub's own categories (1 calls, 2 texts, 3 both): do-not-contact is
// both, do-not-call is calls, a number that replied STOP to a text is texts.
export const notToCall = async (q, ws) => {
  const out = new Map();
  const add = (raw, category) => { const n = e164(raw); if (n) out.set(n, (out.get(n) || 0) | category); };
  const tagged = (await q.query(
    `select phone, tags from persons where workspace_id = $1 and deleted_at is null and coalesce(phone, '') <> ''
        and (tags @> $2::jsonb or tags @> $3::jsonb)`,
    [ws, JSON.stringify([NO_CONTACT_TAG]), JSON.stringify([NO_CALL_TAG])],
  )).rows;
  for (const r of tagged) add(r.phone, tagsOf(r).includes(NO_CONTACT_TAG) ? 3 : 1);
  const stopped = (await q.query('select phone from texting_optouts where workspace_id = $1 and opted_out', [ws])).rows;
  for (const r of stopped) add(r.phone, 2);
  return out;
};
export const noCalls = (blocked, phone) => Boolean((blocked.get(phone) || 0) & 1);

// rows (in name order) → the numbers to send, each with its people (the
// first is the one sent), how many people that is, and how many were left out.
export const audienceOf = (rows, blocked) => {
  const byNumber = new Map();
  let people = 0;
  let leftOut = 0;
  for (const r of rows) {
    const phone = e164(r.phone);
    if (!phone || notToBeCalled(r) || noCalls(blocked, phone)) { leftOut += 1; continue; }
    people += 1;
    if (!byNumber.has(phone)) byNumber.set(phone, []);
    byNumber.get(phone).push(r);
  }
  return { numbers: [...byNumber].map(([phone, who]) => ({ phone, people: who })), people, leftOut };
};

// What leaves base.win for one number: the phone, a first and last name and
// the city — never a rating, a tag, a note, an email or a street. An empty
// field is left out, so it never blanks what CallHub has.
export const contactBody = (phone, p) => {
  const first = String(p.first_name || (p.last_name ? '' : p.name) || '').trim();
  const last = String(p.last_name || '').trim();
  const city = String(p.city || '').trim();
  return {
    contact: phone,
    ...(first ? { first_name: first.slice(0, 100) } : {}),
    ...(last ? { last_name: last.slice(0, 100) } : {}),
    ...(city ? { city: city.slice(0, 100) } : {}),
    // CallHub adds a country prefix from this; +1 numbers are Canada's here.
    ...(phone.startsWith('+1') ? { country_code: 'CA' } : {}),
  };
};
