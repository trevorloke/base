// Google Drive and Sheets for the fake Google (fake-google.js), so the
// Drive feature (server/ext/drive) is tested with no Google account and no
// network. base.win reaches it through GOOGLE_DRIVE_API_BASE and
// GOOGLE_SHEETS_API_BASE (both the fake's address; ignored in production).
//
//   Drive   GET  /drive/v3/about                 { kind }
//           GET  /drive/v3/files?q=…             folders by name (files.list)
//           POST /drive/v3/files                 a folder or a Sheet (files.create)
//           GET  /drive/v3/files/:id             metadata (files.get), with driveId
//   Sheets  GET  /v4/spreadsheets/:id            tabs with rowCount (404 for an unknown id)
//           POST /v4/spreadsheets/:id:batchUpdate  updateSheetProperties, appendDimension
//           PUT  /v4/spreadsheets/:id/values/:range?valueInputOption=…  the cells, kept
//   OAuth   POST /tokeninfo                      { scope, expires_in, aud } of an access token
//
// Every call needs a live access token holding drive.file, and is recorded
// in calls (method, path, query, body, the token used).
//
// Controls (in code, or POST /__drive with JSON { do, … }):
//   next('drive' | 'sheets', kind, opts)  the next answer: '500', '503',
//       '429' ({ retryAfter }), 'disabled' (403 SERVICE_DISABLED),
//       'full' (403 storageQuotaExceeded), 'notFound', 'hang' (no answer)
//   folder({ id, name, driveId, needsPick })  a folder someone made in Drive
//       (a shared drive's when driveId is set); needsPick: base.win can't
//       use it until this person picks it (pick(id, sub))
//   file({ id, name, mimeType })  any other file
//   sheet(id) → { title, tabs, rows (a Map of row number → cells), writes }
import { randomBytes } from 'node:crypto';

const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER = 'application/vnd.google-apps.folder';
const SHEET = 'application/vnd.google-apps.spreadsheet';
const rand = (p) => `${p}${randomBytes(9).toString('base64url')}`;

