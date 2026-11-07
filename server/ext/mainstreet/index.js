// Mainstreeting — meeting people where they are: an event, a bus loop, a
// market, the street. Its own channel on a contact ('mainstreet'), with the
// place (contacts.place), so the campaign counts it apart from doors and
// calls and knows where people were met.
//
//   mainstreet.meet   anyone on the field team (the People area): one person
//       met, in one go — { place, first_name, last_name, phone?, email?,
//       postal?, rating?, note?, volunteer?, newsletter?, client_id,
//       client_at? }. Someone already on file is found the way My people
//       finds them (lib: relationships/match.js — a volunteer is never
//       matched on an email the campaign holds); otherwise a new person,
//       tagged 'mainstreeting'. Then a contact (channel mainstreet, talked,
//       their rating), a "Wants to volunteer" request for the desk, and the
//       newsletter for a new email (never back on it for someone who left
//       it or said not to email them). client_id: the phone's outbox key —
//       a save replayed after the signal comes back is the same meeting.
//       → { person_id, contact_id, name }
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { newId } from '../../lib/events.js';
import { FIELD_ACTIONS } from '../../actions/field.js';
import { RATING_CODE_RE } from '@starbase/shared/scale';
import { findKnown, maybeSame, emailKey } from '../relationships/match.js';
import { actions as requestActions } from '../requests/actions.js';

export const sql = `
alter table contacts add column if not exists place text;
do $$
begin
  if exists (select 1 from pg_constraint where conrelid = 'contacts'::regclass and conname = 'contacts_channel_check'
             and pg_get_constraintdef(oid) not like '%mainstreet%') then
    alter table contacts drop constraint contacts_channel_check;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'contacts'::regclass and conname = 'contacts_channel_check') then
    alter table contacts add constraint contacts_channel_check check (channel in ('door', 'phone', 'text', 'in_person', 'mainstreet'));
  end if;
end $$;
create index if not exists contacts_place_idx on contacts (workspace_id, place) where place is not null;
`;

const ALL = ['manager', 'treasurer', 'staff', 'volunteer'];
const clean = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const opt = (n) => z.string().max(n).nullish();

