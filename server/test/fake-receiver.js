// A stand-in for whatever a ladder's "Send to a web address" step points at
// (a Zapier or Make catch hook, a Slack incoming webhook, the campaign's own
// tool), so the tests run with no account and no network. Point base.win at
// it with LADDER_WEBHOOK_API_BASE=http://127.0.0.1:<port>: every step then
// posts here instead, keeping the path of the address the manager typed.
// It keeps each delivery's exact bytes, so a test can check the signature
// over them, and answers 200 unless told otherwise.
//
//   In a test:   const hooks = await startFakeReceiver()
//                hooks.received          [{ method, path, headers, raw, body }]
//                hooks.answer(500, 3)    the next three deliveries answer 500
//                hooks.hang(1)           the next one is never answered
//                hooks.hold(1)           the next one waits for hooks.release(500)
//                hooks.asUsual()         back to answering 200
//                hooks.reset() · hooks.close()
//   On its own:  PORT=5021 node server/test/fake-receiver.js
//                GET  /__received            what arrived, as JSON
//                POST /__answer { status, times } · POST /__hang { times }
//                POST /__hold { times } · POST /__release { status }
//                POST /__reset
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const startFakeReceiver = async ({ port = 0 } = {}) => {
  const received = [];
  let plan = []; // what the next deliveries get: { status, headers }, { hang: true } or { hold: true }
  let held = []; // deliveries waiting for release(): each answers when told

  const api = {
    received,
    answer: (status, times = 1, headers = {}) => { for (let i = 0; i < times; i += 1) plan.push({ status, headers }); },
    hang: (times = 1) => { for (let i = 0; i < times; i += 1) plan.push({ hang: true }); },
    // Held open until the test says what it answers: lets something happen
    // on the campaign's side while the address is still being called.
    hold: (times = 1) => { for (let i = 0; i < times; i += 1) plan.push({ hold: true }); },
    release: (status = 200) => { for (const answer of held.splice(0)) answer(status); },
    asUsual: () => { plan = []; },
    reset: () => { received.length = 0; plan = []; },
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      const sent = () => { try { return JSON.parse(raw || '{}'); } catch { return {}; } };
      if (req.url === '/__received') return json(received);
      if (req.url === '/__reset') { api.reset(); return json({ ok: true }); }
      if (req.url === '/__answer') { const b = sent(); api.answer(Number(b.status) || 500, Number(b.times) || 1); return json({ ok: true }); }
      if (req.url === '/__hang') { api.hang(Number(sent().times) || 1); return json({ ok: true }); }
      if (req.url === '/__hold') { api.hold(Number(sent().times) || 1); return json({ ok: true }); }
      if (req.url === '/__release') { api.release(Number(sent().status) || 200); return json({ ok: true }); }
      let body = null;
      try { body = JSON.parse(raw); } catch { /* kept as it came */ }
      received.push({ method: req.method, path: req.url, headers: req.headers, raw, body });
      const next = plan.shift();
      if (next?.hang) return undefined; // the sender gives up on its own
      if (next?.hold) { held.push((status) => json({ ok: status < 300 }, status)); return undefined; }
      if (next) { res.writeHead(next.status, { 'content-type': 'application/json', ...next.headers }); return res.end(JSON.stringify({ ok: next.status < 300 })); }
      return json({ ok: true });
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  api.port = server.address().port;
  api.url = `http://127.0.0.1:${api.port}`;
  api.close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return api;
};

// On its own: the browser suite runs it next to a server.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const fake = await startFakeReceiver({ port: Number(process.env.PORT) || 5021 });
  console.log(`fake receiver on ${fake.url}`);
}
