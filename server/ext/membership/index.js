// Members — the campaign's membership form, on paper or online, in one place.
//
//   memberships   one per term a person joins for: 1 or 4 years from the day
//                 the form was signed (a renewal starts when the current term
//                 ends); youth when they were 14 to 30 that day (the $5 rate);
//                 citizen or permanent resident as ticked; the day the
//                 declaration was signed; paper (entered at the desk, by
//                 whom) or website (Base Web sends "Member (joined online)").
//   gift_pledges  a monthly gift pledged on the form: amount, slate, method,
//                 from when. Each month's money is a gift logged as it comes
//                 in (the first with the form).
//
//   membership.enter   the paper form, entered at the desk — every box on it:
//                      the person (new, or one already on file the desk picks),
//                      profile fields (gender, birth date, citizenship, union
//                      and local, campus, languages, interests, candidate),
//                      volunteer (a request for the desk), a sign (a request),
//                      the membership, gifts once and monthly (Superstar and
//                      Star Club from the year's contribution limit, per
//                      slate; contribution limits checked as for any gift),
//                      and the opt-in the form makes on joining. Card numbers,
//                      expiry and CVV are never taken: the card is run on the
//                      terminal and the number blacked out on the paper.
//   GET /membership/form        the club amounts for a day's year, and the
//                               minimum ($10 a year; $5 aged 14 to 30)
//   GET /membership/match       people already on file a form may be
//   GET /persons/:id/membership their memberships and monthly pledges
import { Hono } from 'hono';
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { newId } from '../../lib/events.js';
import { logGift } from '../../lib/gifts.js';
import { capFor } from '../../lib/cap.js';
import { SLATES, SLATE_CODES, SIGN_KIND_CODES } from '@starbase/shared/canvass';
import { addStandardFields } from '../fields/people.js';
import { actions as fieldActions } from '../fields/actions.js';
import { actions as requestActions } from '../requests/actions.js';

export const sql = `
create table if not exists member_terms (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  person_id uuid not null references persons(id) on delete cascade,
  term_years smallint not null check (term_years in (1, 4)),
  starts_on date not null,
  ends_on date not null,
  youth boolean not null default false,
  citizenship text check (citizenship in ('citizen', 'pr')),
  declaration_on date,
  source text not null check (source in ('paper', 'website')),
  entered_by uuid references users(id),
  created_at timestamptz not null default now(),
  voided_at timestamptz
);
create index if not exists member_terms_person_idx on member_terms (workspace_id, person_id);
create index if not exists member_terms_ends_idx on member_terms (workspace_id, ends_on) where voided_at is null;
create table if not exists gift_pledges (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  person_id uuid not null references persons(id) on delete cascade,
  amount_cents integer not null check (amount_cents > 0),
  slate text,
  method text,
  cadence text not null default 'monthly' check (cadence in ('monthly')),
  starts_on date not null,
  membership_id uuid references member_terms(id) on delete set null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  stopped_at timestamptz
);
create index if not exists gift_pledges_person_idx on gift_pledges (workspace_id, person_id);

-- Window signs (the membership form offers lawn, window, 4×4 and 8×4).
do $$
declare c record;
begin
  for c in select conname, pg_get_constraintdef(oid) as def from pg_constraint
            where conrelid = 'signs'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%kind%' loop
    if c.def not like '%window%' then
      execute format('alter table signs drop constraint %I', c.conname);
      alter table signs add constraint signs_kind_check check (kind in ('billboard', 'large', 'lawn', 'window'));
    end if;
  end loop;
end $$;
`;

export const exportTables = ['member_terms', 'gift_pledges'];

