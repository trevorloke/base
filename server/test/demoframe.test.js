// The demo's click count (web/src/demoframe.js): framed, the app tells
// base.win how many clicks, and nothing else; on its own it says nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportDemoClicks, DEMO_PARENT } from '../../web/src/demoframe.js';

const fakeWindow = (framed) => {
  const sent = [];
  let onClick = null;
  const win = { document: { addEventListener: (type, fn) => { if (type === 'click') onClick = fn; } } };
  win.parent = framed ? { postMessage: (msg, to) => sent.push({ msg, to }) } : win;
  return { win, sent, click: () => onClick && onClick() };
};

test('framed: each click is counted to base.win alone', () => {
  const f = fakeWindow(true);
  assert.equal(reportDemoClicks(f.win), true);
  f.click(); f.click(); f.click();
  assert.deepEqual(f.sent.map((s) => s.msg), [1, 2, 3].map((clicks) => ({ source: 'base.win-demo', clicks })));
  assert.ok(f.sent.every((s) => s.to === DEMO_PARENT));
  assert.equal(DEMO_PARENT, 'https://base.win');
});

test('on its own address: nothing is listened for or sent', () => {
  const f = fakeWindow(false);
  assert.equal(reportDemoClicks(f.win), false);
  f.click();
  assert.deepEqual(f.sent, []);
});
