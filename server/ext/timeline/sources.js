// What a person's History is made of (index.js). Each source reads ONE
// person's rows through an index and says them in the words the screens
// already use.
//
//   SOURCES   [{ key, group, can(viewer), read(db, q) → entries }]
//   q         { ws, person: { id, name, email }, viewer, before: { at, key }
//               | null, limit, tz, campaign }
//   an entry  { at (a Date), key, group, kind, label, title, detail, by,
//               link, day?, rating? }
//
// Every read has one shape (page): the source's rows as (at, key, …), then
// only those older than the cursor, newest first, as many as the page asks
// for. `at` is cut to the millisecond, so the moment the browser sends back
// as a cursor is the moment the database compares; `key` settles two entries
// of one moment the same way here as in api.js (plain byte order: "C").
// A row that is several things in time — an email sent, opened, clicked; a
// gift and its void — is laid out as one row each, in SQL, before the page
// is cut, so a page is never short by what a later page holds.
import { toLocal, fromLocal } from '../../lib/tzsql.js';
import { SIGN_KINDS, DEFAULT_SLATE, slateLabel } from '@starbase/shared/canvass';
import { fmtIn } from '@starbase/shared/dayparts';
import { placeLabel } from '@starbase/shared/shiftkinds';
import { WEB_WORDS, MONEY_KINDS, campaignWords } from '../webdid/words.js';
import { showValue } from '../surveys/answers.js';
import { fillIn } from '../ladders/shape.js';
import { wordOf as paymentWord } from '../payments/api.js';

const ms = (x) => `date_trunc('milliseconds', ${x})`;
// $1 campaign · $2 person · $3, $4 the cursor · $5 how many; a source's own from $6.
const page = (inner) => `select * from (${inner}) e
  where e.at is not null
    and ($3::timestamptz is null or e.at < $3::timestamptz
         or (e.at = $3::timestamptz and e.key collate "C" < $4::text collate "C"))
  order by e.at desc, e.key collate "C" desc
  limit $5::int`;
const rowsOf = async (db, inner, q, ...own) => (await db.query(
  page(inner), [q.ws, q.person.id, q.before?.at ?? null, q.before?.key ?? null, q.limit, ...own],
)).rows;
const UUID_SQL = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

