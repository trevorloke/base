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

test('T2. every row that carries the line asks the rule for it in one of its hooks', () => {
  for (const id of CHANNEL_IDS) {
    const c = CHANNELS[id];
    if (c.include !== 'when-set' && c.include !== 'first-text') continue;
    const q = id.replace(/[-]/g, '\\-');
    const re = new RegExp(`authorized(?:Line|Of)\\([^)]*channel:[^,}]*'${q}'|footOf\\([^)]*'${q}'`);
    const hits = c.hooks.filter((f) => sources[f] !== undefined && re.test(noComments(sources[f])));
    assert.ok(hits.length > 0, `${id}: none of ${c.hooks.join(', ')} calls authorizedLine/authorizedOf({ channel: '${id}' }) or footOf(…, '${id}')`);
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
  assert.doesNotMatch(doc, /starbase/i);
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
