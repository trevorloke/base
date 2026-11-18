// Every call WA makes to a service outside base.win goes through here
// (Google Fonts: a font added, fetched again, or a sample). A call from
// inside a write (runAction's transaction, which holds the campaign's row
// lock) is refused: it would hold every other write of the campaign for as
// long as the service takes. On in production too — such a call is a bug
// wherever it happens, and failing at once is safer than an 8-second lock.
import { inWrite } from './events.js';

export const OUTSIDE_IN_WRITE = 'outside call inside a write';

// fetch, with a timeout (ms) and a cap on the answer's size (bytes). Answers
// { status, ok, headers, body: Buffer }; a timeout or a too-big answer
// throws with .code 'timeout' | 'too-big'.
export async function outsideFetch(url, { timeout = 8000, maxBytes = 1_000_000, headers = {} } = {}) {
  if (inWrite()) throw new Error(OUTSIDE_IN_WRITE);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal, redirect: 'error' });
    const len = Number(res.headers.get('content-length') || 0);
    if (len > maxBytes) { ctl.abort(); throw Object.assign(new Error('too big'), { code: 'too-big' }); }
    const chunks = [];
    let n = 0;
    for await (const chunk of res.body || []) {
      n += chunk.length;
      if (n > maxBytes) { ctl.abort(); throw Object.assign(new Error('too big'), { code: 'too-big' }); }
      chunks.push(chunk);
    }
    return { status: res.status, ok: res.ok, headers: res.headers, body: Buffer.concat(chunks) };
  } catch (e) {
    if (e.code === 'too-big') throw e;
    if (ctl.signal.aborted) throw Object.assign(new Error('timed out'), { code: 'timeout' });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
