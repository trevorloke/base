// render.yaml: the control centre's service and database are there, its
// secrets are made by Render, and BASE_PLATFORM_PUBKEY is pasted by hand on
// both campaign services — never a value in git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const yaml = readFileSync(new URL('../../../render.yaml', import.meta.url), 'utf8');
const lines = yaml.split('\n');
// The lines of one envVars entry: from "- key: K" to the next "- key:" or a dedent.
const entries = (key) => lines.flatMap((l, i) => {
  if (!new RegExp(`^\\s+- key: ${key}\\b`).test(l)) return [];
  const indent = l.search(/\S/);
  const out = [];
  for (let j = i + 1; j < lines.length && lines[j].search(/\S/) > indent && !/^\s*- /.test(lines[j]); j++) out.push(lines[j].trim());
  return [out];
});

test('BASE_PLATFORM_PUBKEY is sync: false on both campaign services, never a value', () => {
  const found = entries('BASE_PLATFORM_PUBKEY');
  assert.equal(found.length, 2);
  for (const body of found) assert.deepEqual(body, ['sync: false']);
  assert.doesNotMatch(yaml, /BASE_PLATFORM_PUBKEY\s*[:=]\s*[A-Za-z0-9_-]{43}/);
});

test('the control centre: node runtime, /healthz, its own database, secrets made by Render', () => {
  const at = yaml.indexOf('name: base-platform\n');
  assert.ok(at > 0);
  const block = yaml.slice(at, yaml.indexOf('\ndatabases:'));
  for (const want of ['runtime: node', 'startCommand: node apps/platform/server.mjs', 'healthCheckPath: /healthz', 'name: base-platform-db', 'value: ops.base.win']) {
    assert.ok(block.includes(want), want);
  }
  for (const key of ['OPS_SETUP_CODE', 'OPS_SECRET', 'PLATFORM_SIGNING_KEY']) assert.deepEqual(entries(key)[0], ['generateValue: true'], key);
  assert.match(yaml.slice(yaml.indexOf('\ndatabases:')), /- name: base-platform-db\n\s+plan: basic-256mb/);
});

// The Render key: one entry, on the control centre only, pasted in Render
// (never a value in git, never made by Render); and the control centre is
// built without running any package's install script beside it.
test('RENDER_API_KEY: once, under base-platform, sync: false; the build runs no install scripts', () => {
  const found = entries('RENDER_API_KEY');
  assert.equal(found.length, 1);
  assert.deepEqual(found[0], ['sync: false']);
  assert.equal([...yaml.matchAll(/RENDER_API_KEY/g)].filter((m) => !/^\s*#/.test(lines[yaml.slice(0, m.index).split('\n').length - 1])).length, 1, 'named once outside comments');
  const at = yaml.indexOf('name: base-platform\n');
  const block = yaml.slice(at, yaml.indexOf('\ndatabases:'));
  assert.match(block, /- key: RENDER_API_KEY\b[^\n]*\n\s+sync: false\n/, 'in the control centre’s own block');
  assert.equal(yaml.slice(0, at).includes('- key: RENDER_API_KEY'), false, 'on no campaign’s service');
  assert.doesNotMatch(yaml, /RENDER_API_KEY\s*[:=]\s*\S*rnd_/);
  assert.match(block, /^    buildCommand: npm ci --omit=dev --ignore-scripts\s*(#.*)?$/m);
  assert.equal(entries('BASE_PLATFORM_PUBKEY').length, 2, 'the two BASE_PLATFORM_PUBKEY entries stay two');
});