const MONEY = ['manager', 'treasurer', 'staff'];
export const WEBSITE_MEMBER_TAG = 'Member (joined online)';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const today = () => new Date().toISOString().slice(0, 10);
const addYears = (day, n) => {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y + n, m - 1, d));
  if (t.getUTCMonth() !== m - 1) t.setUTCDate(0); // Feb 29 → Feb 28
  return t.toISOString().slice(0, 10);
};
const ageOn = (birth, day) => {
  const [by, bm, bd] = birth.split('-').map(Number);
  const [y, m, d] = day.split('-').map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
};
const money = (c) => `$${(c / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// The club amounts for a year: Star is the limit on one slate; Superstar the
// limit on every slate. Monthly is a twelfth of it, in whole dollars, so a
// year of it stays under the limit ($1,429.70 → $119 a month).
export const clubsFor = async (db, workspace, year) => {
  const rule = await capFor(db, workspace.jurisdiction, year, workspace.settings || {});
  if (!rule) return null;
  const cap = rule.capCents;
  const monthly = Math.floor(cap / 12 / 100) * 100;
  return {
    year, source: rule.source, cap_cents: cap,
    star_once: cap, superstar_once: cap * SLATES.length,
    star_monthly: monthly, superstar_monthly: monthly * SLATES.length,
  };
};

// A website membership (Base Web's "Member (joined online)" tag): a year from
// today, unless one is already running.
export const ensureWebsiteMembership = async (tx, workspaceId, personId, emit) => {
  const day = today();
  const running = (await tx.query(
    'select 1 from member_terms where workspace_id = $1 and person_id = $2 and voided_at is null and ends_on >= $3 limit 1',
    [workspaceId, personId, day],
  )).rows[0];
  if (running) return null;
  const id = newId();
  const row = { id, person_id: personId, term_years: 1, starts_on: day, ends_on: addYears(day, 1), source: 'website' };
  await tx.query(
    `insert into member_terms (id, workspace_id, person_id, term_years, starts_on, ends_on, source) values ($1, $2, $3, 1, $4, $5, 'website')`,
    [id, workspaceId, personId, row.starts_on, row.ends_on],
  );
  emit('membership', id, 'create', row);
  return row;
};

const giftIn = z.object({
  kind: z.enum(['superstar', 'star', 'amount']),
  amount_cents: z.number().int().positive().max(10_000_000).nullish(),
  // Star Club's slate: the council's unless they ticked the school board's.
  slate: z.enum(SLATE_CODES).nullish(),
});
const str = (n) => z.string().trim().max(n).nullish();

export const actions = {
  'membership.enter': {
    roles: MONEY,
    input: z.object({
      person_id: z.uuid().nullish(), // one already on file, as the desk chose
      first_name: str(150), last_name: str(150), gender: str(60),
      birth_date: z.string().regex(DAY).nullish(),
      email: z.string().trim().toLowerCase().email().max(320).nullish().or(z.literal('')),
      phone: str(40), address: str(400), city: str(120), postal: str(20),
      citizenship: z.enum(['citizen', 'pr']).nullish(),
      union_member: z.boolean().default(false), union_local: str(120),
      campus: str(120),
      volunteer: z.boolean().default(false), candidate: z.boolean().default(false),
      sign: z.enum(SIGN_KIND_CODES).nullish(),
      languages: z.array(z.string().trim().min(1).max(80)).max(30).default([]), other_language: str(80),
      interests: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
      term: z.union([z.literal(1), z.literal(4)]).nullish(),
      once: giftIn.nullish(), monthly: giftIn.nullish(),
      method: z.enum(['cash', 'cheque', 'card', 'etransfer', 'pad']).nullish(),
      signed: z.boolean().default(false), signed_on: z.string().regex(DAY).nullish(),
      opt_in: z.boolean().default(true),
    }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const { ACTIONS } = await import('../../actions/index.js');
      const warnings = [];
      const day = input.signed_on || today();
      if (day > today()) throw httpError(400, 'the date signed is in the future');
      const joins = Boolean(input.term);
      const gives = Boolean(input.once || input.monthly);
      if ((joins || gives) && !input.signed) throw httpError(400, 'the declaration isn’t signed — a membership or a gift needs it');
      if (gives && !input.method) throw httpError(400, 'how they paid — cash, cheque, card, e-transfer or pre-authorized debit');
      const first = String(input.first_name || '').trim();
      const last = String(input.last_name || '').trim();
      if (!input.person_id && !first && !last) throw httpError(400, 'a first or last name');
      // Someone on file: a box left blank on this form falls back to what
      // their record already says (a renewal form often skips them).
      const onFile = async (name) => (input.person_id ? (await tx.query(
        `select v.value #>> '{}' as v from person_field_values v join person_fields f on f.id = v.field_id
          where v.workspace_id = $1 and v.person_id = $2 and lower(f.name) = $3 and f.retired_at is null limit 1`,
        [ws, input.person_id, name],
      )).rows[0]?.v || null : null);
      const filedBirth = input.birth_date ? null : await onFile('birth date');
      const birth = input.birth_date || (DAY.test(String(filedBirth)) ? filedBirth : null);
      const age = birth ? ageOn(birth, day) : null;
      if (joins && age != null && age < 14) throw httpError(400, `members are 14 or older (${age} on ${day})`);
      const filedCitizenship = input.citizenship ? null : await onFile('citizenship');
      const citizenship = input.citizenship || (filedCitizenship === 'Canadian citizen' ? 'citizen' : filedCitizenship === 'Permanent resident' ? 'pr' : null);
      if ((joins || gives) && !input.citizenship) {
        warnings.push(citizenship
          ? `Neither citizen nor permanent resident is ticked on this form (on file: ${filedCitizenship}) — check before counting the gift.`
          : 'Neither citizen nor permanent resident is ticked — check before counting the gift.');
      }

      // ── The person: new, or the one on file the desk picked ──
      const core = {
        ...(first ? { first_name: first } : {}), ...(last ? { last_name: last } : {}),
        ...(input.email ? { email: input.email } : {}), ...(input.phone ? { phone: input.phone } : {}),
        ...(input.address ? { address: input.address } : {}), ...(input.city ? { city: input.city } : {}),
        ...(input.postal ? { postal: input.postal.toUpperCase() } : {}),
      };
      let person;
      if (input.person_id) {
        const res = Object.keys(core).length
          ? await ACTIONS['person.update'].handler(tx, ctx, { id: input.person_id, ...core }, emit)
          : { person: (await tx.query('select * from persons where id = $1 and workspace_id = $2 and deleted_at is null', [input.person_id, ws])).rows[0] };
        if (!res.person) throw httpError(404, 'that person is gone — search again');
        person = res.person;
      } else {
        person = (await ACTIONS['person.create'].handler(tx, ctx, { kind: 'person', ...core }, emit)).person;
      }

      // ── Profile fields (made if a campaign doesn't have them yet) ──
      await addStandardFields(tx, ctx, emit);
      const fields = new Map((await tx.query(
        'select id, name, kind, choices from person_fields where workspace_id = $1 and retired_at is null', [ws],
      )).rows.map((f) => [f.name.toLowerCase(), f]));
      const choicesOf = (f) => (Array.isArray(f?.choices) ? f.choices : JSON.parse(f?.choices || '[]'));
      const values = [];
      const set = (name, value) => {
        const f = fields.get(name.toLowerCase());
        if (f && value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && !value.length)) values.push({ field_id: f.id, value });
      };
      set('Gender', input.gender);
      set('Birth date', input.birth_date);
      set('Citizenship', input.citizenship === 'citizen' ? 'Canadian citizen' : input.citizenship === 'pr' ? 'Permanent resident' : null);
      if (input.union_member || input.union_local) set('Union member', true);
      set('Union local', input.union_local);
      set('Campus', input.campus);
      // Languages the field offers; any other goes in Other language.
      const lang = fields.get('language');
      const offered = new Map(choicesOf(lang).map((c) => [c.toLowerCase(), c]));
      const picked = [];
      const others = [];
      for (const l of input.languages) (offered.has(l.toLowerCase()) ? picked.push(offered.get(l.toLowerCase())) : others.push(l));
      if (input.other_language) others.push(input.other_language);
      if (others.length && offered.has('other')) picked.push(offered.get('other'));
      set('Language', [...new Set(picked)]);
      set('Other language', [...new Set(others)].join(', ').slice(0, 500));
      const interests = fields.get('interests');
      const iOffered = new Map(choicesOf(interests).map((c) => [c.toLowerCase(), c]));
      const iPicked = input.interests.map((i) => iOffered.get(i.toLowerCase())).filter(Boolean);
      if (iPicked.length !== input.interests.length) warnings.push('An interest that isn’t on the Interests field’s list was left out.');
      set('Interests', [...new Set(iPicked)]);
      if (input.candidate) set('Interested in being a candidate', true);
      // The form: "By joining, you're automatically opted in to emails and texts."
      const optIn = input.opt_in && input.signed && joins;
      if (optIn && (input.email || person.email)) set('Email opt-in', true);
      if (optIn && (input.phone || person.phone)) set('SMS opt-in', true);
      if (values.length) await fieldActions['field.values.set'].handler(tx, ctx, { person_id: person.id, values }, emit);

      // ── Tags, volunteer, sign ──
      const had = (await tx.query('select tags from persons where id = $1', [person.id])).rows[0];
      const tags = Array.isArray(had?.tags) ? had.tags : JSON.parse(had?.tags || '[]');
      const add = [...(joins ? ['member'] : []), ...(input.volunteer ? ['volunteer'] : [])].filter((t) => !tags.includes(t));
      if (add.length) {
        const next = [...tags, ...add];
        await tx.query('update persons set tags = $3, updated_at = now() where id = $1 and workspace_id = $2', [person.id, ws, JSON.stringify(next)]);
        emit('person', person.id, 'update', { tags: next, source: 'membership form' });
      }
      if (input.volunteer) {
        await requestActions['request.ask'].handler(tx, ctx, { person_id: person.id, kind: 'volunteer', note: 'From a membership form' }, emit);
      }
      let sign = null;
      if (input.sign) {
        try {
          sign = (await (await import('../../actions/field.js')).FIELD_ACTIONS['sign.place'].handler(tx, ctx, {
            kind: input.sign, status: 'requested', person_id: person.id, note: 'From a membership form',
          }, emit)).sign;
        } catch (e) {
          if (e.status !== 400) throw e;
          warnings.push('No sign request: the form has no address for it — add one, then request the sign.');
        }
      }

      // ── The membership ──
      let membership = null;
      const youth = age != null && age >= 14 && age <= 30;
      if (joins) {
        const current = (await tx.query(
          `select max(ends_on) as ends_on from member_terms where workspace_id = $1 and person_id = $2 and voided_at is null and ends_on >= $3`,
          [ws, person.id, day],
        )).rows[0];
        const starts = current?.ends_on ? iso(current.ends_on) : day;
        const id = newId();
        membership = {
          id, person_id: person.id, term_years: input.term, starts_on: starts, ends_on: addYears(starts, input.term),
          youth, citizenship, declaration_on: day, source: 'paper',
        };
        await tx.query(
          `insert into member_terms (id, workspace_id, person_id, term_years, starts_on, ends_on, youth, citizenship, declaration_on, source, entered_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'paper', $10)`,
          [id, ws, person.id, input.term, membership.starts_on, membership.ends_on, youth, membership.citizenship, day, ctx.user?.id || null],
        );
        emit('membership', id, 'create', membership);
        if (current?.ends_on) warnings.push(`A renewal: the new term starts when the current one ends (${membership.starts_on}).`);
      }

      // ── Gifts: once, and the first month of a monthly gift ──
      const gifts = [];
      const pledges = [];
      const year = Number(day.slice(0, 4));
      const clubs = gives ? await clubsFor(tx, ctx.workspace, year) : null;
      const split = (g, mode) => {
        if (g.kind === 'amount') {
          if (!g.amount_cents) throw httpError(400, `the ${mode === 'once' ? 'one-time' : 'monthly'} amount`);
          return [{ slate: g.slate || SLATE_CODES[0], amount_cents: g.amount_cents }];
        }
        if (!clubs) throw httpError(400, `no contribution limit is known for ${year}, so the club amounts can’t be worked out — enter the amount instead`);
        const each = mode === 'once' ? clubs.cap_cents : clubs.star_monthly;
        if (g.kind === 'superstar') return SLATE_CODES.map((slate) => ({ slate, amount_cents: each }));
        return [{ slate: g.slate || SLATE_CODES[0], amount_cents: each }];
      };
      const label = (g, mode) => (g.kind === 'superstar' ? 'Superstar Club' : g.kind === 'star' ? 'Star Club' : mode === 'once' ? 'Gift' : 'Monthly gift');
      if (input.once) {
        for (const part of split(input.once, 'once')) {
          const r = await logGift(tx, ctx.workspace, {
            person_id: person.id, amount_cents: part.amount_cents, date: day, method: input.method, cadence: 'one-time',
            slate: part.slate, note: `${label(input.once, 'once')} — membership form`,
          }, emit);
          gifts.push(r.gift);
        }
      }
      if (input.monthly) {
        for (const part of split(input.monthly, 'monthly')) {
          const pid = newId();
          await tx.query(
            `insert into gift_pledges (id, workspace_id, person_id, amount_cents, slate, method, starts_on, membership_id, created_by)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [pid, ws, person.id, part.amount_cents, part.slate, input.method, day, membership?.id || null, ctx.user?.id || null],
          );
          const pledge = { id: pid, person_id: person.id, amount_cents: part.amount_cents, slate: part.slate, method: input.method, starts_on: day };
          emit('gift_pledge', pid, 'create', pledge);
          pledges.push(pledge);
          const r = await logGift(tx, ctx.workspace, {
            person_id: person.id, amount_cents: part.amount_cents, date: day, method: input.method, cadence: 'monthly',
            slate: part.slate, note: `${label(input.monthly, 'monthly')}, first month — membership form`,
          }, emit);
          gifts.push(r.gift);
        }
      }
      for (const g of gifts) if (g.flagged) warnings.push(`Over the limit: ${g.flag_reason}`);
      if (joins) {
        const minimum = input.term * (youth ? 500 : 1000);
        const paid = gifts.reduce((a, g) => a + g.amount_cents, 0);
        if (paid < minimum) warnings.push(`The membership minimum is ${money(minimum)} (${input.term} year${input.term > 1 ? 's' : ''} at ${youth ? '$5 — aged 14 to 30' : '$10'} a year); ${paid ? `${money(paid)} is logged` : 'no gift is logged'}.`);
      }

      // ── The newsletter, on joining — never back on for someone who left it ──
      const email = input.email || person.email;
      if (optIn && email) {
        const prev = (await tx.query('select id, status from subscriptions where workspace_id = $1 and email = $2', [ws, email.toLowerCase()])).rows[0];
        const noEmail = tags.includes('do-not-email') || tags.includes('do-not-contact');
        if (prev?.status === 'unsubscribed' || noEmail) {
          warnings.push('They had left the email list (or are do-not-email), so they weren’t put back on it. If they want emails again, add them under Outreach → Subscribers.');
        } else if (!prev) {
          const sid = newId();
          await tx.query(
            `insert into subscriptions (id, workspace_id, email, name, status, source) values ($1, $2, $3, $4, 'subscribed', 'membership-form')
             on conflict (workspace_id, email) do nothing`,
            [sid, ws, email.toLowerCase(), person.name],
          );
          emit('subscription', sid, 'create', { email: email.toLowerCase(), source: 'membership-form' });
        }
      }

      const enteredBy = ctx.user?.name || null;
      return {
        person: { id: person.id, name: person.name }, membership, gifts, pledges, sign, warnings,
        entered: { by: enteredBy, on: today() },
      };
    },
  },
};

