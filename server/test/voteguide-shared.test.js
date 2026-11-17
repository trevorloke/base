// The voter guide's shared logic (shared/voteguide.js): its states by the
// server's moments, places open and closed for one day, the nearest places,
// the near-a-voting-place check, words for hours and days in any process
// zone, the import's reader, the QR code's longest link, and no facts
// shipped in the product. No database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  guideState, placesOpen, nearest, nearVotingPlace, distanceWords, hoursWords, dayWords, timeWords,
  parsePlaces, DAYS_PROBLEM, openNow, dayParts, dateWordsFor, seedDateWords,
} from '../../shared/voteguide.js';
import { atLocal, localDay } from '../lib/tzrule.js';
import * as sharedQr from '../../shared/qr.js';
import * as libQr from '../lib/qr.js';

// A made-up guide: two advance days and a general day, 08:00–20:00.
const DAYS = [['2027-10-06', 'advance'], ['2027-10-09', 'advance'], ['2027-10-16', 'general']];
const at = (d, hm) => atLocal(d, hm, 'America/Vancouver');
const dayRow = ([day, kind], opens = '08:00', closes = '20:00') => ({
  day, kind, opens, closes, startsAt: at(day, '00:00'), opensAt: at(day, opens), closesAt: at(day, closes), endsAt: at(day, '00:00') + 24 * 3600e3,
});
const timesAt = (now, days = DAYS.map((d) => dayRow(d))) => ({
  status: 'published', days, bannerFrom: days[0].startsAt - 7 * 24 * 3600e3,
  today: localDay(now), todayEndsAt: at(localDay(now), '00:00') + 24 * 3600e3,
});
const placeRow = (id, lat, lng, extra = {}) => ({
  id, name: `Place ${id}`, address: `${id} Example St`, lat, lng, position: Number(id), closed_on: null,
  days: DAYS.map(([day]) => ({ day, opens: '08:00', closes: '20:00', opensAt: at(day, '08:00'), closesAt: at(day, '20:00') })),
  ...extra,
});
const S = 1000;

test('guideState: every state at its edges, and the next boundary', () => {
  const d1 = '2027-10-06';
  const cases = [
    [at(d1, '07:59') + 59 * S, 'before'],
    [at(d1, '08:00'), 'open'],
    [at(d1, '19:59') + 59 * S, 'open'],
    [at(d1, '20:00'), 'between'],
    [at('2027-10-07', '00:00'), 'between'],
    [at('2027-10-09', '07:00'), 'between'],
    [at('2027-10-16', '20:00'), 'over'],
    [at('2027-10-20', '12:00'), 'over'],
  ];
  for (const [now, want] of cases) {
    const st = guideState(timesAt(now), now);
    assert.equal(st.state, want, new Date(now).toISOString());
    assert.ok(st.boundary > now && st.boundary <= now + 24 * 3600e3, 'the boundary is ahead, within a day');
  }
  const open = guideState(timesAt(at(d1, '10:00')), at(d1, '10:00'));
  assert.equal(open.boundary, at(d1, '20:00'), 'open: the next change is the close');
  assert.equal(open.closesAt, at(d1, '20:00'));
  assert.equal(open.day, d1);
  const morning = guideState(timesAt(at('2027-10-09', '07:00')), at('2027-10-09', '07:00'));
  assert.equal(morning.next.day, '2027-10-09', 'between, a voting day later today');
  assert.equal(morning.boundary, at('2027-10-09', '08:00'));
  const before = guideState(timesAt(at('2027-09-20', '12:00')), at('2027-09-20', '12:00'));
  assert.equal(before.state, 'before');
  assert.ok(before.boundary <= at('2027-09-20', '12:00') + 24 * 3600e3, 'never more than a day ahead');
  assert.equal(guideState({ ...timesAt(0), status: 'draft' }, 0).state, 'not_out');
  assert.equal(guideState({ status: 'published', days: [] }, 0).state, 'not_out');
});

test('a place’s own hours win, and its boundary counts', () => {
  const p = placeRow('1', 49.1, -122.8);
  p.days[0] = { ...p.days[0], closes: '16:00', closesAt: at('2027-10-06', '16:00') };
  const now = at('2027-10-06', '15:00');
  assert.equal(guideState(timesAt(now), now, [p]).boundary, at('2027-10-06', '16:00'));
  assert.equal(openNow(p, now), true);
  assert.equal(openNow(p, at('2027-10-06', '17:00')), false, 'closed after its own hours though the day is open');
});

