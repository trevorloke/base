// db.sql runs at every start and must be safe on a database made by an
// earlier version: one whose checks were 'server' or 'door' and kept the
// door's key (the control centre ops.base.win ran on such a database). After
// it, a check may be 'server' or 'public', the door's rows are kept as
// 'public', its column is gone, every other row is as it was, a checklist
// tick kept as 'address' is kept as 'public', and running it again changes
// nothing. (Over Postgres with npm run test:platform:pg.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshApp, baseEnv } from './helpers.mjs';

baseEnv();
const SCHEMA = readFileSync(new URL('../db.sql', import.meta.url), 'utf8');
// The checks table as it was made before (apps/platform/db.sql at 5a53e89).
const OLD_CHECKS = `
drop table checks;
create table checks (
  id bigserial primary key,
  campaign text not null,
  env text not null,
  via text not null check (via in ('server', 'door')),
  at timestamptz not null default now(),
  answering boolean not null,
  status int, ms int,
  database text, commit text, build text,
  tz_current boolean,
  env_reported text,
  own_origin text,
  instance text,
  address text,
  entry text,
  platform_kids jsonb,
  setup_open boolean,
  door_key boolean,
  problem text
);
create index if not exists checks_recent on checks (campaign, env, via, at desc);
alter table checks add column if not exists campaign_made boolean;
insert into checks (campaign, env, via, answering, commit, door_key) values
  ('a', 'production', 'server', true, 'd9130ae', true),
  ('a', 'production', 'door', true, 'd9130ae', true),
  ('a', 'production', 'door', false, null, null),
  ('sample', 'staging', 'server', true, 'e0e0e0e', null);
insert into campaigns (name, display, kind) values ('a', 'A', 'client') on conflict (name) do nothing;
insert into campaigns (name, display, kind) values ('b', 'B', 'client') on conflict (name) do nothing;
delete from checklist;
insert into checklist (campaign, item, done_at, done_by) values
  ('a', 'address', '2026-11-26T06:30:00Z', 'auto'),
  ('a', 'answers', '2026-11-26T06:30:00Z', 'auto'),
  ('b', 'address', '2026-11-26T06:30:00Z', 'auto'),
  ('b', 'public', '2026-11-25T06:30:00Z', 'auto');
`;
const { db } = await freshApp();
const columns = async () => (await db.query("select column_name from information_schema.columns where table_name = 'checks' order by column_name")).rows.map((r) => r.column_name);
const add = (via) => db.query("insert into checks (campaign, env, via, answering, store) values ('a', 'production', $1, true, 'postgres')", [via]);

test('a new database: a check is from the server or the public address, never the door', async () => {
  await add('server');
  await add('public');
  await assert.rejects(add('door'), /checks_via_check|check constraint/);
  await assert.rejects(add('anything'), /checks_via_check|check constraint/);
  const cols = await columns();
  assert.ok(cols.includes('store') && cols.includes('campaign_made'));
  assert.ok(!cols.includes('door_key'));
  await db.query('delete from checks');
});

test('a database made before: the same file brings it over, keeps the server’s checks, and can run again', async () => {
  await db.exec(OLD_CHECKS);
  await assert.rejects(add('public'), /column "store"|checks_via_check|check constraint/, 'the old rule, before db.sql runs');
  for (let run = 1; run <= 3; run += 1) {
    await db.exec(SCHEMA);
    const rows = (await db.query('select campaign, env, via, answering, commit from checks order by campaign, id')).rows;
    assert.deepEqual(rows, [
      { campaign: 'a', env: 'production', via: 'server', answering: true, commit: 'd9130ae' },
      { campaign: 'a', env: 'production', via: 'public', answering: true, commit: 'd9130ae' },
      { campaign: 'a', env: 'production', via: 'public', answering: false, commit: null },
      { campaign: 'sample', env: 'staging', via: 'server', answering: true, commit: 'e0e0e0e' },
    ], `run ${run}: every check kept, the door’s under 'public'`);
    const ticks = (await db.query("select campaign, item, done_by from checklist where campaign in ('a', 'b') order by campaign, item")).rows;
    assert.deepEqual(ticks, [
      { campaign: 'a', item: 'answers', done_by: 'auto' },
      { campaign: 'a', item: 'public', done_by: 'auto' },
      { campaign: 'b', item: 'address', done_by: 'auto' },
      { campaign: 'b', item: 'public', done_by: 'auto' },
    ], `run ${run}: the 'address' tick kept as 'public' (where 'public' was not ticked already)`);
    const cols = await columns();
    assert.ok(cols.includes('store') && !cols.includes('door_key'), `run ${run}`);
  }
  await add('public');
  await assert.rejects(add('door'), /checks_via_check|check constraint/);
  assert.equal((await db.query("select count(*)::int n from pg_constraint where conrelid = 'checks'::regclass and contype = 'c'")).rows[0].n, 1, 'one rule on via, not one per start');
  // The rest of the database was not touched: the sample is still listed.
  assert.equal((await db.query("select kind from campaigns where name = 'sample'")).rows[0].kind, 'sample');
});
