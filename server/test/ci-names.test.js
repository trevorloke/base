// The name of the automatic test that Promote waits on. GitHub names a job's
// check after the job (its `name:` if it has one, otherwise its id), and
// promote.yml looks the check up by that name twice: once in the request and
// once in the filter. If the three ever differ, Promote finds no check and
// refuses every release, so this test keeps them equal, and keeps the name
// base-win.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (path) => readFileSync(ROOT + path, 'utf8');

// The jobs in a workflow file: each key two spaces in under `jobs:`, with the
// `name:` written four spaces in under it, if any.
const jobsOf = (text) => {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.ok(start >= 0, 'the workflow has a jobs: section');
  const jobs = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // the next top-level key ends the jobs
    const id = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (id) { jobs.push({ id: id[1], name: null }); continue; }
    const name = line.match(/^ {4}name:\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/);
    if (name && jobs.length) jobs[jobs.length - 1].name = name[1];
  }
  return jobs;
};

test('ci.yml has a single job, and its check is called base-win', () => {
  const jobs = jobsOf(read('.github/workflows/ci.yml'));
  assert.equal(jobs.length, 1, `ci.yml has one job (found: ${jobs.map((j) => j.id).join(', ')})`);
  const [job] = jobs;
  assert.equal(job.id, 'base-win', 'the job id is base-win');
  assert.equal(job.name ?? job.id, 'base-win', 'the check GitHub shows is named base-win');
});

test('promote.yml waits on the same check ci.yml makes, by name, in both places', () => {
  const [job] = jobsOf(read('.github/workflows/ci.yml'));
  const check = job.name ?? job.id;
  const promote = read('.github/workflows/promote.yml');

  const asked = [...promote.matchAll(/check-runs\?check_name=([A-Za-z0-9._-]+)/g)].map((m) => m[1]);
  assert.equal(asked.length, 1, 'promote.yml asks GitHub for check runs once');
  assert.equal(asked[0], check, 'the request names the check ci.yml makes');

  const kept = [...promote.matchAll(/select\(\.name == "([^"]+)"\)/g)].map((m) => m[1]);
  assert.equal(kept.length, 1, 'promote.yml filters the check runs once');
  assert.equal(kept[0], check, 'the filter keeps the check ci.yml makes');
});

test('the website workflow says whose CI Promote waits on', () => {
  const web = read('.github/workflows/base-web.yml');
  assert.match(web, /base\.win's CI \(ci\.yml\) is what promote\.yml waits on/);
  assert.doesNotMatch(web, /Base Ground/);
});