// ── Words ──
const entry = (r, group, kind, label, title, more = {}) => ({
  at: r.at, key: r.key, group, kind, label, title, detail: null, by: null, link: null, ...more,
});
// One line, cut where it would run on.
const clean = (s, max = 300) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
const line = (...parts) => parts.filter(Boolean).join(' · ') || null;
const money = (cents) => `$${(Number(cents || 0) / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const parseJ = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; } };
// "Oct 6, 2026" for a date column (both databases hand back UTC midnight).
const dateWord = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
// "Sat, Nov 1": the day a shift is on, in the campaign's time.
const dayWord = (ts, tz) => fmtIn(ts, tz, { weekday: 'short', month: 'short', day: 'numeric' });
const years = (n) => `${n} year${Number(n) === 1 ? '' : 's'}`;

// ── Knocks, calls and talks: History as it always read ──
const CHANNEL = { door: 'Door', phone: 'Phone', text: 'Text', in_person: 'In person', mainstreet: 'Mainstreeting' };
const OUTCOME = {
  contacted: 'Talked', no_answer: 'No answer', refused: 'Refused', moved: 'Moved', inaccessible: 'No access',
  left_lit: 'Left lit', left_message: 'Left message',
};
// A call an outside dialer logged (contacts.source) says which, beside
// whoever on the team it was credited to.
const DIALER = { callhub: 'CallHub' };
const contacts = async (db, q) => (await rowsOf(db, `
  select ${ms('c.created_at')} as at, 'contact:' || c.id::text as key,
         c.channel, c.outcome, c.rating, c.note, c.source, u.name as by_name
    from contacts c left join users u on u.id = c.created_by
   where c.workspace_id = $1 and c.person_id = $2`, q,
)).map((r) => entry(r, 'field', r.channel, CHANNEL[r.channel] || r.channel, r.rating ? `Rated ${r.rating}` : OUTCOME[r.outcome] || r.outcome, {
  detail: r.note || null, by: line(r.by_name, DIALER[r.source]), ...(r.rating ? { rating: r.rating } : {}),
}));

// ── Survey answers: one entry for a conversation's answers ──
const answers = async (db, q) => (await rowsOf(db, `
  select ${ms('max(r.created_at)')} as at, 'answers:' || r.contact_id::text || ':' || r.survey_id::text as key,
         s.name as survey, max(u.name) as by_name,
         json_agg(json_build_object('q', sq.text, 'kind', sq.kind, 'v', r.value) order by sq.position, sq.created_at) as said
    from survey_responses r
    join survey_questions sq on sq.id = r.question_id
    join surveys s on s.id = r.survey_id
    left join users u on u.id = r.created_by
   where r.workspace_id = $1 and r.person_id = $2
   group by r.contact_id, r.survey_id, s.name`, q,
)).map((r) => entry(r, 'field', 'answers', 'Survey', `Answered · ${r.survey}`, {
  detail: clean(parseJ(r.said, []).map((a) => `${a.q}${/[?:]$/.test(a.q) ? '' : ':'} ${showValue(a.kind, a.v)}`).join(' · ')) || null,
  by: r.by_name || null, link: '#answers',
}));

// ── Signs: each step as the log has it (asked for, put up, taken down) ──
const SIGN_STEP = { requested: 'Asked for', installed: 'Put up', removed: 'Taken down' };
const signs = async (db, q) => (await rowsOf(db, `
  select ${ms('coalesce(e.server_ts, s.created_at)')} as at, 'sign:' || s.id::text || ':' || coalesce(e.seq::text, '0') as key,
         s.kind, coalesce(e.payload->>'status', s.status) as status, s.note, e.op, u.name as by_name
    from signs s
    left join events e on e.workspace_id = s.workspace_id and e.entity_type = 'sign' and e.entity_id = s.id
         and (e.op = 'create' or (e.op = 'update' and e.payload->>'status' is not null))
    left join users u on u.id = e.actor_id
   where s.workspace_id = $1 and s.person_id = $2`, q,
)).map((r) => entry(r, 'field', 'sign', 'Sign', `${SIGN_STEP[r.status] || r.status} · ${SIGN_KINDS.find((k) => k.code === r.kind)?.label || r.kind}`, {
  // The note is the request's; who did each step is the desk's to see.
  detail: r.op === 'update' ? null : r.note || null, by: q.viewer.desk ? r.by_name || null : null, link: '#signs',
}));

// ── Voted marks ──
const VOTED_WHERE = { door: 'At the door', phone: 'On a call', desk: 'At the desk', file: 'From a voted list' };
const voted = async (db, q) => (await rowsOf(db, `
  select ${ms('m.created_at')} as at, 'voted:' || m.id::text as key, m.voted, m.source, u.name as by_name
    from voted_marks m left join users u on u.id = m.marked_by
   where m.workspace_id = $1 and m.person_id = $2`, q,
)).map((r) => entry(r, 'field', 'voted', 'Voted', r.voted ? 'Marked as voted' : 'Voted mark taken back', {
  detail: VOTED_WHERE[r.source] || null, by: q.viewer.desk ? r.by_name || null : null,
}));

// ── Texts through the campaign's number (a volunteer: the threads they started) ──
// One from them is "Received", not "Replied": some people text first.
const TEXT_OUT = { sent: 'Sent', delivered: 'Delivered', undelivered: 'Not delivered', failed: 'Not sent' };
const texts = async (db, q) => (await rowsOf(db, `
  select ${ms('m.created_at')} as at, 'text:' || m.id::text as key,
         m.direction, m.status, m.body, m.conversation_id, u.name as by_name
    from texting_conversations c
    join texting_messages m on m.conversation_id = c.id
    left join users u on u.id = m.sent_by
   where c.workspace_id = $1 and c.person_id = $2 and ($6::uuid is null or c.started_by = $6::uuid)`,
  q, q.viewer.desk ? null : q.viewer.userId,
)).map((r) => entry(r, 'messages', r.direction === 'in' ? 'text_in' : 'text_out', 'Text',
  r.direction === 'in' ? 'Received' : TEXT_OUT[r.status] || 'Sent', {
    detail: clean(r.body) || null, by: r.direction === 'in' ? null : r.by_name || null, link: `/inbox/${r.conversation_id}`,
  }));

// ── Emails sent to them, with the first open and click — and a bounce or
// a spam complaint once the email service reports one (ext/mail keeps
// bounced_at, bounce_detail and complained_at on the row) ──
const EMAIL = {
  sent: ['email', 'Sent'], failed: ['email_failed', 'Not sent'], unsure: ['email_unsure', 'Not sure it went'],
  open: ['email_open', 'Opened'], click: ['email_click', 'Clicked a link'],
  bounce: ['email_bounce', 'Bounced'], spam: ['email_spam', 'Marked as spam'],
};
const shortUrl = (u) => clean(String(u || '').replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, ''), 60);
// A send to a list or a filter carries the person; the newsletter's goes
// to an address (no person on the row), found by the email they have now.
const emails = async (db, q) => (await rowsOf(db, `
    select ${ms('x.at')} as at, 'email:' || r.id::text || ':' || x.what as key, x.what, b.subject, l.url, r.bounce_detail
      from (
        select * from blast_recipients where workspace_id = $1 and person_id = $2
        union all
        select * from blast_recipients where workspace_id = $1 and person_id is null and $6::text <> '' and lower(email) = $6::text
      ) r
      join blasts b on b.id = r.blast_id and b.workspace_id = r.workspace_id and b.kind in ('newsletter', 'press', 'eblast')
      left join blast_links l on l.blast_id = r.blast_id and l.n = r.first_click_n
      cross join lateral (values
        ('sent', case when r.status = 'sent' then coalesce(r.sent_at, b.sent_at, r.created_at) end),
        ('failed', case when r.status = 'failed' then coalesce(r.sending_at, r.created_at) end),
        ('unsure', case when r.status = 'sending' then coalesce(r.sending_at, r.created_at) end),
        ('open', r.first_open_at),
        ('click', r.first_click_at),
        ('bounce', r.bounced_at),
        ('spam', r.complained_at)
      ) x(what, at)`,
  q, String(q.person.email || '').trim().toLowerCase(),
)).map((r) => entry(r, 'messages', EMAIL[r.what][0], 'Email', EMAIL[r.what][1], {
  detail: line(clean(r.subject, 200), r.what === 'click' && shortUrl(r.url), r.what === 'bounce' && clean(r.bounce_detail, 120)),
  link: '/outreach/email',
}));

// ── A ladder's emails, from each run's own log ──
const LADDER = { sent: ['email', 'Sent'], unsure: ['email_unsure', 'Not sure it went'], failed: ['email_failed', 'Not sent'] };
const ladderEmails = async (db, q) => (await rowsOf(db, `
  select ${ms("(case when v.e->>'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$' then (v.e->>'at')::timestamptz end)")} as at,
         'ladder:' || r.id::text || ':' || coalesce(v.e->>'step', '') || ':' || coalesce(v.e->>'at', '') as key,
         v.e->>'result' as result, l.name as ladder, l.deleted_at is null as live,
         case when v.e->>'step' ~ '^[0-9]{1,3}$' then l.steps -> ((v.e->>'step')::int) ->> 'subject' end as subject
    from ladder_runs r
    join ladders l on l.id = r.ladder_id and l.workspace_id = r.workspace_id
    cross join lateral jsonb_array_elements(case when jsonb_typeof(r.log) = 'array' then r.log else '[]'::jsonb end) v(e)
   where r.workspace_id = $1 and r.person_id = $2 and v.e->>'kind' = 'email'
     and (v.e->>'result' in ('sent', 'unsure') or (v.e->>'result' = 'failed' and v.e->>'reason' = 'gave_up'))`, q,
)).map((r) => entry(r, 'messages', LADDER[r.result][0], 'Email', LADDER[r.result][1], {
  // The step's subject as it is now, with their name in it. A ladder since
  // deleted is off the profile's Ladders: nowhere to lead.
  detail: line(clean(fillIn(r.subject, { person: q.person, campaign: q.campaign }), 200), r.ladder), link: r.live ? '#ladders' : null,
}));

// ── Yes and no to email and texts ──
// The email service's own doors (ext/mail, ext/mailchimp, where they are
// set up) say where it came from: a spam complaint ends the yes too.
const UNSUBSCRIBED = new Set(['unsubscribe-link', 'blast-unsubscribe', 'ladder-unsubscribe', 'preferences']);
const EMAIL_NO = { complaint: 'Off the email list — marked as spam', 'mailchimp-unsubscribe': 'Unsubscribed in Mailchimp', 'desk-removed': 'Taken off the email list' };
const consentWords = (r) => {
  if (r.channel === 'sms') {
    if (r.granted) return r.source === 'text-start' ? 'Replied START' : 'Said yes to texts';
    return r.source === 'text-stop' ? 'Replied STOP' : r.source === 'preferences' ? 'Turned texts off' : 'Marked do not text';
  }
  if (r.granted) return r.source === 'desk-added' ? 'Added to the email list' : 'Said yes to email';
  return UNSUBSCRIBED.has(r.source) ? 'Unsubscribed from email' : EMAIL_NO[r.source] || 'Marked do not email';
};
const consent = async (db, q) => (await rowsOf(db, `
  select ${ms('c.created_at')} as at, 'consent:' || c.id::text as key, c.channel, c.granted, c.source, c.wording
    from consent_events c
   where c.workspace_id = $1 and c.person_id = $2`, q,
)).map((r) => entry(r, 'messages', 'consent', r.channel === 'sms' ? 'Text' : 'Email', consentWords(r), {
  // The words they were shown, when it was a form's box.
  detail: clean(r.wording, 200) || null,
}));

// ── Website forms, by kind (the money forms are money) ──
const webDetail = (r, p) => {
  if (r.kind === 'contact') return clean([p.topic, p.message].filter(Boolean).join(': ')) || null;
  if (r.kind === 'volunteer') return clean(line(Array.isArray(p.roles) && p.roles.join(', '), p.availability, p.note) || '') || null;
  if (r.kind === 'petition' || r.kind === 'pledge') return clean(p.comment) || null;
  if (r.kind === 'rsvp') return r.shift_title || null;
  if (r.kind === 'donate') return p.amount_cents ? `${money(p.amount_cents)}${p.cadence === 'monthly' ? ' a month' : ''}` : null;
  if (r.kind === 'join') return line(p.term && years(p.term), p.amount_cents && money(p.amount_cents));
  return null;
};
// On another website of the campaign: which one.
const onSite = (r) => (!r.site_id ? '' : r.site_deleted || !(r.site_domain || r.site_name) ? ' on a site since deleted' : ` on ${r.site_domain || r.site_name}`);
const web = async (db, q) => (await rowsOf(db, `
  select ${ms('a.created_at')} as at, 'web:' || a.id::text as key, a.kind, a.payload,
         sc.kind as campaign_kind, sc.title as campaign_title, s.id as shift_id, s.title as shift_title,
         a.site_id, m.name as site_name, m.domains->>0 as site_domain, m.deleted_at as site_deleted
    from site_actions a
    left join site_campaigns sc on sc.id = a.campaign_id and sc.workspace_id = a.workspace_id
    left join microsites m on m.id = a.site_id and m.workspace_id = a.workspace_id
    left join shifts s on s.workspace_id = a.workspace_id
         and s.id = case when a.kind = 'rsvp' and a.payload->>'shift_id' ~ '${UUID_SQL}' then (a.payload->>'shift_id')::uuid end
   where a.workspace_id = $1 and a.person_id = $2 and a.kind <> all($6::text[])`,
  q, q.viewer.money ? [] : [...MONEY_KINDS],
)).map((r) => entry(r, 'website', 'web', 'Website',
  `${r.campaign_title ? campaignWords({ kind: r.campaign_kind, title: r.campaign_title }) : WEB_WORDS[r.kind] || 'Did something on the website'}${onSite(r)}`, {
    detail: webDetail(r, parseJ(r.payload, {}) || {}), link: r.shift_id ? `/shifts/${r.shift_id}` : null,
  }));

// ── Gifts, and a gift taken out of the books ──
// A gift keyed in on its own day shows at the time it was logged; one
// dated another day shows on that day (noon, said as the day alone). A
// gift voided by a card refund has the refund's entry (payments), not a
// second one here. Only a gift still on the books leads to the profile's
// Gifts: that list leaves out the ones taken off.
const METHOD = { card: 'Card', etransfer: 'E-transfer', cheque: 'Cheque', cash: 'Cash', pad: 'Pre-authorized debit', 'in-kind': 'In-kind' };
const gifts = async (db, q) => (await rowsOf(db, `
  select ${ms('x.at')} as at, 'gift:' || g.id::text || x.tail as key, x.what, x.day,
         g.amount_cents, g.method, g.cadence, g.slate, g.note, g.flagged, g.deleted_at is not null as void, g.attrs->>'source' as source
    from gifts g
    cross join lateral (values
      ('gift', '',
       case when (${toLocal('g.created_at', '$6::text')})::date = g.date then g.created_at
            else ${fromLocal("(g.date + time '12:00')", '$6::text')} end,
       (${toLocal('g.created_at', '$6::text')})::date <> g.date),
      ('void', ':void',
       case when g.deleted_at is not null and not exists (
              select 1 from stripe_payments sp
               where sp.workspace_id = g.workspace_id and sp.gift_id = g.id and sp.status in ('refunded', 'dispute_lost'))
            then g.deleted_at end,
       false)
    ) x(what, tail, at, day)
   where g.workspace_id = $1 and g.person_id = $2`, q, q.tz,
)).map((r) => (r.what === 'void'
  ? entry(r, 'money', 'gift_void', 'Gift', `Voided · ${money(r.amount_cents)}`)
  : entry(r, 'money', 'gift', 'Gift', line(
    money(r.amount_cents), METHOD[r.method] || r.method, r.cadence === 'monthly' && 'monthly',
    r.slate && r.slate !== DEFAULT_SLATE && slateLabel(r.slate), r.source === 'online' && 'online',
    r.void ? 'void' : r.flagged && 'flagged',
  ), { detail: r.note || null, link: r.void ? null : '#gifts', ...(r.day ? { day: true } : {}) })));

// ── An online payment that isn't simply paid: refunded, disputed… ──
// When it came to stand as it does: the log's event for that status (the
// row's own time moves again with a "Got it"). It leads to Gifts while its
// gift is there: not once a refund or a lost dispute has voided it, nor
// when it never was one (over the limit, no donor).
const PAYMENT_KIND = {
  refunded: 'refund', partly_refunded: 'refund', over_limit: 'refund', refund_failed: 'refund_failed',
  disputed: 'dispute', dispute_lost: 'dispute',
};
const payments = async (db, q) => (await rowsOf(db, `
  select ${ms('coalesce(ev.at, sp.updated_at)')} as at, 'pay:' || sp.id::text as key,
         sp.status, sp.over_limit, sp.kind, sp.amount_cents, sp.refunded_cents, g.id is not null as booked
    from stripe_payments sp
    left join gifts g on g.id = sp.gift_id and g.workspace_id = sp.workspace_id and g.person_id = sp.person_id and g.deleted_at is null
    left join lateral (
      select max(e.server_ts) as at from events e
       where e.workspace_id = sp.workspace_id and e.entity_type = 'payment' and e.entity_id = sp.id and e.payload->>'status' = sp.status
    ) ev on true
   where sp.workspace_id = $1 and sp.person_id = $2 and sp.status <> 'paid'`, q,
)).map((r) => entry(r, 'money', PAYMENT_KIND[r.status] || 'payment', 'Gift', line(
  paymentWord(r),
  r.status === 'partly_refunded' ? `${money(r.refunded_cents)} of ${money(r.amount_cents)}` : money(r.amount_cents),
), { detail: r.kind === 'membership' ? 'Membership dues, paid online' : 'Paid online', link: r.booked ? '#gifts' : null }));

// ── Memberships: joined or renewed, and a term that ended with none after it ──
const members = async (db, q) => (await rowsOf(db, `
  select ${ms('x.at')} as at, 'member:' || m.id::text || x.tail as key, x.what, x.day,
         m.term_years, m.ends_on, m.youth, m.source, m.voided_at is not null as void, u.name as by_name,
         exists (select 1 from member_terms o
                  where o.workspace_id = m.workspace_id and o.person_id = m.person_id and o.id <> m.id and o.voided_at is null
                    and (o.starts_on, o.created_at) < (m.starts_on, m.created_at)) as renewal
    from member_terms m
    left join users u on u.id = m.entered_by
    cross join lateral (values
      ('join', '',
       case when m.declaration_on is null or (${toLocal('m.created_at', '$6::text')})::date = m.declaration_on then m.created_at
            else ${fromLocal("(m.declaration_on + time '12:00')", '$6::text')} end,
       m.declaration_on is not null and (${toLocal('m.created_at', '$6::text')})::date <> m.declaration_on),
      ('end', ':end',
       case when m.voided_at is not null then m.voided_at
            when m.ends_on < (${toLocal('now()', '$6::text')})::date and not exists (
              select 1 from member_terms o
               where o.workspace_id = m.workspace_id and o.person_id = m.person_id and o.id <> m.id and o.voided_at is null
                 and o.starts_on <= m.ends_on and o.ends_on > m.ends_on)
            then ${fromLocal("(m.ends_on + time '12:00')", '$6::text')} end,
       m.voided_at is null)
    ) x(what, tail, at, day)
   where m.workspace_id = $1 and m.person_id = $2`, q, q.tz,
)).map((r) => (r.what === 'end'
  ? entry(r, 'money', 'member_end', 'Member', r.void ? 'Membership ended · dues refunded' : 'Membership ended', r.day ? { day: true } : {})
  : entry(r, 'money', 'member', 'Member', `${r.renewal ? 'Renewed' : 'Joined'} · ${years(r.term_years)}`, {
    detail: line(`To ${dateWord(r.ends_on)}`, r.source === 'website' ? 'Online' : 'Paper form', r.youth && 'Youth rate'),
    by: r.by_name || null, ...(r.day ? { day: true } : {}),
  })));

// ── Shifts: booked, came, didn't show up ──
const SHIFT = { booked: 'Booked', came: 'Came', missed: 'Didn’t show up' };
const shifts = async (db, q) => (await rowsOf(db, `
  select ${ms('x.at')} as at, 'shift:' || a.id::text || ':' || x.what as key, x.what, a.status,
         s.id as shift_id, s.title, s.starts_at, s.location
    from shift_assignments a
    join shifts s on s.id = a.shift_id and s.workspace_id = a.workspace_id and s.deleted_at is null
    cross join lateral (values
      ('booked', a.created_at),
      ('came', case when a.status = 'completed' then s.starts_at end),
      ('missed', case when a.status = 'no_show' then s.starts_at end)
    ) x(what, at)
   where a.workspace_id = $1 and a.person_id = $2`, q,
)).map((r) => entry(r, 'shifts', `shift_${r.what}`, 'Shift', `${SHIFT[r.what]} · ${r.title}`, {
  detail: r.what === 'booked'
    ? line(dayWord(r.starts_at, q.tz), placeLabel(r.location), r.status === 'declined' && 'Can’t make it', r.status === 'confirmed' && 'Confirmed')
    : placeLabel(r.location) || null,
  link: `/shifts/${r.shift_id}`,
}));

// ── Two records made one (the kept record's own event on the log) ──
const merges = async (db, q) => (await rowsOf(db, `
  select ${ms('e.server_ts')} as at, 'merge:' || e.seq::text as key, d.name as other, u.name as by_name
    from events e
    left join persons d on d.workspace_id = e.workspace_id
         and d.id = case when e.payload->>'merged' ~ '${UUID_SQL}' then (e.payload->>'merged')::uuid end
    left join users u on u.id = e.actor_id
   where e.workspace_id = $1 and e.entity_type = 'person' and e.entity_id = $2
     and e.action = 'person.merge' and e.op = 'update' and e.payload ? 'merged'`, q,
)).map((r) => entry(r, 'other', 'merge', 'Merged', 'Two records made one', {
  detail: r.other ? `With the record for ${r.other}` : null, by: r.by_name || null,
}));

// Who may read each, exactly as its own read already says (index.js).
const anyone = () => true;
const desk = (v) => v.desk;
const outreach = (v) => v.desk && v.outreach;
const moneyRoles = (v) => v.money;
export const SOURCES = [
  { key: 'contacts', group: 'field', can: anyone, read: contacts },
  { key: 'answers', group: 'field', can: desk, read: answers },
  { key: 'signs', group: 'field', can: anyone, read: signs },
  { key: 'voted', group: 'field', can: anyone, read: voted },
  { key: 'texts', group: 'messages', can: (v) => v.outreach, read: texts },
  { key: 'emails', group: 'messages', can: outreach, read: emails },
  { key: 'ladders', group: 'messages', can: outreach, read: ladderEmails },
  { key: 'consent', group: 'messages', can: outreach, read: consent },
  { key: 'web', group: 'website', can: desk, read: web },
  { key: 'gifts', group: 'money', can: moneyRoles, read: gifts },
  { key: 'payments', group: 'money', can: moneyRoles, read: payments },
  { key: 'members', group: 'money', can: moneyRoles, read: members },
  { key: 'shifts', group: 'shifts', can: anyone, read: shifts },
  { key: 'merges', group: 'other', can: desk, read: merges },
];
// The chips, in the order the profile shows them ('other' has none: All only).
export const GROUPS = ['field', 'messages', 'website', 'money', 'shifts'];
