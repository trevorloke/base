// People's own search box (/persons?q=, lib/audience.js): two words or more
// of a name in any order find the person, as the relationship editor does;
// an address with a number is still one string; offline (KeptCopies.js
// filterPersons) answers the same.
// test:pg-safe: unique emails per run, everything scoped to this campaign.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { filterPersons } from '../../web/src/components/KeptCopies.js';

let mgr;
const tag = Math.random().toString(36).slice(2, 8);

before(async () => {
  await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Imagine Surrey', email: `manager.ppl.${tag}@example.org` });
  await mgr.createPerson('Kevin Smith', { address: '14520 72 Ave' });
  await mgr.createPerson('Kevin Smithers');
  await mgr.createPerson('Smith Kevinson');
  await mgr.createPerson('Mary Smith');
  await mgr.createPerson('Lena Example', { address: '9900 72 Ave' });
});

const ask = async (q) => (await mgr.get(`/api/persons?q=${encodeURIComponent(q)}&limit=300`)).json.persons;
const names = (rows) => rows.map((p) => p.name).sort();

test('several words of a name in any order; an address with a number as typed; offline agrees', async () => {
  const all = await ask('');
  const cases = [
    ['smith kevin', ['Kevin Smith', 'Kevin Smithers', 'Smith Kevinson']],
    ['Smith, Kevin', ['Kevin Smith', 'Kevin Smithers', 'Smith Kevinson']],
    ['kevin smith', ['Kevin Smith', 'Kevin Smithers', 'Smith Kevinson']],
    ['mary smith', ['Mary Smith']],
    ['72 Ave', ['Kevin Smith', 'Lena Example']],
    ['smith', ['Kevin Smith', 'Kevin Smithers', 'Mary Smith', 'Smith Kevinson']],
  ];
  for (const [q, want] of cases) {
    assert.deepEqual(names(await ask(q)), want, q);
    assert.deepEqual(names(filterPersons(all, new URLSearchParams({ q }))), want, `offline ${q}`);
  }
  const count = (await mgr.get(`/api/persons/count?q=${encodeURIComponent('smith kevin')}`)).json;
  assert.equal(count.count ?? count.total ?? count.n, 3);
});
