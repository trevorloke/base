// Calendar entries (shared/ics.js): the one builder the server and the
// screens share. Times are written in UTC, so a 6:30 am shift in Surrey is
// 6:30 am in every calendar app whatever its copy of the time-zone rules
// says about B.C. (permanent UTC-7 since March 2026). Run under the tzchk
// Node and under the system Node with TZ=America/Toronto: the bytes are the
// same (the last test prints a digest to compare).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dayEvent, escText, fold, googleLink, icsCalendar, icsEvent, outlookLink, shiftEvent } from '@starbase/shared/ics';

const TZ = 'America/Vancouver';
const NOW = new Date('2026-11-12T18:00:00Z');
const enc = new TextEncoder();
const lines = (s) => s.split('\r\n');
const unfold = (s) => s.replace(/\r\n /g, '');
const prop = (s, name) => lines(unfold(s)).find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));

const wave = {
  id: '11111111-2222-4333-8444-555555555555', title: 'Burma Shave — King George Blvd & 88 Ave', kind: 'burma_shave',
  starts_at: '2026-11-16T13:30:00Z', ends_at: '2026-11-16T15:30:00Z', location: 'King George Blvd & 88 Ave',
  instructions: 'Door code 4411; call Ava Example at 604-555-0101', link: 'https://example.org/wave', place_lat: 49.163, place_lng: -122.8447,
};

test('lines: CRLF everywhere, folded at 75 octets, never inside a character', () => {
  const name = `Café Example — ${'Ḱ'.repeat(60)} ${'é'.repeat(40)}`;
  const s = icsCalendar({ name, events: [shiftEvent({ ...wave, title: name }, { tz: TZ })], now: NOW });
  assert.ok(s.endsWith('\r\n'));
  assert.equal(s.replace(/\r\n/g, '').includes('\n'), false, 'no bare new line');
  assert.equal(s.replace(/\r\n/g, '').includes('\r'), false, 'no bare carriage return');
  for (const l of lines(s)) {
    assert.ok(enc.encode(l).length <= 75, `${enc.encode(l).length} octets: ${l}`);
    // A line cut inside a character would not survive decoding back.
    assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(enc.encode(l)), l);
  }
  assert.equal(prop(s, 'SUMMARY'), `SUMMARY:${name}`);
  assert.equal(prop(s, 'X-WR-CALNAME'), `X-WR-CALNAME:${name}`);
  // Folding is exactly reversible.
  const long = 'x'.repeat(200);
  assert.equal(unfold(fold(long)), long);
  assert.deepEqual(lines(fold(long)).map((l) => l.length), [75, 75, 52]);
});

test('escaping: backslash, semicolon, comma and new lines', () => {
  assert.equal(escText('a\\b;c,d\ne\r\nf'), 'a\\\\b\\;c\\,d\\ne\\nf');
  const s = icsEvent({ uid: 'u@base.win', title: 'Pancakes, eggs; toast\\jam', start: '2026-11-16T13:30:00Z', end: '2026-11-16T15:30:00Z', details: 'one\ntwo' }, { now: NOW });
  assert.equal(prop(s, 'SUMMARY'), 'SUMMARY:Pancakes\\, eggs\\; toast\\\\jam');
  assert.equal(prop(s, 'DESCRIPTION'), 'DESCRIPTION:one\\ntwo');
});

test('a calendar has its header; an event has every required property and no alarm', () => {
  const s = icsCalendar({ name: 'Imagine Example — my shifts', events: [shiftEvent(wave, { tz: TZ })], refresh: true, now: NOW });
  const L = lines(unfold(s));
  assert.deepEqual(L.slice(0, 8), [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//base.win//Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:Imagine Example — my shifts', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
  ]);
  for (const p of ['BEGIN:VEVENT', `UID:shift-${wave.id}@base.win`, 'DTSTAMP:20261112T180000Z', 'STATUS:CONFIRMED', 'END:VEVENT', 'END:VCALENDAR']) {
    assert.ok(L.includes(p), p);
  }
  assert.ok(!/VALARM|VTIMEZONE|TZID/.test(s));
  assert.equal(prop(s, 'GEO'), 'GEO:49.163;-122.8447');
  assert.equal(prop(s, 'LOCATION'), 'LOCATION:King George Blvd & 88 Ave');
  // Without refresh (a single file): no refresh lines.
  assert.ok(!/REFRESH-INTERVAL/.test(icsCalendar({ name: 'x', events: [] })));
});

