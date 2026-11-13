// Google Drive and Sheets for the fake Google (fake-google.js), so the
// Drive feature (server/ext/drive) is tested with no Google account and no
// network. base.win reaches it through GOOGLE_DRIVE_API_BASE and
// GOOGLE_SHEETS_API_BASE (both the fake's address; ignored in production).
//
//   Drive   GET  /drive/v3/about                 { kind }
//           GET  /drive/v3/files?q=…             folders by name (files.list)
//           POST /drive/v3/files                 a folder or a Sheet (files.create)
//           GET  /drive/v3/files/:id             metadata (files.get), with driveId and size
//           GET  /drive/v3/files/:id?alt=media   the bytes, streamed
//           GET  /drive/v3/files/:id/export      a Google file as PDF
//           POST /drive/v3/files/:id/permissions  "anyone with the link" (kept in permissions)
//           DELETE /drive/v3/files/:id/permissions/:pid
//   Sheets  GET  /v4/spreadsheets/:id            tabs with rowCount and hidden (404 for an unknown id)
//           GET  /v4/spreadsheets/:id/values/'Tab'!n:m  whole rows, trailing blanks left out
//           POST /v4/spreadsheets/:id:batchUpdate  updateSheetProperties, appendDimension
//           PUT  /v4/spreadsheets/:id/values/:range?valueInputOption=…  the cells, kept
//   OAuth   POST /tokeninfo                      { scope, expires_in, aud } of an access token
//   Picker  GET  /picker.js                      a stand-in for Google's loader (GOOGLE_PICKER_SCRIPT):
//                                                gapi.load and a minimal google.picker that records
//                                                what it was given on window.__picker and, on
//                                                setVisible(true), draws a small dialog of the fake's
//                                                files (#fake-picker: a box per file, Select, Cancel)
//           POST /picker/files, /picker/pick     the dialog's own calls: what it lists, and the pick
//                                                (as Google records it: base.win may now open it)
//
// Every call needs a live access token holding drive.file, and is recorded
// in calls (method, path, query, body, the token used).
//
// Controls (in code, or POST /__drive with JSON { do, … }):
//   next('drive' | 'sheets', kind, opts)  the next answer: '500', '503',
//       '429' ({ retryAfter }), 'disabled' (403 SERVICE_DISABLED),
//       'full' (403 storageQuotaExceeded), 'notFound', 'hang' (no answer),
//       'stall' (a download sends 64 KB, then nothing), 'shareRefused' (403
//       publishOutNotPermitted on permissions.create), 'exportTooBig'
//   folder({ id, name, driveId, needsPick })  a folder someone made in Drive
//       (a shared drive's when driveId is set); needsPick: base.win can't
//       use it until this person picks it (pick(id, sub))
//   file({ id, name, mimeType, data, size, hideSize })  any other file:
//       data its bytes (Buffer); size what Drive says (default data's length)
//   readable({ id, name, tabs: [{ title, rows, rowCount, hidden }] })  a
//       Google Sheet someone made, to import from (pick it first)
//   streams  { opened, cut } — downloads started, and those cut before the end
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
  const streams = { opened: 0, cut: 0 };
  // A download: 64 KB at a time; 'stall' sends the first part, then nothing.
  const download = (res, buf, stall) => {
    streams.opened += 1;
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(buf.length) });
    let at = 0;
    let ended = false;
    res.on('close', () => { if (!ended) streams.cut += 1; });
    const more = () => {
      if (res.destroyed) return;
      if (at >= buf.length) { ended = true; res.end(); return; }
      const part = buf.subarray(at, at + 65536);
      at += part.length;
      if (stall && at > 0 && at >= 65536) { res.write(part); hanging.add(res); return; }
      if (res.write(part)) setImmediate(more); else res.once('drain', more);
    };
    more();
  };

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
    if (knob.kind === 'shareRefused') { refuse(res, 403, 'publishOutNotPermitted', 'The user does not have sufficient permissions for this file.'); return true; }
    if (knob.kind === 'exportTooBig') { refuse(res, 403, 'exportSizeLimitExceeded', 'This file is too large to be exported.'); return true; }
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

  const meta = (f) => ({
    id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, ...(f.driveId ? { driveId: f.driveId } : {}), webViewLink: f.webViewLink,
    ...(f.size != null && !f.hideSize ? { size: String(f.size) } : {}),
  });

  const drive = async (req, res, u, raw) => {
    const me = who(req, res);
    calls.push({ api: 'drive', method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: raw ? JSON.parse(raw) : null, token: me?.token || null });
    if (!me) return;
    const knob = take('drive');
    if (knob?.kind !== 'stall' && knobAnswer(res, knob)) return;
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
    const m = path.match(/^\/files\/([^/]+)(\/export|\/permissions(?:\/([^/]+))?)?$/);
    const f = m && files.get(decodeURIComponent(m[1]));
    if (m && !reachable(f, me.sub)) return refuse(res, 404, 'notFound', `File not found: ${m[1]}.`);
    if (m && !m[2] && req.method === 'GET') {
      if (u.searchParams.get('alt') !== 'media') return send(res, 200, meta(f));
      if (f.mimeType.startsWith('application/vnd.google-apps.')) return refuse(res, 403, 'fileNotDownloadable', 'Only files with binary content can be downloaded.');
      return download(res, f.data || Buffer.alloc(0), knob?.kind === 'stall');
    }
    if (m && m[2] === '/export' && req.method === 'GET') {
      if (u.searchParams.get('mimeType') !== 'application/pdf' || !f.mimeType.startsWith('application/vnd.google-apps.')) return refuse(res, 400, 'badRequest', 'Export only supports Docs Editors files.');
      return download(res, f.pdf || Buffer.from(`%PDF-1.4\n% a fake PDF of ${f.name}\n%%EOF\n`), knob?.kind === 'stall');
    }
    if (m && m[2]?.startsWith('/permissions') && req.method === 'POST' && !m[3]) {
      const body = raw ? JSON.parse(raw) : {};
      const pid = rand('perm');
      (f.permissions ||= new Map()).set(pid, body);
      return send(res, 200, { id: pid });
    }
    if (m && m[3] && req.method === 'DELETE') {
      if (!f.permissions?.delete(decodeURIComponent(m[3]))) return refuse(res, 404, 'notFound', 'Permission not found.');
      res.writeHead(204); return res.end();
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
      return send(res, 200, { spreadsheetId: m[1], properties: { title: s.title }, sheets: s.tabs.map((t) => ({ properties: { sheetId: t.sheetId, title: t.title, ...(t.hidden ? { hidden: true } : {}), gridProperties: { rowCount: t.rowCount, columnCount: t.columnCount, frozenRowCount: t.frozen } } })) });
    }
    if (m[3] && req.method === 'GET') {
      // 'Title'!5001:10000 — whole rows; Google leaves out blank cells at a
      // row's end and blank rows at the range's end.
      const range = decodeURIComponent(m[3]);
      const r = range.match(/^'((?:[^']|'')*)'!(\d+):(\d+)$/);
      const t = r && s.tabs.find((x) => x.title === r[1].replace(/''/g, "'"));
      if (!t) return send(res, 400, { error: { code: 400, message: `Unable to parse range: ${range}` } });
      const values = [];
      for (let i = Number(r[2]); i <= Math.min(Number(r[3]), t.rowCount); i += 1) {
        const row = [...((t.data || [])[i - 1] || [])].map((v) => (v == null ? '' : String(v)));
        while (row.length && row.at(-1) === '') row.pop();
        values.push(row);
      }
      while (values.length && !values.at(-1).length) values.pop();
      s.reads = (s.reads || 0) + 1;
      return send(res, 200, { range, majorDimension: 'ROWS', ...(values.length ? { values } : {}) });
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

  // The Picker's dialog: which files this view shows, and the pick itself.
  const cors = { 'access-control-allow-origin': '*' };
  const pickerFiles = (res, raw) => {
    const body = raw ? JSON.parse(raw) : {};
    const t = accessTokens.get(body.token);
    if (!t || !t.alive || !t.scopes.includes(DRIVE_FILE)) return send(res, 401, { error: 'bad token' }, cors);
    const v = (body.views || [])[0] || {};
    const types = v.mimeTypes ? String(v.mimeTypes).split(',') : null;
    const ids = v.fileIds ? String(v.fileIds).split(',') : null;
    const list = [...files.values()].filter((f) => !f.trashed && (f.owner !== 'base.win' || f.ownerSub === t.sub)
      && (v.viewId === 'folders' ? f.mimeType === FOLDER : f.mimeType !== FOLDER)
      && (!types || types.includes(f.mimeType)) && (!ids || ids.includes(f.id)));
    return send(res, 200, { files: list.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType })) }, cors);
  };
  const pickerPick = (res, raw) => {
    const body = raw ? JSON.parse(raw) : {};
    const t = accessTokens.get(body.token);
    if (!t || !t.alive) return send(res, 401, { error: 'bad token' }, cors);
    for (const id of body.ids || []) files.get(id)?.picked?.add(t.sub);
    return send(res, 200, { ok: true }, cors);
  };

  // → true when this request was Drive's, Sheets', tokeninfo's or the Picker's.
  const handle = async (req, res, u, raw, form) => {
    if (u.pathname === '/picker.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(pickerScript(base())); return true; }
    if (u.pathname === '/picker/files' && req.method === 'POST') { pickerFiles(res, raw); return true; }
    if (u.pathname === '/picker/pick' && req.method === 'POST') { pickerPick(res, raw); return true; }
    if (u.pathname.startsWith('/drive/v3/')) { await drive(req, res, u, raw); return true; }
    if (u.pathname.startsWith('/v4/spreadsheets/')) { await sheetsApi(req, res, u, raw); return true; }
    if (u.pathname === '/tokeninfo') { tokeninfo(res, form, u); return true; }
    return false;
  };

  const api = {
    calls, files,
    next: (k, kind, opts = {}) => { knobs[k].push({ kind: String(kind), ...opts }); },
    clear: () => { knobs.drive.length = 0; knobs.sheets.length = 0; calls.length = 0; streams.opened = 0; streams.cut = 0; for (const r of hanging) r.destroy(); hanging.clear(); },
    folder: ({ id = rand('1fold'), name, driveId = null, needsPick = true }) => {
      files.set(id, { id, name, mimeType: FOLDER, parents: [], driveId, needsPick, owner: 'someone', picked: new Set(), webViewLink: `${base()}/open/${id}` });
      return id;
    },
    file: ({ id = rand('1file'), name, mimeType, data = null, size, hideSize = false, pdf = null }) => {
      files.set(id, {
        id, name, mimeType, parents: [], driveId: null, needsPick: true, owner: 'someone', picked: new Set(), webViewLink: `${base()}/open/${id}`,
        data, pdf, size: size ?? (data ? data.length : null), hideSize,
      });
      return id;
    },
    readable: ({ id = rand('1read'), name, tabs }) => {
      files.set(id, { id, name, mimeType: SHEET, parents: [], driveId: null, needsPick: true, owner: 'someone', picked: new Set(), webViewLink: `${base()}/open/${id}` });
      sheets.set(id, {
        title: name, rows: new Map(), writes: [], reads: 0,
        tabs: tabs.map((t, i) => ({ sheetId: i === 0 ? 0 : 1000 + i, title: t.title, rowCount: t.rowCount ?? Math.max(1, t.rows.length), columnCount: 26, frozen: 0, hidden: Boolean(t.hidden), data: t.rows })),
      });
      return id;
    },
    streams,
    pick: (id, sub) => files.get(id).picked.add(sub),
    sheet: (id) => sheets.get(id),
    sheetsMade: () => [...files.values()].filter((f) => f.mimeType === SHEET),
    foldersMade: () => [...files.values()].filter((f) => f.mimeType === FOLDER && f.owner === 'base.win'),
    people,
  };
  return { handle, api };
};