test('closed for one day: closed on D, open by its hours on D+1', () => {
  const p = placeRow('1', 49.1, -122.8, { closed_on: '2027-10-06' });
  const d1 = at('2027-10-06', '10:00');
  const d2 = at('2027-10-09', '10:00');
  assert.equal(placesOpen([p], d1, '2027-10-06')[0].closedToday, true);
  assert.equal(placesOpen([p], d1, '2027-10-06')[0].openNow, false);
  const next = placesOpen([p], d2, '2027-10-09')[0];
  assert.equal(next.closedToday, false, 'the switch left on after advance day 1 doesn’t close it on day 2');
  assert.equal(next.openNow, true);
});

test('nearest: open today first, no pin left out, ties by position; distance words', () => {
  const now = at('2027-10-06', '10:00');
  const here = { lat: 49.1, lng: -122.8 };
  const places = [
    placeRow('1', 49.1001, -122.8, { closed_on: '2027-10-06' }),
    placeRow('2', 49.102, -122.8),
    placeRow('3', null, null),
    placeRow('5', 49.12, -122.8),
    placeRow('4', 49.12, -122.8),
  ];
  const got = nearest(places, here, 3, timesAt(now), now);
  assert.deepEqual(got.map((p) => p.id), ['2', '4', '5'], 'open today, nearer first, ties by position');
  assert.ok(!nearest(places, here, 5, timesAt(now), now).some((p) => p.id === '3'), 'no pin: left out');
  assert.equal(nearest(places, here, 5, timesAt(now), now).at(-1).id, '1', 'closed today: after the open ones');
  assert.deepEqual([999, 1000, 9900, 10000, 350, 14200].map(distanceWords), ['999 m', '1.0 km', '9.9 km', '10 km', '350 m', '14 km']);
});

test('nearVotingPlace: 80 m yes, 160 m no; closed today, out of hours or no pin no; closed yesterday yes', () => {
  const now = at('2027-10-09', '10:00');
  const lat = 49.1;
  const m = (metres) => ({ lat: lat + metres / 111_195, lng: -122.8 });
  const p = placeRow('1', lat, -122.8);
  assert.equal(nearVotingPlace([p], m(80), now)?.id, '1');
  assert.equal(nearVotingPlace([p], m(160), now), null);
  assert.equal(nearVotingPlace([{ ...p, closed_on: '2027-10-09' }], m(80), now), null);
  assert.equal(nearVotingPlace([p], m(80), at('2027-10-09', '20:30')), null, 'after its hours');
  assert.equal(nearVotingPlace([{ ...p, lat: null, lng: null }], m(80), now), null);
  assert.equal(nearVotingPlace([{ ...p, closed_on: '2027-10-06' }], m(80), now)?.id, '1', 'closed yesterday, open now');
});

test('hours and days in words, in any process zone, in English, Punjabi and Chinese', () => {
  for (const tz of ['America/Vancouver', 'Asia/Kolkata', 'Pacific/Kiritimati']) {
    process.env.TZ = tz;
    assert.equal(hoursWords('08:00', '20:00', 'en'), '8 a.m.–8 p.m.');
    assert.equal(dayWords('2027-10-16', 'en'), 'Sat, Oct 16');
  }
  delete process.env.TZ;
  assert.equal(timeWords('20:30', 'en'), '8:30 p.m.');
  assert.match(hoursWords('08:00', '20:00', 'pa'), /8.*–.*8/);
  assert.match(dayWords('2027-10-16', 'pa'), /16/);
  assert.match(hoursWords('08:00', '20:00', 'zh-Hans'), /8.*–.*20|8.*–.*8/);
  assert.match(dayWords('2027-10-16', 'zh-Hans'), /10月16日/);
  assert.match(dayWords('2027-10-16', 'zh-Hant'), /10月16日/);
});

