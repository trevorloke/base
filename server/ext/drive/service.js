// Settings → Services: "Google Drive and Sheets". The row says only what the
// environment holds (services() is synchronous and sees no campaign); the
// campaign's own facts are in the Drive panel under it, from GET /api/drive.
//
// Check (nothing written, within Services' 8 s): with the manager's own
// Drive connection, one Drive about and one Sheets read of a made-up id —
// Drive answering and Sheets saying "not found" means both APIs are on.
import { googleSetup } from '../../lib/google/config.js';
import { grantFor, grantRowOf } from '../../lib/google/tokens.js';
import { googleTrouble } from '../../lib/googleerr.js';
import { driveSetup, testBaseInUse } from './config.js';
import { about } from './files.js';
import { readSheet } from './sheets.js';

const NEEDS = ['GOOGLE_PICKER_KEY', 'GOOGLE_CLOUD_PROJECT_NUMBER'];
const has = (k) => Boolean(String(process.env[k] || '').trim());

export const driveService = () => {
  const s = driveSetup();
  const lines = [
    !s.connections ? 'Set up Google sign-in and connections first' : null,
    s.missing.length ? `Set ${s.missing.join(' and ')}` : 'Picker key and project number set',
    testBaseInUse() ? 'Test address in use (GOOGLE_DRIVE_API_BASE / GOOGLE_SHEETS_API_BASE)' : null,
  ].filter(Boolean);
  return {
    key: 'drive', name: 'Google Drive and Sheets',
    for: 'Attach files from Drive, send lists to Google Sheets, import a Sheet',
    launch: false,
    missing: s.missing,
    set: NEEDS.filter(has),
    state: s.ok ? 'ready' : 'missing',
    detail: lines.join(' · '),
    checkable: s.ok,
    panel: 'drive',
  };
};

const TESTING_HINT = 'Google stopped this connection within a week. Is the Google app still in Testing? (Google Auth Platform → Audience → Publish app)';
const offWords = (r) => googleTrouble(r.status, r.body || {}, { service: 'drive' });

export const checkDrive = async (db, ws, base, ctx) => {
  const s = driveSetup();
  if (!googleSetup().connect) return { ok: false, said: 'Set up Google sign-in and connections first' };
  if (!s.ok) return { ok: false, said: `Set ${s.missing.join(' and ')}` };
  const userId = ctx?.user?.id;
  const row = userId ? await grantRowOf(db, userId) : null;
  if (!row || !row.purposes.includes('drive')) return { ok: false, said: 'Connect your own Google Drive (Your profile) to check it' };
  if (row.state === 'reconnect') {
    const young = Date.now() - new Date(row.created_at).getTime() < 8 * 86_400_000;
    const stopped = /stopped letting base\.win/i.test(row.said || '');
    return { ok: false, said: young && stopped ? TESTING_HINT : 'Connect your own Google Drive again (Your profile) to check it' };
  }
  const g = await grantFor(db, { userId, workspaceId: ws }, 'drive');
  if (!g || g.state !== 'ok') return { ok: false, said: g?.said || 'Connect your own Google Drive (Your profile) to check it' };
  const d = await about(db, g);
  if (!d.ok) {
    if (d.trouble?.code === 'reconnect') return { ok: false, said: TESTING_HINT };
    const t = offWords(d);
    return { ok: false, said: d.trouble?.code === 'unavailable' ? d.trouble.plain : t.plain, ...(t.code === 'drive-api-off' ? { todo: 'Turn on the Google Drive API (Google Cloud → APIs & Services → Library)' } : {}) };
  }
  const sh = await readSheet(db, g, 'base-win-check');
  if (sh.status === 404) return { ok: true, said: 'Working · Drive and Sheets answer' };
  const t = offWords(sh);
  if (t.code === 'drive-api-off') return { ok: false, said: t.plain, todo: 'Turn on the Google Sheets API (Google Cloud → APIs & Services → Library)' };
  return { ok: false, said: sh.trouble?.plain || t.plain };
};
