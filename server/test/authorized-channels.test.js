// The "Authorized by" rule's structural guard (shared/site/authorized.js
// CHANNELS): every file that sends a message or draws a public page is in
// a row of the table, every row that carries the line really asks the rule
// for it, no file writes the line by its own formula, and the table is
// well formed. A new email, text or page path without a row fails here
// with the file's name and what to do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANNELS, CHANNEL_IDS, DELIVERY, FORMS, INCLUDES, KINDS, OWNER_ROWS } from '../../shared/site/authorized.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WALK = ['server', 'shared', 'apps/platform'];
const SKIP = new Set(['node_modules', 'test', 'dist', 'data', '.git']);
const CODE = /\.(m?js|jsx)$/;

const walk = async (dir, out = []) => {
  for (const e of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) await walk(p, out);
    else if (CODE.test(e.name)) out.push(p);
  }
  return out;
};
// The code alone: comments and quoted strings out ('mod.eventsCalendar' is
// a word key, not a call), template literals kept (a page's <${EmbedView}>).
const noComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
const codeOf = (src) => noComments(src)
  .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''");

// The low-level senders and page drawers.
const SENDERS = ['sendEmail', 'sendSms', 'sendText', 'deliverTexts', 'sendUrl', 'plainPage', 'renderSite', 'EmbedView', 'eventsCalendar', 'ShareSheet'];
const SENDER_RE = new RegExp(`\\b(${SENDERS.join('|')})\\b`);

const files = await walk('server').then(async (a) => [...a, ...await walk('shared'), ...(existsSync(join(ROOT, 'apps/platform')) ? await walk('apps/platform') : [])]);
const sources = Object.fromEntries(await Promise.all(files.map(async (f) => [f, await readFile(join(ROOT, f), 'utf8')])));
const usesSender = (f) => SENDER_RE.test(codeOf(sources[f]));

test('T1. every file that sends a message or draws a public page is in CHANNELS', () => {
  const importers = files.filter(usesSender).filter((f) => !DELIVERY.includes(f));
  const listed = new Set(CHANNEL_IDS.flatMap((id) => CHANNELS[id].senders));
  const missing = importers.filter((f) => !listed.has(f));
  assert.deepEqual(missing, [], missing.map((f) => `${f} sends messages but is not in CHANNELS (shared/site/authorized.js). Add it with kind advertising/unclear/transactional/internal/outside.`).join('\n'));
  // Walked where the rule says (server, shared, the control centre).
  assert.ok(WALK.every((d) => files.some((f) => f.startsWith(`${d}/`)) || !existsSync(join(ROOT, d))));
});

test('T1. every senders file in CHANNELS really sends (or draws), and the delivery code is there', () => {
  for (const id of CHANNEL_IDS) {
    for (const f of CHANNELS[id].senders) {
      assert.ok(sources[f] !== undefined, `${id}: ${f} is not a file under ${WALK.join(', ')}`);
      assert.ok(usesSender(f), `${id}: ${f} is listed as a sender but uses none of ${SENDERS.join(', ')}`);
    }
  }
  for (const f of DELIVERY) assert.ok(sources[f] !== undefined, `${f} (DELIVERY) is not there`);
});

// A file asks the rule for a channel's line by name.
const asksFor = (f, id) => {
  const q = id.replace(/[-]/g, '\\-');
  const re = new RegExp(`authorized(?:Line|Of)\\([^)]*channel:[^,}]*'${q}'|footOf\\([^)]*'${q}'`);
  return sources[f] !== undefined && re.test(noComments(sources[f]));
};
const carries = (c) => c.include === 'when-set' || c.include === 'first-text';

test('T2. every row that carries the line asks the rule for it in one of its hooks', () => {
  for (const id of CHANNEL_IDS) {
    const c = CHANNELS[id];
    if (!carries(c)) continue;
    const hits = c.hooks.filter((f) => asksFor(f, id));
    assert.ok(hits.length > 0, `${id}: none of ${c.hooks.join(', ')} calls authorizedLine/authorizedOf({ channel: '${id}' }) or footOf(…, '${id}')`);
  }
});

