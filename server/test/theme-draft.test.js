// The Theme screen's draft (web/src/pages/themeDraft.js). A website's look
// may be one the browser learns only from GET /api/site (a preset's own
// look, such as a client's). When the website's theme arrives first, the
// draft keeps the look's name as saved, so a Save never turns it into Base.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { full } from '../../web/src/pages/themeDraft.js';

test('a look this browser does not know yet keeps its name; colours and fonts as saved', () => {
  const saved = { skin: 'a-preset-look', colors: { brand: '#123456' }, fonts: { heading: 'Inter', body: 'Inter' }, radius: 'soft', pop: true };
  const d = full(saved);
  assert.equal(d.skin, 'a-preset-look');
  assert.equal(d.colors.brand, '#123456');
  assert.equal(d.pop, true);
  assert.equal(full({}).skin, 'base');
  assert.equal(full({ skin: 'base' }).skin, 'base');
  assert.equal(full({ skin: 42 }).skin, 'base', 'only a name');
});
