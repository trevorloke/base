// Sign-in: all three right or the same answer; limits per address (the
// rightmost forwarded entry) and per email; a code works once; recovery
// codes; wrong codes count only after a right password; the session's
// cookie and its idle and absolute ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, browser, setUp, codeNow, baseEnv, EMAIL, PASSWORD } from './helpers.mjs';
import { makeApp } from '../server.mjs';
import { knownDevice, deviceToken, getOperator } from '../ops-auth.mjs';

baseEnv();
const { app, db } = await freshApp();
const op = await setUp(app, db);
// A new app on the same database: limits start again (they live in the process).
const again = () => makeApp({ db });

const bodyOf = async (res) => (await res.text()).replace(/value="[^"]*"/g, '');

test('a wrong email, password or code gives the same answer', async () => {
  const a = again();
  const code = await codeNow(db, op.secret);
  const answers = [];
  for (const f of [
    { email: 'someone@example.org', password: PASSWORD, code },
    { email: EMAIL, password: 'wrong password here', code },
    { email: EMAIL, password: PASSWORD, code: '000000' },
  ]) {
    const res = await browser(a, { ip: `198.51.100.${answers.length + 1}` }).post('/signin', f);
    assert.equal(res.status, 401);
    answers.push(await bodyOf(res));
  }
  assert.match(answers[0], /That doesn’t match\. Check all three\./);
  assert.equal(answers[1], answers[0]);
  assert.equal(answers[2], answers[0]);
});

test('the 6th try for one email is limited, from any address', async () => {
  const a = again();
  for (let i = 0; i < 5; i++) assert.equal((await browser(a, { ip: `192.0.2.${i}` }).post('/signin', { email: 'Owner@Example.org ', password: 'x', code: '1' })).status, 401);
  const sixth = await browser(a, { ip: '192.0.2.99' }).post('/signin', { email: EMAIL, password: PASSWORD, code: await codeNow(db, op.secret) });
  assert.equal(sixth.status, 429);
  assert.match(await sixth.text(), /Too many tries — wait 15 minutes\./);
});

test('a browser that has signed in here is not kept out by a stranger spending the email limit; a new or forged one is', async () => {
  const a = again();
  const mark = op.b.jar.get('ops-device');
  assert.match(mark, /^v2\./, 'setup leaves the device mark');
  for (let i = 0; i < 6; i++) await browser(a, { ip: `198.51.100.${60 + i}` }).post('/signin', { email: ` ${EMAIL.toUpperCase()}`, password: 'x', code: '1' });
  const stranger = await browser(a, { ip: '198.51.100.90' }).post('/signin', { email: EMAIL, password: PASSWORD, code: await codeNow(db, op.secret) });
  assert.equal(stranger.status, 429, 'a browser never signed in here: the email limit holds');
  const forged = browser(a, { ip: '198.51.100.91' });
  forged.jar.set('ops-device', `${mark.slice(0, -4)}AAAA`);
  assert.equal((await forged.post('/signin', { email: EMAIL, password: PASSWORD, code: await codeNow(db, op.secret) })).status, 429, 'a forged mark is no mark');
  const known = browser(a, { ip: '198.51.100.92' });
  known.jar.set('ops-device', mark);
  const res = await known.post('/signin', { email: EMAIL, password: PASSWORD, code: await codeNow(db, op.secret) });
  assert.equal(res.status, 303, 'the owner, from a browser signed in before, still gets in');
  const line = res.headers.getSetCookie().find((l) => l.startsWith('ops-device='));
  for (const part of ['Max-Age=7776000', 'Path=/', 'HttpOnly', 'SameSite=Strict']) assert.ok(line.includes(part), part);
  // Still all three: a known browser with a wrong code is refused as ever.
  assert.equal((await known.post('/signin', { email: EMAIL, password: 'wrong password here', code: '000000' })).status, 401);
});