export const fakeDrive = ({ accessTokens, people, base }) => {
  const files = new Map(); // id → { id, name, mimeType, parents, driveId, needsPick, picked:Set(sub), owner }
  const sheets = new Map(); // id → { tabs: [{ sheetId, title, rowCount, columnCount, frozen }], rows: Map, writes: [] }
  const knobs = { drive: [], sheets: [] };
  const calls = [];
  const hanging = new Set();
  const take = (k) => knobs[k].shift() || null;

  const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  const refuse = (res, status, reason, message) => send(res, status, { error: { code: status, message, errors: [{ domain: 'global', reason, message }] } });
  const knobAnswer = (res, knob) => {
    if (!knob) return false;
    if (knob.kind === 'hang') { hanging.add(res); return true; }
    if (knob.kind === '500' || knob.kind === '503') { send(res, Number(knob.kind), { error: { code: Number(knob.kind), message: 'Backend Error' } }); return true; }
    if (knob.kind === '429') { send(res, 429, { error: { code: 429, message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] } }, knob.retryAfter ? { 'retry-after': String(knob.retryAfter) } : {}); return true; }
    if (knob.kind === 'disabled') {
      send(res, 403, { error: { code: 403, message: 'Google Sheets API has not been used in project 123456789012 before or it is disabled.', status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } });
      return true;
    }
    if (knob.kind === 'full') { refuse(res, 403, 'storageQuotaExceeded', 'The user’s Drive storage quota has been exceeded.'); return true; }
    if (knob.kind === 'notFound') { refuse(res, 404, 'notFound', 'File not found.'); return true; }
    return false;
  };

  // The person behind a live token holding drive.file, or an answer already sent.
  const who = (req, res) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const t = accessTokens.get(token);
    if (!t || !t.alive || t.expiresAt < Date.now()) { send(res, 401, { error: { code: 401, message: 'Invalid Credentials' } }); return null; }
    if (!t.scopes.includes(DRIVE_FILE)) { refuse(res, 403, 'insufficientPermissions', 'Insufficient Permission'); return null; }
    return { token, sub: t.sub };
  };
  // drive.file: base.win reaches a file it made, or one this person picked.
  const reachable = (f, sub) => f && (!f.needsPick || f.owner === 'base.win' || f.picked.has(sub));

  const meta = (f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, ...(f.driveId ? { driveId: f.driveId } : {}), webViewLink: f.webViewLink });

  const drive = async (req, res, u, raw) => {
    const me = who(req, res);
    calls.push({ api: 'drive', method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: raw ? JSON.parse(raw) : null, token: me?.token || null });
    if (!me) return;
    if (knobAnswer(res, take('drive'))) return;
    const path = u.pathname.replace(/^\/drive\/v3/, '');
    if (path === '/about') return send(res, 200, { kind: 'drive#about' });
    if (path === '/files' && req.method === 'GET') {
      const q = u.searchParams.get('q') || '';
      const name = (q.match(/name\s*=\s*'((?:[^'\\]|\\.)*)'/) || [])[1]?.replace(/\\'/g, "'");
      const prop = q.match(/appProperties has \{ key='([^']+)' and value='([^']+)' \}/);
      const found = [...files.values()].filter((f) => f.owner === 'base.win' && f.ownerSub === me.sub && !f.trashed
        && (!name || f.name === name) && (!/mimeType\s*=\s*'application\/vnd\.google-apps\.folder'/.test(q) || f.mimeType === FOLDER)
        && (!prop || f.appProperties?.[prop[1]] === prop[2]));
      return send(res, 200, { files: found.map(meta) });
    }
    if (path === '/files' && req.method === 'POST') {
      const body = raw ? JSON.parse(raw) : {};
      for (const pid of body.parents || []) {
        const parent = files.get(pid);
        if (!reachable(parent, me.sub)) return refuse(res, 404, 'notFound', `File not found: ${pid}.`);
      }
      const parent = files.get((body.parents || [])[0]);
      const id = rand(body.mimeType === SHEET ? '1sheet' : '1fold');
      const f = {
        id, name: body.name, mimeType: body.mimeType, parents: body.parents || [], driveId: parent?.driveId || null,
        owner: 'base.win', ownerSub: me.sub, picked: new Set(), webViewLink: `${base()}/open/${id}`, appProperties: body.appProperties || {},
      };
      files.set(id, f);
      if (body.mimeType === SHEET) sheets.set(id, { title: body.name, tabs: [{ sheetId: 0, title: 'Sheet1', rowCount: 1000, columnCount: 26, frozen: 0 }], rows: new Map(), writes: [] });
      return send(res, 200, { id, webViewLink: f.webViewLink });
    }
    const m = path.match(/^\/files\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const f = files.get(decodeURIComponent(m[1]));
      if (!reachable(f, me.sub)) return refuse(res, 404, 'notFound', `File not found: ${m[1]}.`);
      return send(res, 200, meta(f));
    }
    return send(res, 404, { error: { code: 404, message: 'not here' } });
  };

  const sheetsApi = async (req, res, u, raw) => {
    const me = who(req, res);
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ api: 'sheets', method: req.method, path: decodeURIComponent(u.pathname), query: Object.fromEntries(u.searchParams), body, token: me?.token || null });
    if (!me) return;
    if (knobAnswer(res, take('sheets'))) return;
    const m = u.pathname.match(/^\/v4\/spreadsheets\/([^/:]+)(:batchUpdate|\/values\/(.+))?$/);
    const s = m && sheets.get(decodeURIComponent(m[1]));
    if (!s || !reachable(files.get(decodeURIComponent(m[1])), me.sub)) return send(res, 404, { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } });
    if (!m[2] && req.method === 'GET') {
      return send(res, 200, { spreadsheetId: m[1], properties: { title: s.title }, sheets: s.tabs.map((t) => ({ properties: { sheetId: t.sheetId, title: t.title, gridProperties: { rowCount: t.rowCount, columnCount: t.columnCount, frozenRowCount: t.frozen } } })) });
    }
    if (m[2] === ':batchUpdate' && req.method === 'POST') {
      for (const r of body.requests || []) {
        if (r.updateSheetProperties) {
          const p = r.updateSheetProperties.properties;
          const t = s.tabs.find((x) => x.sheetId === p.sheetId);
          if (p.title) t.title = p.title;
          if (p.gridProperties?.rowCount) t.rowCount = p.gridProperties.rowCount;
          if (p.gridProperties?.columnCount) t.columnCount = p.gridProperties.columnCount;
          if (p.gridProperties?.frozenRowCount != null) t.frozen = p.gridProperties.frozenRowCount;
        }
        if (r.appendDimension) s.tabs.find((x) => x.sheetId === r.appendDimension.sheetId).rowCount += r.appendDimension.length;
      }
      return send(res, 200, { spreadsheetId: m[1], replies: [] });
    }
    if (m[3] && req.method === 'PUT') {
      // 'Title'!A12 — quotes doubled inside the title.
      const range = decodeURIComponent(m[3]);
      const r = range.match(/^'((?:[^']|'')*)'!A(\d+)$/);
      if (!r) return send(res, 400, { error: { code: 400, message: `Unable to parse range: ${range}` } });
      const t = s.tabs.find((x) => x.title === r[1].replace(/''/g, "'"));
      const at = Number(r[2]);
      const values = body.values || [];
      if (!t) return send(res, 400, { error: { code: 400, message: `Unable to parse range: ${range}` } });
      if (at + values.length - 1 > t.rowCount) return send(res, 400, { error: { code: 400, message: `Range (${range}) exceeds grid limits. Max rows: ${t.rowCount}` } });
      values.forEach((row, i) => s.rows.set(at + i, row));
      s.writes.push({ range, at, rows: values.length, valueInputOption: u.searchParams.get('valueInputOption') });
      return send(res, 200, { updatedRange: range, updatedRows: values.length });
    }
    return send(res, 404, { error: { code: 404, message: 'not here' } });
  };

  const tokeninfo = (res, form, u) => {
    const t = accessTokens.get(form.access_token || u.searchParams.get('access_token'));
    if (!t || !t.alive) return send(res, 400, { error: 'invalid_token', error_description: 'Invalid Value' });
    return send(res, 200, { scope: t.scopes.join(' '), expires_in: Math.floor((t.expiresAt - Date.now()) / 1000), aud: 'fake' });
  };

  // → true when this request was Drive's, Sheets' or tokeninfo's.
  const handle = async (req, res, u, raw, form) => {
    if (u.pathname.startsWith('/drive/v3/')) { await drive(req, res, u, raw); return true; }
    if (u.pathname.startsWith('/v4/spreadsheets/')) { await sheetsApi(req, res, u, raw); return true; }
    if (u.pathname === '/tokeninfo') { tokeninfo(res, form, u); return true; }
    return false;
  };

  const api = {
    calls, files,
    next: (k, kind, opts = {}) => { knobs[k].push({ kind: String(kind), ...opts }); },
    clear: () => { knobs.drive.length = 0; knobs.sheets.length = 0; calls.length = 0; for (const r of hanging) r.destroy(); hanging.clear(); },
    folder: ({ id = rand('1fold'), name, driveId = null, needsPick = true }) => {
      files.set(id, { id, name, mimeType: FOLDER, parents: [], driveId, needsPick, owner: 'someone', picked: new Set(), webViewLink: `${base()}/open/${id}` });
      return id;
    },
    file: ({ id = rand('1file'), name, mimeType }) => {
      files.set(id, { id, name, mimeType, parents: [], driveId: null, needsPick: true, owner: 'someone', picked: new Set(), webViewLink: `${base()}/open/${id}` });
      return id;
    },
    pick: (id, sub) => files.get(id).picked.add(sub),
    sheet: (id) => sheets.get(id),
    sheetsMade: () => [...files.values()].filter((f) => f.mimeType === SHEET),
    foldersMade: () => [...files.values()].filter((f) => f.mimeType === FOLDER && f.owner === 'base.win'),
    people,
  };
  return { handle, api };
};
