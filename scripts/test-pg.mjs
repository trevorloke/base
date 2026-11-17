// Runs the whole server suite through node-postgres against a real Postgres
// wire-protocol server (PGlite's socket server), proving the DATABASE_URL
// adapter end to end without a system Postgres install.
//   npm run test:pg
//   npm run test:pg -- --twice   (each file twice against one database)
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

// Each test file gets its own fresh database, as it does under the in-memory
// runner (helpers.freshDb) — files may assume they start from nothing (the
// first-run setup) or that their campaign is the only one (the website).
// Optional arguments name the test files to run (default: all of them).
// --twice runs each file a second time against the same database, so the
// second run finds the first run's campaigns, jobs and markers (an upgrade
// job must leave them alone).
const args = process.argv.slice(2);
const twice = args.includes('--twice');
const named = args.filter((a) => a !== '--twice');
const files = named.length
  ? named
  : readdirSync('server/test').filter((f) => f.endsWith('.test.js')).sort().map((f) => `server/test/${f}`);
// PGlite mishandles a chunk whose next message starts exactly at byte 16,384
// (it answers the messages before it and drops the rest, so the client
// waits for ever). The socket server hands it whatever TCP delivered; this
// hands it one whole message at a time, as PGlite's own query() does.
const oneMessageAtATime = (db) => {
  const raw = db.execProtocolRaw.bind(db);
  db.execProtocolRaw = async (data, opts) => {
    const view = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const lengths = [];
    for (let i = 0; i < view.length;) {
      if (i + 5 > view.length) return raw(data, opts);
      const len = view.readInt32BE(i + 1);
      // The startup message has no type byte; a part of a message is passed on as it came.
      if (len < 4 || i + 1 + len > view.length) return raw(data, opts);
      lengths.push(1 + len);
      i += 1 + len;
    }
    if (lengths.length < 2) return raw(data, opts);
    const out = [];
    let at = 0;
    // Copied at once: each answer is a view PGlite reuses on the next call.
    for (const n of lengths) { out.push(Buffer.from(await raw(data.subarray(at, at + n), opts))); at += n; }
    return new Uint8Array(Buffer.concat(out));
  };
  return db;
};
let failed = 0;
const failedFiles = [];
for (const file of files) {
  const db = oneMessageAtATime(await PGlite.create());
  // A random port can be taken (another runner, a test's own server): try
  // another rather than crash the whole run on EADDRINUSE.
  let port, server;
  for (let tries = 0; ; tries += 1) {
    port = 55432 + Math.floor(Math.random() * 1000);
    server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
    try { await server.start(); break; } catch (e) {
      if (e.code !== 'EADDRINUSE' || tries >= 20) throw e;
    }
  }
  let code = 0;
  let run = 0;
  for (; run < (twice ? 2 : 1) && code === 0; run += 1) {
    const child = spawn(process.execPath, ['--test', file], {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`, PG_POOL_MAX: '1' },
    });
    code = await new Promise((r) => child.on('exit', r));
  }
  await server.stop();
  await db.close();
  if (code !== 0) {
    const which = twice ? (run === 2 ? ' (second run)' : ' (first run)') : '';
    failed += 1; failedFiles.push(file + which); console.error(`✗ ${file} failed over Postgres${which}`);
  }
}
console.log(failed ? `\n${failed} of ${files.length} test files failed over Postgres: ${failedFiles.join(', ')}` : `\nAll ${files.length} test files passed over Postgres`);
process.exit(failed ? 1 : 0);