test('a device mark has one form: no leading zero, no extra field', async () => {
  const mark = op.b.jar.get('ops-device');
  assert.equal(await knownDevice(db, mark), true);
  const [v, id, issued, mac] = mark.split('.');
  assert.equal(await knownDevice(db, [v, id, `0${issued}`, mac].join('.')), false, 'a leading zero');
  assert.equal(await knownDevice(db, `${mark}.anything`), false, 'a fifth field');
  assert.equal(await knownDevice(db, `${mark}.`), false);
});

test('with OPS_SECRET unusable no mark is made or taken (its key would be public)', async () => {
  const mark = op.b.jar.get('ops-device');
  const saved = process.env.OPS_SECRET;
  try {
    for (const secret of ['', 'short-secret']) {
      process.env.OPS_SECRET = secret;
      assert.equal(deviceToken(await getOperator(db)), null, `no mark with OPS_SECRET ${JSON.stringify(secret)}`);
      assert.equal(await knownDevice(db, mark), false);
      // A mark forged from a copy of the operators row under the empty key: no mark.
      const forged = deviceToken({ ...(await getOperator(db)) });
      assert.equal(forged, null);
    }
  } finally { process.env.OPS_SECRET = saved; }
  assert.equal(await knownDevice(db, mark), true);
});

