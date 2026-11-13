// Drive over plain fetch, through GSI's googleFetch (10 s, one refresh on a
// 401, pauses; it never throws — Google's refusals come back as trouble).
// Never inside a write: these are called with the plain db.
//
//   getFile(db, g, id)              → { ok, file: { id, name, mimeType, size, url, driveId } } | refused
//   kindOf(file)                    sheet | csv | xlsx | folder | google | other
//   mediaUrl(id) / pdfUrl(id)       a file's own bytes (200 units) / a Google file as PDF (200)
//   openToAnyone(db, g, id)         → { ok, permissionId } | refused   (anyone, reader, no email)
//   closePermission(db, g, id, pid) → { ok } | refused   (Google's 404 counts as closed)
//   exportsFolder(db, g)            → { ok, id } | refused   ("base.win exports", made once)
//   makeSheet(db, g, { name, parent, exportId }) → { ok, id, url } | refused
//       found again by its export's id (appProperties) before it is ever
//       made twice: the key that makes the create safe to repeat
//   about(db, g)                    → googleFetch's answer
//   refusal(r)                      → { code, plain, reason } of a refused answer
import { googleFetch } from '../../lib/google/tokens.js';
import { googleTrouble } from '../../lib/googleerr.js';
import { driveBase } from './config.js';

export const FOLDER = 'application/vnd.google-apps.folder';
export const SHEET = 'application/vnd.google-apps.spreadsheet';
export const EXPORTS_FOLDER = 'base.win exports';

const files = (path = '', q = {}) => `${driveBase()}/drive/v3/files${path}?${new URLSearchParams({ supportsAllDrives: 'true', ...q })}`;
const quote = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const reasonOf = (body) => body?.error?.errors?.[0]?.reason || body?.error?.details?.find?.((d) => d?.reason)?.reason || null;
// Plain words for an answer Google refused (decision 11), and its reason.
export const refusal = (r) => {
  const t = googleTrouble(r.status, r.body || {}, { service: 'drive' });
  return { code: t.code, plain: t.plain, reason: reasonOf(r.body), status: r.status, trouble: r.trouble || null };
};
const refused = (r) => ({ ok: false, ...refusal(r), trouble: r.trouble || null, reached: r.reached });

export const getFile = async (db, g, id) => {
  const r = await googleFetch(db, g, files(`/${encodeURIComponent(id)}`, { fields: 'id,name,mimeType,size,webViewLink,driveId' }));
  if (!r.ok) return refused(r);
  const b = r.body || {};
  const size = b.size == null || b.size === '' ? null : Number(b.size);
  return {
    ok: true,
    file: { id: b.id, name: String(b.name || 'Untitled'), mimeType: String(b.mimeType || ''), size: Number.isFinite(size) ? size : null, url: b.webViewLink || null, driveId: b.driveId || null },
  };
};

// What a picked file is, for the importer and the compose.
const GOOGLE = 'application/vnd.google-apps.';
const CSVISH = ['text/csv', 'text/tab-separated-values', 'text/plain'];
export const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const kindOf = (f) => {
  const ext = String(f.name || '').toLowerCase().split('.').pop();
  if (f.mimeType === SHEET) return 'sheet';
  if (f.mimeType === FOLDER) return 'folder';
  if (f.mimeType.startsWith(GOOGLE)) return 'google';
  if (f.mimeType === XLSX || ext === 'xlsx') return 'xlsx';
  if (CSVISH.includes(f.mimeType) || ['csv', 'tsv'].includes(ext)) return 'csv';
  return 'other';
};
// Google-made files that go as a PDF (Docs, Sheets, Slides, Drawings).
export const AS_PDF = ['document', 'spreadsheet', 'presentation', 'drawing'].map((k) => GOOGLE + k);

export const mediaUrl = (id) => files(`/${encodeURIComponent(id)}`, { alt: 'media' });
export const pdfUrl = (id) => `${driveBase()}/drive/v3/files/${encodeURIComponent(id)}/export?${new URLSearchParams({ mimeType: 'application/pdf' })}`;

// "Anyone with the link can view": Google refuses sendNotificationEmail for
// this type, so it is never sent. Never repeated on its own.
export const openToAnyone = async (db, g, id) => {
  const r = await googleFetch(db, g, files(`/${encodeURIComponent(id)}/permissions`, { fields: 'id' }), json({ type: 'anyone', role: 'reader' }), { retry: 'auth-only' });
  return r.ok && r.body?.id ? { ok: true, permissionId: String(r.body.id) } : refused(r);
};
export const closePermission = async (db, g, id, pid) => {
  const r = await googleFetch(db, g, files(`/${encodeURIComponent(id)}/permissions/${encodeURIComponent(pid)}`), { method: 'DELETE' });
  return r.ok || r.status === 404 ? { ok: true } : refused(r);
};

const listOne = async (db, g, q) => {
  const r = await googleFetch(db, g, files('', { q, fields: 'files(id,name,webViewLink)', pageSize: '1', includeItemsFromAllDrives: 'true' }));
  if (!r.ok) return refused(r);
  return { ok: true, file: r.body?.files?.[0] || null };
};

// The person's own "base.win exports": drive.file lets base.win find a
// folder it made (5 units), else it makes one (50).
export const exportsFolder = async (db, g) => {
  const found = await listOne(db, g, `name='${quote(EXPORTS_FOLDER)}' and mimeType='${FOLDER}' and trashed=false`);
  if (!found.ok || found.file) return found.ok ? { ok: true, id: found.file.id } : found;
  // A create is never repeated on its own (a second folder is worse than a Try again).
  const r = await googleFetch(db, g, files('', { fields: 'id' }), json({ name: EXPORTS_FOLDER, mimeType: FOLDER }), { retry: 'auth-only' });
  return r.ok ? { ok: true, id: r.body.id } : refused(r);
};

export const makeSheet = async (db, g, { name, parent, exportId }) => {
  const mark = `appProperties has { key='basewin_export' and value='${quote(exportId)}' } and trashed=false`;
  const found = await listOne(db, g, mark);
  if (!found.ok) return found;
  if (found.file) return { ok: true, id: found.file.id, url: found.file.webViewLink || null };
  const r = await googleFetch(db, g, files('', { fields: 'id,webViewLink' }), json({
    name, mimeType: SHEET, parents: [parent], appProperties: { basewin_export: exportId },
  }), { retry: 'auth-only' });
  return r.ok ? { ok: true, id: r.body.id, url: r.body.webViewLink || null } : refused(r);
};

export const about = (db, g) => googleFetch(db, g, `${driveBase()}/drive/v3/about?fields=kind`);