export const api = new Hono();
const desk = (c) => MONEY.includes(c.get('ctx').role);

api.get('/membership/form', async (c) => {
  if (!desk(c)) return c.json({ error: 'the desk only' }, 403);
  const ctx = c.get('ctx');
  const day = DAY.test(c.req.query('date') || '') ? c.req.query('date') : today();
  const clubs = await clubsFor(c.get('db'), ctx.workspace, Number(day.slice(0, 4)));
  return c.json({
    day, clubs, slates: SLATES,
    minimum: { adult_cents: 1000, youth_cents: 500, youth_ages: [14, 30] },
  });
});

// People already on file a form may be: the same email, the same phone, or
// the same name. The desk picks one (or none) before saving.
api.get('/membership/match', async (c) => {
  if (!desk(c)) return c.json({ error: 'the desk only' }, 403);
  const ctx = c.get('ctx');
  const email = String(c.req.query('email') || '').trim().toLowerCase();
  const digits = String(c.req.query('phone') || '').replace(/\D/g, '').slice(-10);
  const name = [c.req.query('first'), c.req.query('last')].map((x) => String(x || '').trim()).filter(Boolean).join(' ').toLowerCase().replace(/\s+/g, ' ');
  if (!email && digits.length < 7 && name.length < 3) return c.json({ people: [] });
  const rows = (await c.get('db').query(
    `select id, name, email, phone, address, city from persons
      where workspace_id = $1 and deleted_at is null and kind = 'person'
        and (($2 <> '' and lower(email) = $2)
          or (length($3) >= 7 and right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = $3)
          or ($4 <> '' and lower(regexp_replace(trim(name), '\\s+', ' ', 'g')) = $4))
      order by (lower(email) = $2) desc nulls last, created_at limit 5`,
    [ctx.workspaceId, email, digits, name],
  )).rows;
  return c.json({ people: rows });
});

api.get('/persons/:id/membership', async (c) => {
  if (!desk(c)) return c.json({ error: 'the desk only' }, 403);
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return c.json({ error: 'not found' }, 404);
  const db = c.get('db');
  const memberships = (await db.query(
    `select m.id, m.term_years, m.starts_on, m.ends_on, m.youth, m.citizenship, m.declaration_on, m.source, m.created_at, u.name as entered_by
       from member_terms m left join users u on u.id = m.entered_by
      where m.workspace_id = $1 and m.person_id = $2 and m.voided_at is null order by m.ends_on desc`,
    [ctx.workspaceId, id],
  )).rows.map((m) => ({ ...m, starts_on: iso(m.starts_on), ends_on: iso(m.ends_on), declaration_on: m.declaration_on ? iso(m.declaration_on) : null }));
  const pledges = (await db.query(
    `select id, amount_cents, slate, method, starts_on from gift_pledges where workspace_id = $1 and person_id = $2 and stopped_at is null order by starts_on desc`,
    [ctx.workspaceId, id],
  )).rows.map((p) => ({ ...p, starts_on: iso(p.starts_on) }));
  const t = today();
  return c.json({ member: memberships.some((m) => m.starts_on <= t && m.ends_on >= t), memberships, pledges });
});
