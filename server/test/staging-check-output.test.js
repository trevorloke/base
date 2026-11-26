// The daily staging check posts its output to a public Actions log and a
// public GitHub issue. So what it prints says what kind of thing it found
// and where, never the thing itself: a phone number, an email address or
// the text around a listed name that a demo visitor typed stays on staging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { wrongIn, findReal } from './real-names.js';

// Made-up for this test, but in the shapes the check must not repeat.
const PHONE = '250-387-1715';
const EMAIL = 'jo.visitor@gmail.com';
const NEARBY = 'lives at 77 Quiet Lane';
const person = { first_name: 'Jo', phone: PHONE, email: EMAIL, notes: `Simon Fraser ${NEARBY}` };

test('wrongIn says the kind and where, never the value', () => {
  const lines = wrongIn('GET /api/persons', JSON.stringify({ persons: [person, { phone: '250-387-1716' }] }), { json: true });
  const all = lines.join('\n');
  for (const secret of [PHONE, '250-387-1716', EMAIL, 'jo.visitor', NEARBY, 'Quiet Lane']) assert.ok(!all.includes(secret), `not printed: ${secret}`);
  assert.ok(lines.includes('GET /api/persons: 2 phone numbers outside 604-555-01xx'), all);
  assert.ok(lines.includes('GET /api/persons: 1 email outside example.org, example.com and base.win'), all);
  assert.ok(lines.includes('GET /api/persons: a listed real name, “Simon Fraser”'), all);
  // The made-up range and addresses are still fine, and findReal still
  // gives the text around a name for a test's own message.
  assert.deepEqual(wrongIn('x', JSON.stringify({ phone: '604-555-0123', email: 'a@example.org' }), { json: true }), []);
  assert.match(findReal(`x Simon Fraser ${NEARBY}`)[0].near, /Quiet Lane/);
});

// A stand-in staging: the demo's door works, and every read holds a
// visitor's real-looking details, in its fields' names and on its scale too.
const fakeStaging = (doorWorks = true) => createServer((req, res) => {
  const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  const path = req.url.split('?')[0];
  if (path === '/api/auth/demo') {
    if (!doorWorks) return send(500, { error: `could not sign in ${EMAIL} ${PHONE}` });
    return send(302, {}, { location: '/', 'set-cookie': 'sid=fake; Path=/' });
  }
  if (path === '/api/health') return send(200, { env: 'staging', commit: 'abc' });
  if (path === '/api/scale') return send(200, { scale: { candidates: [{ name: `Jo ${NEARBY}` }] } });
  if (path === '/api/fields') return send(200, { fields: [{ name: `jo ${EMAIL}` }] });
  if (path === '/api/persons') return send(200, { persons: [person] });
  return send(200, { item: person });
});

const runCheck = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    const script = fileURLToPath(new URL('../../scripts/staging-check.mjs', import.meta.url));
    execFile(process.execPath, [script, `http://127.0.0.1:${port}`], { timeout: 60_000, env: { ...process.env, STAGING_TEST_KEYS: '' } }, (err, stdout, stderr) => {
      server.close();
      resolve({ code: err?.code ?? 0, out: `${stdout}${stderr}` });
    });
  });
});

for (const doorWorks of [true, false]) {
  test(`scripts/staging-check.mjs prints no value a visitor typed (${doorWorks ? 'the walk' : 'the door fails'})`, async () => {
    const { code, out } = await runCheck(fakeStaging(doorWorks));
    assert.equal(code, 1, 'it fails');
    assert.match(out, /FAIL {2}/);
    for (const secret of [PHONE, EMAIL, 'jo.visitor', NEARBY, 'Quiet Lane']) assert.ok(!out.includes(secret), `not printed: ${secret}\n${out.slice(0, 2000)}`);
    if (doorWorks) assert.match(out, /phone number outside 604-555-01xx/);
    else assert.match(out, /the demo’s door answered 500/);
  });
}