test('parsePlaces: header or not, tabs, quoted commas, days in every form, yes/no, problems', () => {
  const days = DAYS.map(([day, kind]) => ({ day, kind }));
  const csv = 'Name,Address,Days,Accessible,Curbside,Area,ID\n'
    + '"Example Community Hall, Main Room","100 Example Ave",Oct 6;October 9,yes,n,Newton,A1\n'
    + 'Sample Secondary School,200 Sample St,Advance,,x,Fleetwood,A2\n'
    + 'Example Library,300 Example Rd,Election day,no,,,\n'
    + 'Example Arena,400 Example Blvd,All,,,,\n'
    + 'Example Church,500 Example Way,,,,,\n'
    + 'Bad Day Hall,600 Example Way,next tuesday,,,,\n'
    + 'Iso Hall,700 Example Way,2027-10-16,,,,\n'
    + 'No Address Hall,,,,,,\n';
  const r = parsePlaces(csv, days);
  assert.equal(r.header, true);
  const [a, b, c, d, e, f, g, h] = r.rows;
  assert.equal(a.name, 'Example Community Hall, Main Room', 'a comma inside quotes stays');
  assert.deepEqual(a.days, ['2027-10-06', '2027-10-09']);
  assert.equal(a.accessible, true);
  assert.equal(a.curbside, false);
  assert.equal(a.area, 'Newton');
  assert.equal(a.external_id, 'A1');
  assert.deepEqual(b.days, ['2027-10-06', '2027-10-09']);
  assert.equal(b.accessible, null);
  assert.equal(b.curbside, true);
  assert.deepEqual(c.days, ['2027-10-16']);
  assert.equal(c.accessible, false);
  assert.deepEqual(d.days, ['2027-10-06', '2027-10-09', '2027-10-16']);
  assert.equal(e.days, null, 'empty: every listed day');
  assert.equal(f.problem, 'Use dates like YYYY-MM-DD or Oct 19, or Advance, Election day or All');
  assert.equal(f.problem, DAYS_PROBLEM);
  assert.deepEqual(g.days, ['2027-10-16']);
  assert.equal(h.problem, 'No address');
  assert.equal(parsePlaces('Example Hall,100 Example Ave,Oct 30', days).rows[0].problem, DAYS_PROBLEM, 'a month day the guide doesn’t list');

  const tabs = parsePlaces('Example Hall\t100 Example Ave\tOct 6\tyes\nSample School\t200 Sample St\t\t', days);
  assert.equal(tabs.header, false, 'no header: name, address, days, accessible');
  assert.equal(tabs.rows[0].address, '100 Example Ave');
  assert.deepEqual(tabs.rows[0].days, ['2027-10-06']);
  assert.equal(tabs.rows[0].accessible, true);
  assert.equal(tabs.rows[1].days, null);
  const lines = parsePlaces('Example Hall, 100 Example Ave\nSample School, 200 Sample St', days);
  assert.equal(lines.rows.length, 2);
  assert.equal(lines.rows[1].address, '200 Sample St');

  const many = Array.from({ length: 301 }, (_, i) => `Hall ${i},${i} Example Ave`).join('\n');
  const over = parsePlaces(many, days);
  assert.ok(over.error, '301 rows refused');
  assert.equal(over.rows.length, 0);
  assert.equal(parsePlaces(many.split('\n').slice(0, 300).join('\n'), days).rows.length, 300);
});

test('shared/qr.js encodes the longest guide link; lib/qr.js re-exports it', () => {
  const link = `https://${'a'.repeat(59)}.org${'/' + 'b'.repeat(29)}/site/zh-hant/${'c'.repeat(60)}?near=-90.00,-180.00`;
  assert.equal(new TextEncoder().encode(link).length, 195);
  const m = sharedQr.qrMatrix(link);
  assert.ok(Array.isArray(m) && m.length >= 21);
  assert.equal(libQr.qrMatrix, sharedQr.qrMatrix);
  assert.equal(libQr.qrSvgPath, sharedQr.qrSvgPath);
});