export const actions = {
  'mainstreet.meet': {
    roles: ALL,
    input: z.object({
      client_id: z.uuid(),
      client_at: z.string().max(40).nullish(),
      place: z.string().trim().min(1, 'where you met them').max(120),
      first_name: opt(150),
      last_name: opt(150),
      phone: opt(40),
      email: z.string().trim().max(320).email().or(z.literal('')).nullish(),
      postal: opt(20),
      rating: z.string().regex(RATING_CODE_RE, 'not a rating on the scale').nullish(),
      note: opt(2000),
      volunteer: z.boolean().optional(),
      newsletter: z.boolean().optional(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      // The same save again (the phone's outbox, after a lost answer).
      const dup = (await tx.query(
        'select c.id, c.person_id, p.name from contacts c join persons p on p.id = c.person_id where c.workspace_id = $1 and c.client_id = $2',
        [ws, input.client_id],
      )).rows[0];
      if (dup) return { person_id: dup.person_id, contact_id: dup.id, name: dup.name, duplicate: true };

      const first = clean(input.first_name);
      const last = clean(input.last_name);
      const name = [first, last].filter(Boolean).join(' ');
      if (!name) throw httpError(400, 'a first or last name');
      const phone = clean(input.phone) || null;
      const email = emailKey(input.email) || null;
      const postal = clean(input.postal).toUpperCase() || null;
      const place = clean(input.place);

      let person = await findKnown(tx, ctx, { name, phone, email });
      if (person) {
        // On file: fill what's blank (never overwrite), and say where they were met.
        const tags = [...new Set([...(typeof person.tags === 'string' ? JSON.parse(person.tags) : person.tags || []), 'mainstreeting'])];
        const row = (await tx.query('select phone, postal, email, attrs from persons where id = $1', [person.id])).rows[0];
        const patch = {};
        if (!row.phone && phone) patch.phone = phone;
        if (!row.postal && postal) patch.postal = postal;
        // The email they gave: theirs if the record has none and no one else
        // on file holds it; otherwise kept beside the record for the desk.
        const attrs = typeof row.attrs === 'string' ? JSON.parse(row.attrs) : row.attrs || {};
        if (email && emailKey(row.email) !== email) {
          const held = (await tx.query(
            'select 1 from persons where workspace_id = $1 and lower(email) = $2 and id <> $3 and deleted_at is null limit 1',
            [ws, email, person.id],
          )).rows[0];
          if (!row.email && !held) patch.email = email;
          else { attrs.typed_email = email; patch.typed_email = email; }
        }
        await tx.query(
          `update persons set phone = coalesce(phone, $3), postal = coalesce(postal, $4), email = coalesce(email, $6), attrs = $7,
                  tags = $5, updated_at = now() where id = $1 and workspace_id = $2`,
          [person.id, ws, patch.phone || null, patch.postal || null, JSON.stringify(tags), patch.email || null, JSON.stringify(attrs)],
        );
        emit('person', person.id, 'update', { ...patch, tags, source: 'mainstreeting' });
      } else {
        const id = newId();
        // An email someone on file already holds isn't taken; the desk is
        // told "May be the same person as …" (as for My people).
        const same = await maybeSame(tx, ctx, { name, email }, id);
        const attrs = {};
        if (same) attrs.maybe_same_as = same.id;
        const keepEmail = email && !(same && same.email);
        if (email && !keepEmail) attrs.typed_email = email;
        await tx.query(
          `insert into persons (id, workspace_id, kind, name, first_name, last_name, email, phone, postal, tags, socials, attrs)
           values ($1, $2, 'person', $3, $4, $5, $6, $7, $8, $9, '{}', $10)`,
          [id, ws, name, first || null, last || null, keepEmail ? email : null, phone, postal, JSON.stringify(['mainstreeting']), JSON.stringify(attrs)],
        );
        emit('person', id, 'create', { id, kind: 'person', name, first_name: first || null, last_name: last || null, email: keepEmail ? email : null, phone, postal, tags: ['mainstreeting'], source: 'mainstreeting', place });
        person = { id, name };
      }

      // The meeting itself: a talk, their rating, the note — a contact like a
      // knock (contact.log: the rating scale, ladders, surveys all see it).
      const logged = await FIELD_ACTIONS['contact.log'].handler(tx, ctx, {
        person_id: person.id, channel: 'mainstreet', outcome: 'contacted',
        rating: input.rating || null, note: clean(input.note) || null,
        client_id: input.client_id, client_at: input.client_at || null,
      }, emit);
      const contactId = logged.contact?.id;
      if (contactId) await tx.query('update contacts set place = $2 where id = $1', [contactId, place]);

      if (input.volunteer) {
        await requestActions['request.ask'].handler(tx, ctx, {
          person_id: person.id, kind: 'volunteer', note: `Met mainstreeting at ${place}`.slice(0, 500),
        }, emit);
      }
      // The newsletter: the address they gave, and a new one only — never
      // back on for someone who left it, or is do-not-email (the website's
      // rule, ext/intake).
      const mail = (await tx.query('select name, tags from persons where id = $1', [person.id])).rows[0];
      if (input.newsletter && email && mail) {
        const tags = typeof mail.tags === 'string' ? JSON.parse(mail.tags) : mail.tags || [];
        const known = (await tx.query('select 1 from subscriptions where workspace_id = $1 and lower(email) = $2', [ws, email])).rows[0];
        if (!known && !tags.includes('do-not-email') && !tags.includes('do-not-contact')) {
          const sid = newId();
          await tx.query(
            `insert into subscriptions (id, workspace_id, email, name, status, source) values ($1, $2, $3, $4, 'subscribed', 'mainstreeting')
             on conflict (workspace_id, email) do nothing`,
            [sid, ws, email, mail.name],
          );
          emit('subscription', sid, 'create', { email, source: 'mainstreeting' });
        }
      }
      return { person_id: person.id, contact_id: contactId, name: person.name };
    },
  },
};
