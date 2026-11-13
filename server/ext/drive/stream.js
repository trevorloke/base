// Bytes from Google Drive, bounded: the answer must start within firstMs,
// then never go idleMs without a new chunk, and never take longer than
// ceilingMs in all (googleFetch's own timeout). Any of them ends the read,
// and the browser shows "Google Drive stopped sending — Try again".
//
//   openStream(db, g, url)        → googleFetch's answer, body unparsed
//   chunksOf(body)                async chunks, with the limits above
//   readUpTo(body, max)           → { buf } | { over: true } (stops reading past max)
//   StreamStopped                 what a limit throws
import { googleFetch } from '../../lib/google/tokens.js';

export const STREAM = { firstMs: 15_000, idleMs: 30_000, ceilingMs: 15 * 60_000 };
export const _setStreamForTest = (o) => Object.assign(STREAM, o);

export class StreamStopped extends Error {
  constructor() { super('Google Drive stopped sending — Try again'); this.status = 504; }
}

const late = (ms) => {
  let t;
  const p = new Promise((_, no) => { t = setTimeout(() => no(new StreamStopped()), ms); });
  return { p, done: () => clearTimeout(t) };
};

export const openStream = async (db, g, url) => {
  const call = googleFetch(db, g, url, {}, { stream: true, timeoutMs: STREAM.ceilingMs, retry: 'auth-only' });
  const timer = late(STREAM.firstMs);
  try {
    return await Promise.race([call, timer.p]);
  } catch (e) {
    // No answer in time: whatever comes later is thrown away unread.
    call.then((r) => r.ok && r.body?.cancel?.().catch(() => {})).catch(() => {});
    throw e;
  } finally {
    timer.done();
  }
};

export async function* chunksOf(body) {
  const reader = body.getReader();
  let first = true;
  try {
    for (;;) {
      const timer = late(first ? STREAM.firstMs : STREAM.idleMs);
      let r;
      try {
        r = await Promise.race([reader.read(), timer.p]);
      } catch (e) {
        if (e instanceof StreamStopped) throw e;
        throw new StreamStopped(); // the ceiling, or the network
      } finally {
        timer.done();
      }
      if (r.done) return;
      first = false;
      yield r.value;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// At most max bytes: past it, the read is cut off and the answer is over.
export const readUpTo = async (body, max) => {
  const parts = [];
  let n = 0;
  for await (const c of chunksOf(body)) {
    n += c.length;
    if (n > max) return { over: true };
    parts.push(c);
  }
  return { buf: Buffer.concat(parts.map((c) => Buffer.from(c))) };
};