test('times in UTC: a 6:30–8:30 am shift on Nov 16, 2026; Nov 1–2 not an hour off', () => {
  const s = icsEvent(shiftEvent(wave, { tz: TZ }), { now: NOW });
  assert.equal(prop(s, 'DTSTART'), 'DTSTART:20261116T133000Z');
  assert.equal(prop(s, 'DTEND'), 'DTEND:20261116T153000Z');
  assert.match(prop(s, 'DESCRIPTION'), /^DESCRIPTION:Monday\\, November 16\\, 6:30 – 8:30 a\.m\./);
  // 6:30 am on Sunday Nov 1 and Monday Nov 2 (where old rules fall back).
  for (const day of ['2026-11-01', '2026-11-02']) {
    const e = shiftEvent({ ...wave, starts_at: `${day}T06:30:00-07:00`, ends_at: `${day}T08:30:00-07:00` }, { tz: TZ });
    assert.equal(prop(icsEvent(e), 'DTSTART'), `DTSTART:${day.replace(/-/g, '')}T133000Z`);
    assert.match(e.details, /6:30 – 8:30 a\.m\./);
  }
});

test('the person’s own hours inside a shift, and a shift that crosses midnight', () => {
  const e = shiftEvent(wave, { tz: TZ, booking: { arrive_at: '2026-11-16T14:00:00Z', leave_at: '2026-11-16T15:00:00Z' } });
  const s = icsEvent(e);
  assert.equal(prop(s, 'DTSTART'), 'DTSTART:20261116T140000Z');
  assert.equal(prop(s, 'DTEND'), 'DTEND:20261116T150000Z');
  assert.equal(e.details.split('\n')[0], 'Your part: 7 – 8 a.m. of a 6:30 – 8:30 a.m. shift');
  // No booking hours: the whole shift, no "Your part".
  assert.ok(!/Your part/.test(shiftEvent(wave, { tz: TZ, booking: { arrive_at: null, leave_at: null } }).details));
  // 8 pm – 1 am: one entry, ending the next day.
  const late = shiftEvent({ ...wave, kind: 'event', title: 'Election night', starts_at: '2026-10-18T03:00:00Z', ends_at: '2026-10-18T08:00:00Z' }, { tz: TZ });
  assert.equal(prop(icsEvent(late), 'DTEND'), 'DTEND:20261018T080000Z');
  assert.equal(late.details.split('\n')[0], 'Saturday, October 17, 8 p.m. – Sunday, October 18, 1 a.m.');
});

test('a calendar link’s entries leave out the instructions and the Details link', () => {
  const s = icsEvent(shiftEvent(wave, { tz: TZ, private: false, appUrl: 'https://base.example.org/shifts/1' }));
  assert.ok(!/Instructions|Details|4411|604-555/.test(unfold(s)));
  assert.match(unfold(s), /Open in base\.win: https:\/\/base\.example\.org\/shifts\/1/);
  assert.equal(prop(s, 'URL'), 'URL:https://base.example.org/shifts/1');
  // The person's own file has them.
  const own = unfold(icsEvent(shiftEvent(wave, { tz: TZ })));
  assert.match(own, /Instructions: Door code 4411\\; call Ava Example at 604-555-0101/);
  assert.match(own, /Details: https:\/\/example\.org\/wave/);
  assert.ok(!/URL:/.test(own), 'no app address: no URL');
});

test('all-day days with an exclusive end', () => {
  const e = dayEvent({ uid: 'vote-2026-10-17@base.win', title: 'Election day', day: '2026-10-17', details: 'Imagine Example' });
  const s = icsEvent(e);
  assert.equal(prop(s, 'DTSTART'), 'DTSTART;VALUE=DATE:20261017');
  assert.equal(prop(s, 'DTEND'), 'DTEND;VALUE=DATE:20261018');
  assert.equal(dayEvent({ uid: 'x', title: 'x', day: '2026-12-31' }).end, '2027-01-01');
  assert.equal(dayEvent({ uid: 'x', title: 'x', day: 'soon' }), null);
});

