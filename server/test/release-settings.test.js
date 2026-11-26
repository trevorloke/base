// A release never changes a client's settings in Render (GOING-LIVE.md
// section 0). render.yaml is a Blueprint: a sync writes every fixed value in
// it over what the service has. So on a client's service, a setting is
// `sync: false` (set once in Render, kept there), made by Render, or taken
// from its database, unless it is the same on every deployment of that
// service (FIXED_OK in release-safety.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseYaml, settingProblems, explainSettings, kindOf, howSet, FIXED_OK } from './release-safety.js';

const root = new URL('../../', import.meta.url);
const YAML = readFileSync(new URL('render.yaml', root), 'utf8');
const doc = parseYaml(YAML);
const service = (name) => doc.services.find((s) => s.name === name);

test('render.yaml: no client setting is a fixed value a Blueprint sync would write over', () => {
  for (const name of ['base-win-staging', 'base-win', 'base-platform']) assert.ok(service(name), name);
  const problems = settingProblems(doc);
  if (problems.length) assert.fail(explainSettings(problems));
});

test('render.yaml: every client’s service deploys from production by itself, so one Promote updates them all', () => {
  const clients = doc.services.filter((s) => kindOf(s) === 'production');
  assert.ok(clients.length >= 1);
  for (const s of clients) {
    assert.equal(s.branch, 'production', `${s.name} deploys from production`);
    assert.equal(s.autoDeploy, true, `${s.name} deploys when production moves`);
  }
  assert.equal(service('base-win-staging').branch, 'main');
  assert.equal(service('base-win-staging').autoDeploy, true);
  // The control centre's branch moves to production after the next Promote
  // (render.yaml says so beside it); either way it deploys by itself.
  assert.equal(service('base-platform').autoDeploy, true);
});

test('the fixed-value list: each entry has a reason and is used', () => {
  for (const [kind, keys] of Object.entries(FIXED_OK)) {
    const fixed = new Set(doc.services.filter((s) => kindOf(s) === kind)
      .flatMap((s) => (s.envVars || []).filter((v) => howSet(v) === 'fixed').map((v) => v.key)));
    for (const [key, why] of Object.entries(keys)) {
      assert.ok(why.length > 15, `${kind} ${key}: a reason`);
      assert.ok(fixed.has(key), `${kind} ${key} is on the list but render.yaml does not fix it: take it off`);
    }
  }
});

test('a client’s name, brand or map area written as a fixed value is caught, with what to do', () => {
  // A copy of render.yaml with a second client pasted in; nothing on disk changes.
  const copy = YAML.replace('\ndatabases:', `
  - type: web
    name: base-win-riverton
    runtime: docker
    branch: production
    autoDeploy: true
    envVars:
      - key: STARBASE_ENV
        value: production
      - key: DATABASE_URL
        fromDatabase:
          name: base-win-riverton-db
          property: connectionString
      - key: STARBASE_ORG_NAME
        value: "Riverton Forward"   # a client's name
      - key: STARBASE_GEO_BOUNDS
        value: '43.6,-79.7|43.8,-79.4'
      - key: STARBASE_TWO_STEP_KEY
        generateValue: true
      - key: RESEND_API_KEY
        sync: false

databases:`);
  const problems = settingProblems(parseYaml(copy)).filter((p) => p.service === 'base-win-riverton');
  assert.deepEqual(problems.map((p) => `${p.service} ${p.key}`), ['base-win-riverton STARBASE_ORG_NAME', 'base-win-riverton STARBASE_GEO_BOUNDS']);
  const said = explainSettings(problems);
  assert.match(said, /base-win-riverton STARBASE_ORG_NAME: a fixed value \("Riverton Forward"\)/);
  assert.match(said, /write it as "sync: false" and set it once in Render/);
  // Staging's sample values are base.win's own; the same key on a client's
  // service is not.
  assert.equal(FIXED_OK.staging.STARBASE_ORG_NAME.length > 0, true);
  assert.equal(FIXED_OK.production.STARBASE_ORG_NAME, undefined);
  // A service this check does not know is asked about, not passed.
  assert.match(settingProblems({ services: [{ name: 'something-else', envVars: [] }] })[0].problem, /does not know/);
  // A setting with nothing at all is caught too.
  assert.match(settingProblems({ services: [{ name: 'base-win', envVars: [{ key: 'X' }] }] })[0].problem, /no value/);
});

test('the render.yaml reader: comments, quotes and nesting, and an error for YAML it does not know', () => {
  const d = parseYaml(`# top
services:
  - type: web   # a comment
    name: a
    envVars:
      - key: K
        value: "x # not a comment"
      - key: L
        value: 'it''s'
      - key: N
        value: "22"
      - key: D
        fromDatabase:
          name: a-db
          property: connectionString
      - key: S
        sync: false
`);
  const vars = d.services[0].envVars;
  assert.deepEqual(vars.map((v) => [v.key, howSet(v)]), [['K', 'fixed'], ['L', 'fixed'], ['N', 'fixed'], ['D', 'linked'], ['S', 'sync']]);
  assert.equal(vars[0].value, 'x # not a comment');
  assert.equal(vars[1].value, "it's");
  assert.equal(vars[2].value, '22');
  assert.deepEqual(vars[3].fromDatabase, { name: 'a-db', property: 'connectionString' });
  assert.throws(() => parseYaml('services:\n  - name: a\n    envVars: [ { key: K, value: v } ]\n'), /more YAML than this reader knows/);
  assert.throws(() => parseYaml('services:\n  - name: a\n    name: b\n'), /name twice/);
  // render.yaml as it is: every service and database read.
  assert.deepEqual(doc.services.map((s) => s.name), ['base-win-staging', 'base-win', 'base-platform']);
  assert.deepEqual(doc.databases.map((s) => s.name), ['base-win-staging-db', 'base-win-db', 'base-platform-db']);
  assert.equal(YAML.split('\n').filter((l) => /^\s+- key: /.test(l)).length, doc.services.reduce((n, s) => n + (s.envVars || []).length, 0));
});