// The stand-in for Google's Picker loader: the same names base.win calls
// (gapi.load, google.picker.PickerBuilder, DocsView, ViewId, Feature,
// Action, Response, Document), recording every call on window.__picker.
const pickerScript = (base) => `(() => {
  const BASE = ${JSON.stringify(base)};
  const rec = window.__picker = window.__picker || { builds: [] };
  const ViewId = { DOCS: 'all', FOLDERS: 'folders', SPREADSHEETS: 'spreadsheets' };
  const Feature = { MULTISELECT_ENABLED: 'multiselect', SUPPORT_DRIVES: 'sdr', NAV_HIDDEN: 'navHidden' };
  const Action = { PICKED: 'picked', CANCEL: 'cancel', LOADED: 'loaded' };
  const Response = { ACTION: 'action', DOCUMENTS: 'docs' };
  const Document = { ID: 'id', NAME: 'name', MIME_TYPE: 'mimeType' };
  class DocsView {
    constructor(id) { this.v = { viewId: id || ViewId.DOCS, mimeTypes: null, fileIds: null, enableDrives: false, includeFolders: false, selectFolder: false, calls: [] }; }
    note(name) { this.v.calls.push(name); return this; }
    setMimeTypes(m) { this.v.mimeTypes = m; return this.note('setMimeTypes'); }
    setEnableDrives(b) { this.v.enableDrives = Boolean(b); return this.note('setEnableDrives'); }
    setFileIds(ids) { this.v.fileIds = ids; return this.note('setFileIds'); }
    setIncludeFolders(b) { this.v.includeFolders = Boolean(b); return this.note('setIncludeFolders'); }
    setSelectFolderEnabled(b) { this.v.selectFolder = Boolean(b); return this.note('setSelectFolderEnabled'); }
    setMode() { return this; }
    setParent() { return this; }
  }
  const el = (tag, attrs, text) => { const e = document.createElement(tag); Object.assign(e, attrs || {}); if (text != null) e.textContent = text; return e; };
  const open = async (b, cb) => {
    const last = { appId: b.appId, token: b.token, key: b.key, title: b.title, views: b.views, multiselect: b.features.includes(Feature.MULTISELECT_ENABLED), features: b.features, maxItems: b.maxItems };
    rec.last = last; rec.builds.push(last);
    const r = await fetch(BASE + '/picker/files', { method: 'POST', body: JSON.stringify({ token: b.token, views: b.views }) });
    const list = r.ok ? (await r.json()).files : [];
    const d = el('div', { id: 'fake-picker' });
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-label', b.title || 'Google Drive');
    d.style.cssText = 'position:fixed;inset:10% 20%;background:white;color:black;border:1px solid #888;padding:16px;z-index:9999;overflow:auto;font:15px sans-serif';
    d.append(el('h2', {}, b.title || 'Google Drive'));
    if (!r.ok) d.append(el('p', { className: 'fake-picker-error' }, 'The token was refused'));
    for (const f of list) {
      const l = el('label', { className: 'fake-picker-file' });
      l.style.cssText = 'display:block;padding:6px 0';
      const box = el('input', { type: last.multiselect ? 'checkbox' : 'radio', name: 'fake-picker-pick', value: f.id });
      box.dataset.name = f.name; box.dataset.mime = f.mimeType;
      l.append(box, ' ' + f.name);
      d.append(l);
    }
    const close = () => d.remove();
    const sel = el('button', { id: 'fake-picker-select', type: 'button' }, 'Select');
    const cancel = el('button', { id: 'fake-picker-cancel', type: 'button' }, 'Cancel');
    sel.onclick = async () => {
      const boxes = [...d.querySelectorAll('input:checked')];
      const docs = boxes.map((x) => ({ [Document.ID]: x.value, [Document.NAME]: x.dataset.name, [Document.MIME_TYPE]: x.dataset.mime }));
      await fetch(BASE + '/picker/pick', { method: 'POST', body: JSON.stringify({ token: b.token, ids: docs.map((x) => x.id) }) });
      close();
      cb({ [Response.ACTION]: Action.PICKED, [Response.DOCUMENTS]: docs });
    };
    cancel.onclick = () => { close(); cb({ [Response.ACTION]: Action.CANCEL }); };
    d.append(sel, ' ', cancel);
    document.body.append(d);
    cb({ [Response.ACTION]: Action.LOADED });
  };
  class PickerBuilder {
    constructor() { this.b = { views: [], features: [], title: '', maxItems: null }; this.cb = () => {}; }
    setAppId(x) { this.b.appId = x; return this; }
    setOAuthToken(x) { this.b.token = x; return this; }
    setDeveloperKey(x) { this.b.key = x; return this; }
    addView(v) { this.b.views.push(v.v); return this; }
    setTitle(t) { this.b.title = t; return this; }
    enableFeature(f) { this.b.features.push(f); return this; }
    setMaxItems(n) { this.b.maxItems = n; return this; }
    setCallback(fn) { this.cb = fn; return this; }
    setOrigin() { return this; }
    setLocale() { return this; }
    build() { const b = this.b; const cb = this.cb; return { setVisible(on) { if (on) open(b, cb); }, dispose() {} }; }
  }
  window.gapi = window.gapi || {};
  window.gapi.load = (name, then) => {
    window.google = window.google || {};
    window.google.picker = { DocsView, ViewId, Feature, Action, Response, Document, PickerBuilder };
    setTimeout(typeof then === 'function' ? then : then.callback, 0);
  };
})();
`;