test('Google and Outlook links', () => {
  const e = shiftEvent(wave, { tz: TZ });
  const g = new URL(googleLink(e));
  assert.equal(g.origin + g.pathname, 'https://calendar.google.com/calendar/render');
  assert.equal(g.searchParams.get('action'), 'TEMPLATE');
  assert.equal(g.searchParams.get('text'), wave.title);
  assert.equal(g.searchParams.get('dates'), '20261116T133000Z/20261116T153000Z');
  assert.match(googleLink(e), /&dates=20261116T133000Z\/20261116T153000Z&/);
  assert.equal(g.searchParams.get('location'), wave.location);
  assert.match(g.searchParams.get('details'), /Instructions: Door code/);
  const o = new URL(outlookLink(e));
  assert.equal(o.origin + o.pathname, 'https://outlook.live.com/calendar/0/deeplink/compose');
  assert.equal(o.searchParams.get('path'), '/calendar/action/compose');
  assert.equal(o.searchParams.get('rru'), 'addevent');
  assert.equal(o.searchParams.get('subject'), wave.title);
  assert.equal(o.searchParams.get('startdt'), '2026-11-16T13:30:00Z');
  assert.equal(o.searchParams.get('enddt'), '2026-11-16T15:30:00Z');
  assert.equal(o.searchParams.get('allday'), null);
  const day = dayEvent({ uid: 'vote-2026-10-17@base.win', title: 'Election day', day: '2026-10-17' });
  assert.equal(new URL(googleLink(day)).searchParams.get('dates'), '20261017/20261018');
  const od = new URL(outlookLink(day));
  assert.deepEqual([od.searchParams.get('startdt'), od.searchParams.get('enddt'), od.searchParams.get('allday')], ['2026-10-17', '2026-10-18', 'true']);
});

test('places: never “Pin at …”; a pin is its map and its GEO', () => {
  const pinned = shiftEvent({ ...wave, location: 'Pin at 49.1630, −122.8447', place_lat: null, place_lng: null }, { tz: TZ });
  const s = unfold(icsEvent(pinned));
  assert.ok(!/Pin at/.test(s));
  assert.match(prop(s, 'LOCATION'), /^LOCATION:see the map — https:\/\/www\.google\.com\/maps/);
  assert.equal(prop(s, 'GEO'), 'GEO:49.163;-122.8447');
  const nowhere = icsEvent(shiftEvent({ ...wave, location: null, place_lat: null, place_lng: null }, { tz: TZ }));
  assert.ok(!/LOCATION|GEO/.test(nowhere));
});

test('no end time: the kind’s usual length; no kind: two hours; drop-in says so', () => {
  const canvass = shiftEvent({ ...wave, kind: 'canvass', ends_at: null }, { tz: TZ });
  assert.equal(canvass.end, '2026-11-16T16:30:00.000Z');
  assert.match(canvass.details, /No end time set/);
  assert.match(canvass.details, /^Monday, November 16, 6:30 a\.m\.\n/);
  const old = shiftEvent({ ...wave, kind: null, ends_at: null }, { tz: TZ });
  assert.equal(old.end, '2026-11-16T15:30:00.000Z');
  assert.match(shiftEvent({ ...wave, drop_in: true }, { tz: TZ }).details, /Drop in any time/);
  assert.ok(!/Drop in/.test(shiftEvent(wave, { tz: TZ }).details));
});

test('the same bytes on any machine’s clock (compare the digest across Node builds)', () => {
  const s = icsCalendar({
    name: 'Imagine Example — my shifts', refresh: true, now: NOW,
    events: [
      shiftEvent(wave, { tz: TZ, appUrl: 'https://base.example.org/shifts/1' }),
      shiftEvent({ ...wave, starts_at: '2026-11-01T13:30:00Z', ends_at: '2026-11-01T15:30:00Z' }, { tz: TZ }),
      shiftEvent({ ...wave, starts_at: '2026-03-01T14:30:00Z', ends_at: '2026-03-01T16:30:00Z' }, { tz: TZ }),
      dayEvent({ uid: 'vote-2026-10-17@base.win', title: 'Election day', day: '2026-10-17' }),
    ],
  });
  // 6:30 am on Mar 1 (still PST, UTC-8) is 14:30 UTC.
  assert.match(s, /DTSTART:20260301T143000Z/);
  assert.match(unfold(s), /Sunday\\, March 1\\, 6:30 – 8:30 a\.m\./);
  const digest = createHash('sha256').update(s).digest('hex');
  console.log(`# ics digest ${digest} (TZ=${process.env.TZ || 'unset'}, node ${process.version})`);
  if (process.env.ICS_DIGEST) assert.equal(digest, process.env.ICS_DIGEST);
});