// The relative imports of each file (server, shared and the control centre),
// read from the lines that start with import/export (a comment's '/*' can't
// hide one).
const importsOf = (f) => {
  const out = [];
  for (const m of (sources[f] || '').matchAll(/^[ \t]*(?:import|export)\b[^;'"]*?from\s*['"](\.[^'"]+)['"]/gm)) {
    out.push(join(f, '..', m[1]).replace(/\\/g, '/'));
  }
  return out;
};
const reaches = (from, to) => {
  const seen = new Set();
  const go = (f) => {
    if (f === to) return true;
    if (seen.has(f) || sources[f] === undefined) return false;
    seen.add(f);
    return importsOf(f).some(go);
  };
  return go(from);
};

test('T2. every sender of a row that carries the line is tied to the rule: it is a hook that asks, or its `via` names one it imports or is drawn by', () => {
  for (const id of CHANNEL_IDS) {
    const c = CHANNELS[id];
    if (!carries(c)) continue;
    for (const f of c.hooks) {
      // Each hook asks itself, or takes the answer from a hook of the row that does.
      const ok = asksFor(f, id) || c.hooks.some((h) => h !== f && asksFor(h, id) && importsOf(f).includes(h));
      assert.ok(ok, `${id}: the hook ${f} neither asks the rule for '${id}' nor imports a hook that does`);
    }
    for (const f of c.senders) {
      if (c.hooks.includes(f)) continue;
      const via = c.via?.[f];
      assert.ok(via, `${id}: ${f} sends for '${id}' but is not one of its hooks. Ask the rule there (authorizedOf(…, { channel: '${id}' })) and add it to hooks, or name in the row's via the hook its words go through`);
      assert.ok(c.hooks.includes(via), `${id}: via ${f} → ${via}, which is not one of the row's hooks`);
      assert.ok(reaches(f, via) || reaches(via, f), `${id}: ${f} and ${via} (its via) never import one another, so its words can't go through that hook`);
    }
    for (const f of Object.keys(c.via || {})) assert.ok(c.senders.includes(f) && !c.hooks.includes(f), `${id}: via names ${f}, which is not one of its senders (or is a hook already)`);
  }
});

// How many sends and page draws each file makes (each use of a sender or
// drawer above, imports aside). A new send in a file already in a row
// fails here until it is classified: check its row in CHANNELS (and, if
// that row carries the line, that the new send gets it), then set the
// count. The delivery code is not counted.
const SEND_SITES = {
  'server/actions/field.js': 4, // shift (email, text), email-test, account
  'server/ext/abtests/send.js': 2, // email-list/email-press, sms-list (via deliverTexts)
  'server/ext/abtests/winner.js': 1,
  'server/ext/calendar/index.js': 1,
  'server/ext/candidates/actions.js': 1,
  'server/ext/gmail/send.js': 2,
  'server/ext/ladders/engine.js': 5, // email-ladder, sms-ladder, and their notices
  'server/ext/letters/actions.js': 1,
  'server/ext/passwords/reset.js': 1,
  'server/ext/payments/refunds.js': 1,
  'server/ext/receipts/core.js': 2,
  'server/ext/receipts/engine.js': 1,
  'server/ext/schedule/tell.js': 2,
  'server/ext/site/calendar.js': 1,
  'server/ext/site/public.js': 4,
  'server/ext/site/render/index.js': 1,
  'server/ext/texting/actions.js': 1,
  'server/ext/texting/blast.js': 2,
  'server/ext/twostep/locked.js': 2,
  'shared/site/components/form.js': 1,
  'shared/site/components/islands.js': 1,
  'shared/site/components/share.js': 1,
  'shared/site/components/templates.js': 1,
  'shared/site/components/voteguide.js': 1,
};
const SENDER_ALL = new RegExp(SENDER_RE.source, 'g');
const noImports = (code) => code
  .replace(/(^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s*''\s*;?/g, '$1')
  .replace(/(^|\n)\s*export\s*\{[^}]*\}\s*;?/g, '$1');
const sendSites = (f) => (noImports(codeOf(sources[f])).match(SENDER_ALL) || []).length;

test('T1. every send in a file is counted: a new one in a file already listed fails until it is classified', () => {
  const found = Object.fromEntries(files.filter(usesSender).filter((f) => !DELIVERY.includes(f)).map((f) => [f, sendSites(f)]));
  const wrong = Object.keys({ ...found, ...SEND_SITES }).filter((f) => found[f] !== SEND_SITES[f]);
  assert.deepEqual(wrong, [], wrong.map((f) => `${f}: ${found[f] ?? 0} sends or page draws, SEND_SITES says ${SEND_SITES[f] ?? 0}. Classify the new one (its row in shared/site/authorized.js, and the line if that row carries it), then set the count in server/test/authorized-channels.test.js`).join('\n'));
});

// Every row that carries the line is checked by what really goes out: the
// test that sends (or draws) through it with the line set and reads it back.
const BEHAVIOUR = {
  site: ['authorized.test.js', 'the website, plain pages'],
  'site-plain-public': ['site-microsites.test.js', 'a draft says "Coming soon" on its domain, with the authorization line'],
  'site-plain-own': ['authorized.test.js', 'the website, plain pages'],
  embed: ['authorized.test.js', 'T10. the vote guide embed'],
  ics: ['authorized.test.js', 'the calendar file carries it'],
  'share-card': ['authorized.test.js', 'the website, plain pages'],
  'share-sheet': ['authorized.test.js', 'a supporter’s share words carry it'],
  'share-kit': ['authorized.test.js', 'T9. a share kit'],
  'email-list': ['authorized.test.js', 'T12. newsletter, email blast'],
  'email-press': ['authorized.test.js', 'T12. newsletter, email blast, press release'],
  'email-test': ['authorized.test.js', 'T12. newsletter, email blast, press release and the test copy'],
  'email-ladder': ['authorized.test.js', 'T8. a ladder email'],
  'sms-list': ['authorized.test.js', 'T7. a text blast'],
  'sms-ladder': ['authorized.test.js', 'T8. a ladder email: the line, the mailing address and the contact, text only; a ladder text'],
  'sms-one': ['authorized.test.js', 'T11. the first Inbox text'],
  'email-one': ['authorized.test.js', 'Gmail: a staffer’s own email'],
};

test('T2. every row that carries the line has a test that reads it back from what goes out', async () => {
  const carrying = CHANNEL_IDS.filter((id) => carries(CHANNELS[id]));
  assert.deepEqual(carrying.filter((id) => !BEHAVIOUR[id]), [], 'a row that carries the line with no behaviour test: add one (server/test/authorized.test.js) and name it in BEHAVIOUR');
  for (const [id, [file, title]] of Object.entries(BEHAVIOUR)) {
    assert.ok(carrying.includes(id), `BEHAVIOUR names ${id}, which does not carry the line`);
    const src = await readFile(join(ROOT, 'server/test', file), 'utf8');
    assert.ok(src.includes(`test('${title}`), `${id}: server/test/${file} has no test starting '${title}'`);
  }
});

test('T3. no second formula: the line is made only in authorized.js and wording.js', () => {
  const ALLOWED = new Set(['shared/site/authorized.js', 'shared/site/wording.js']);
  const FORMULA = /`Authorized by \$\{|'Authorized by ' *\+|"Authorized by " *\+/;
  const bad = files.filter((f) => !ALLOWED.has(f) && FORMULA.test(noComments(sources[f])));
  assert.deepEqual(bad, [], `the Authorized by line is made by hand in: ${bad.join(', ')} — ask shared/site/authorized.js for it`);
});

test('T4. the table is well formed', () => {
  assert.ok(CHANNEL_IDS.length >= 20);
  for (const id of CHANNEL_IDS) {
    const c = CHANNELS[id];
    assert.ok(KINDS.includes(c.kind), `${id}: kind ${c.kind}`);
    assert.ok(INCLUDES.includes(c.include), `${id}: include ${c.include}`);
    assert.ok(c.form === null || FORMS.includes(c.form), `${id}: form ${c.form}`);
    assert.ok(c.include === 'never' ? c.form === null : c.form !== null, `${id}: a channel that carries the line has a form, one that never does has none`);
    assert.ok(typeof c.what === 'string' && c.what.length > 5, `${id}: what`);
    assert.ok(Array.isArray(c.senders) && Array.isArray(c.hooks), `${id}: senders and hooks`);
    if (c.kind === 'unclear') assert.equal(c.owner, true, `${id}: an unclear row is the owner's to decide`);
    if (c.kind === 'transactional' || c.kind === 'internal') {
      assert.ok(c.include === 'never' || (id === 'email-test' && c.preview === true), `${id}: ${c.kind} never carries the line (a test copy is a preview)`);
    }
    if (c.kind === 'outside') assert.ok(c.include === 'copy' || c.include === 'never', `${id}: base.win doesn't make it`);
  }
  assert.ok(OWNER_ROWS.length >= 7);
});