test('the address limit keys on the rightmost forwarded entry: a forged leftmost one doesn’t escape it', async () => {
  const a = again();
  for (let i = 0; i < 20; i++) {
    const res = await a.request(`http://${process.env.OPS_HOST}/signin`, {
      method: 'POST',
      headers: { origin: `http://${process.env.OPS_HOST}`, 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': `10.9.9.${i}, 203.0.113.50` },
      body: new URLSearchParams({ email: `p${i}@example.org`, password: 'x', code: '1' }).toString(),
    });
    assert.equal(res.status, 401);
  }
  const res = await browser(a, { ip: '10.0.0.1, 203.0.113.50' }).post('/signin', { email: 'q@example.org', password: 'x', code: '1' });
  assert.equal(res.status, 429);
});

test('a code from the app works once', async () => {
  const a = again();
  const code = await codeNow(db, op.secret);
  assert.equal((await browser(a).post('/signin', { email: EMAIL, password: PASSWORD, code })).status, 303);
  assert.equal((await browser(a).post('/signin', { email: EMAIL, password: PASSWORD, code })).status, 401);
});

test('a recovery code works once and is logged with how many are left', async () => {
  const a = again();
  const [code] = op.codes;
  const mark = op.b.jar.get('ops-device');
  assert.equal(await knownDevice(db, mark), true);
  const rb = browser(a, { ip: '192.0.2.10' });
  assert.equal((await rb.post('/signin', { email: EMAIL, password: PASSWORD, code: code.toUpperCase() })).status, 303);
  // A recovery code means a lost phone, maybe a lost laptop: every other browser is forgotten.
  assert.equal(await knownDevice(db, mark), false, 'the earlier mark is forgotten');
  assert.equal(await knownDevice(db, rb.jar.get('ops-device')), true, 'this browser gets a new one');
  assert.equal((await browser(a, { ip: '192.0.2.11' }).post('/signin', { email: EMAIL, password: PASSWORD, code })).status, 401);
  const used = (await db.query("select payload from ops_log where action = 'recovery.used'")).rows;
  assert.deepEqual(used.map((r) => r.payload), [{ left: 9 }]);
});

test('20 wrong passwords leave the count alone; 20 wrong codes after a right password lock app codes until a recovery code', async () => {
  await db.query('update operators set fails = 0');
  const before = browser(again());
  assert.equal((await before.post('/signin', { email: EMAIL, password: PASSWORD, code: await codeNow(db, op.secret) })).status, 303);
  const mark = before.jar.get('ops-device');
  for (let i = 0; i < 20; i++) {
    await browser(again(), { ip: `192.0.2.${100 + i}` }).post('/signin', { email: EMAIL, password: 'not the password', code: '123456' });
  }
  assert.equal((await db.query('select fails from operators')).rows[0].fails, 0);
  for (let i = 0; i < 20; i++) {
    const res = await browser(again(), { ip: `192.0.2.${150 + i}` }).post('/signin', { email: EMAIL, password: PASSWORD, code: '000000' });
    assert.equal(res.status, 401);
  }
  assert.equal((await db.query('select fails from operators')).rows[0].fails, 20);
  assert.equal((await db.query("select count(*)::int n from ops_log where action = 'signin.locked'")).rows[0].n, 1);
  assert.equal(await knownDevice(db, mark), false, 'the lock forgets every browser');
  const right = await browser(again()).post('/signin', { email: EMAIL, password: PASSWORD, code: await codeNow(db, op.secret) });
  assert.equal(right.status, 401, 'a right app code is refused while locked');
  assert.equal((await browser(again()).post('/signin', { email: EMAIL, password: PASSWORD, code: op.codes[1] })).status, 303);
  assert.equal((await db.query('select fails from operators')).rows[0].fails, 0);
  assert.equal((await browser(again()).post('/signin', { email: EMAIL, password: PASSWORD, code: await codeNow(db, op.secret) })).status, 303);
});

test('the session cookie: __Host-, Secure, HttpOnly, SameSite=Strict, Path=/, 12 hours; insecure mode for tests only drops the first two', async () => {
  process.env.OPS_INSECURE_COOKIES = '0';
  const res = await browser(again()).post('/signin', { email: EMAIL, password: PASSWORD, code: await codeNow(db, op.secret) }, { headers: { origin: `https://${process.env.OPS_HOST}` } });
  assert.equal(res.status, 303);
  const line = res.headers.getSetCookie().find((l) => l.startsWith('__Host-ops='));
  assert.ok(line, 'named __Host-ops');
  for (const part of ['Max-Age=43200', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(line.includes(part), part);
  baseEnv();
  const plain = await browser(again()).post('/signin', { email: EMAIL, password: PASSWORD, code: await codeNow(db, op.secret) });
  const l2 = plain.headers.getSetCookie().find((l) => l.startsWith('ops='));
  assert.ok(l2 && !l2.includes('Secure'));
  assert.ok((await db.query("select count(*)::int n from ops_log where action = 'signin'")).rows[0].n >= 1);
});

test('a session ends after 30 minutes idle, at 12 hours whatever, and on sign out', async () => {
  await db.query('delete from ops_sessions');
  const signedIn = async () => {
    const b = browser(again());
    await b.post('/signin', { email: EMAIL, password: PASSWORD, code: await codeNow(db, op.secret) });
    assert.equal((await b.get('/')).status, 200);
    return b;
  };
  const idle = await signedIn();
  await db.query("update ops_sessions set last_seen_at = now() - interval '31 minutes'");
  assert.equal((await idle.get('/')).headers.get('location'), '/signin');
  const old = await signedIn();
  await db.query("update ops_sessions set created_at = now() - interval '12 hours', expires_at = now() - interval '1 second'");
  assert.equal((await old.get('/')).headers.get('location'), '/signin');
  const out = await signedIn();
  await db.query("update ops_sessions set last_seen_at = now() - interval '5 minutes'");
  assert.equal((await out.get('/')).status, 200, 'a request keeps it alive');
  assert.equal((await db.query("select count(*)::int n from ops_sessions where last_seen_at > now() - interval '1 minute'")).rows[0].n, 1);
  assert.equal((await out.post('/signout', {})).headers.get('location'), '/signin');
  assert.equal((await out.get('/')).headers.get('location'), '/signin');
  assert.equal((await db.query("select count(*)::int n from ops_sessions where last_seen_at > now() - interval '30 minutes' and expires_at > now()")).rows[0].n, 0, 'its row is gone');
});

test('signed out, every page goes to sign in', async () => {
  for (const path of ['/', '/log', '/key', '/c/sample']) assert.equal((await browser(app).get(path)).headers.get('location'), '/signin');
  assert.equal((await browser(app).post('/c/sample/check-now', {})).headers.get('location'), '/signin');
});