test('no facts shipped: no dates, places, names or claims in the product’s own files; empty defaults', () => {
  const files = ['../../shared/voteguide.js', '../../shared/site/catalogue.js', '../../shared/site/ui-words.js', '../ext/voteguide/sql.js', '../ext/site/seeds/imagine-surrey.js', '../ext/site/seeds/base.js'];
  for (const f of files) {
    let src;
    try { src = readFileSync(new URL(f, import.meta.url), 'utf8'); } catch { continue; }
    const guide = f.includes('catalogue') ? src.slice(src.indexOf("kind: 'voterguide'"), src.indexOf("kind: 'voterguide'") + 1200)
      : f.includes('seeds') ? (src.includes('voterguide') ? src : '') : src;
    if (!guide) continue;
    assert.doesNotMatch(guide, /\b20\d\d-\d\d-\d\d\b/, `${f}: a date`);
    assert.doesNotMatch(guide, /surrey/i, `${f}: Surrey`);
    assert.doesNotMatch(guide, /\b\d{3,5} \d{1,3}(?:st|nd|rd|th)? (?:Ave|St|Avenue|Street)\b/, `${f}: a street address`);
    assert.doesNotMatch(guide, /voter card|printed in english/i, `${f}: a claim about voting`);
  }
  const sql = readFileSync(new URL('../ext/voteguide/sql.js', import.meta.url), 'utf8');
  assert.match(sql, /vote_anywhere boolean,/, 'vote_anywhere has no default: not said yet');
  assert.match(sql, /ballot_note text not null default ''/);
});

test('the island flips from open to over at the server’s 20:00, whatever the process zone and its rules', async () => {
  const { renderToString } = await import('react-dom/server');
  const { createElement } = await import('react');
  const { VoteGuide } = await import('../../shared/site/components/voteguide-island.js');
  const lastClose = at('2027-10-16', '20:00');
  const props = (now) => ({
    uid: 't', title: 'How to vote', now, clockUrl: '/c', findUrl: '/f',
    guide: { times: { ...timesAt(now), status: 'published' }, places: [placeRow('1', 49.1, -122.8)], areas: [], contests: [] },
  });
  const Real = Intl.DateTimeFormat;
  process.env.TZ = 'America/Los_Angeles';
  // A stale copy of the rules on this machine: an hour off after Nov 1, 2026.
  Intl.DateTimeFormat = function Stale(locale, opts = {}) {
    const real = new Real(locale, opts);
    if (opts.timeZone === 'UTC' || !opts.timeZone) return real;
    const shifted = new Real(locale, { ...opts, timeZone: 'Etc/GMT+8' });
    return shifted;
  };
  try {
    assert.match(renderToString(createElement(VoteGuide, props(lastClose - 1))), /Voting is open now · until <span class="vg-keep">8 p\.m\.<\/span>/, 'the hour kept on one line');
    assert.match(renderToString(createElement(VoteGuide, props(lastClose))), /Voting is over\. Thank you for voting\./);
  } finally {
    Intl.DateTimeFormat = Real;
    delete process.env.TZ;
  }
});

test('a browser without Punjabi dates draws the server’s words, not "M11 20"', async () => {
  const { renderToString } = await import('react-dom/server');
  const { createElement } = await import('react');
  const { VoteGuide } = await import('../../shared/site/components/voteguide-island.js');
  const now = at('2027-10-06', '10:00');
  const guide = { times: { ...timesAt(now), status: 'published' }, places: [placeRow('1', 49.1, -122.8)], areas: [], contests: [] };
  const words = dateWordsFor(guide, 'pa');
  assert.ok(words['w:2027-10-06'] && words['d:2027-10-06'] && words['t:20:00'], 'every day and hour is drawn');
  assert.doesNotMatch(Object.values(words).join(' '), /\bM\d/, 'full ICU here');
  // A trimmed ICU: Punjabi falls back to "M10 6, Wed".
  const Real = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function Trimmed(locale, opts = {}) {
    if (String(locale).startsWith('pa')) return { format: (d) => `M${d.getUTCMonth() + 1} ${d.getUTCDate()}` };
    return new Real(locale, opts);
  };
  try {
    const html = renderToString(createElement(VoteGuide, { uid: 'p', title: 'x', now, lang: 'pa', clockUrl: '/c', findUrl: '/f', guide, dateWords: words }));
    assert.doesNotMatch(html, /M10 6/, 'never the fallback month');
    assert.ok(html.includes(words['d:2027-10-06']), 'the server’s date');
    assert.equal(dayParts('2027-10-06', 'pa').date, words['d:2027-10-06']);
    seedDateWords('pa', { 'd:2027-12-25': 'X' });
    assert.equal(dayParts('2027-12-25', 'pa').date, 'X');
  } finally {
    Intl.DateTimeFormat = Real;
  }
});
