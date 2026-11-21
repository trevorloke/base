// A campaign server's /api/health for the poller's tests, on 127.0.0.1:5606.
// Each path answers with whatever handler a test set for it; every request
// is kept so a test can see which paths were asked for.
import { createServer } from 'node:http';

export const PORT = 5606;
export const ORIGIN = `http://127.0.0.1:${PORT}`;
export const seen = [];
export const handlers = new Map();

const server = createServer((req, res) => {
  seen.push({ url: req.url, ua: req.headers['user-agent'], cookie: req.headers.cookie, auth: req.headers.authorization });
  const h = handlers.get(req.url);
  if (!h) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"nothing here"}'); }
  return h(req, res);
});

export const start = () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });
export const stop = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
export const json = (status, body) => (req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