test('the owner’s list names every owner row (docs/AUTHORIZED.md)', async () => {
  const doc = await readFile(join(ROOT, 'docs/AUTHORIZED.md'), 'utf8');
  for (const id of OWNER_ROWS) assert.ok(doc.includes(`\`${id}\``), `docs/AUTHORIZED.md: the owner's list has no \`${id}\``);
  assert.doesNotMatch(doc, /\b(is|are) (election )?advertising\b/i, 'the guide says what base.win adds it to, never what the law calls it');
});

test('the rule stays pure: the website renderer (bundled into the desk) reaches no server code through it', async () => {
  // Every file reached by import from shared/site/authorized.js and the
  // renderer's context: never node:, never server/ (the desk bundles them:
  // web/src/site-preview.js).
  const seen = new Set();
  const visit = async (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    const src = noComments(await readFile(join(ROOT, f), 'utf8'));
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      assert.ok(!spec.startsWith('node:'), `${f} imports ${spec}`);
      if (!spec.startsWith('.')) continue;
      const next = join(f, '..', spec).replace(/\\/g, '/');
      assert.ok(!next.startsWith('server/'), `${f} imports server code: ${spec}`);
      if (existsSync(join(ROOT, next))) await visit(next);
    }
  };
  await visit('shared/site/authorized.js');
  await visit('shared/site/components/context.js');
  assert.ok(seen.has('shared/site/legal-words.js') && seen.has('shared/site/wording.js'));
});

test('the detectors catch what they look for', () => {
  assert.ok(SENDER_RE.test(codeOf("import { sendText } from '../../lib/notify.js';\nawait sendText({ to, body });")));
  assert.ok(!SENDER_RE.test(codeOf("rc.w('mod.eventsCalendar') // sendEmail later")));
  assert.match("const line = `Authorized by ${name}`;", /`Authorized by \$\{/);
});
