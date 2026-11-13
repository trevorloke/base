// Google's Picker: the one way base.win learns which Drive files someone
// means. base.win only ever sees the files picked here (drive.file).
//
//   pickFromDrive({ kind, max, folder, picker }) → [{ id, name, mimeType }], [] on Cancel
//     kind    'table'        a Google Sheet, a CSV or an Excel file (People → Import)
//             'attach'       any file but a folder, up to max (the compose)
//             'folder'       a folder, shared drives shown (Settings → Services)
//             'this-folder'  the campaign folder itself ({ folder: { id, name } }),
//                            so this person's base.win may put Sheets in it
//     picker  GET /api/drive/picker's answer (token, apiKey, appId, script),
//             fetched when the page opened (useDrivePicker), so the tap
//             opens the Picker without waiting on the network
//
// Loading Google's script and the Picker has 10 seconds; over it, or a
// script that won't load: "Google Drive didn’t open — Try again". A picked
// id is kept nowhere but the call that follows.
export const OPEN_FAILED = 'Google Drive didn’t open — Try again';
const LIMIT_MS = 10_000;
const TABLES = [
  'application/vnd.google-apps.spreadsheet', 'text/csv', 'text/tab-separated-values', 'text/plain',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
].join(',');

let loading = null; // the script, once per page (again after a failure)
const loadScript = (src) => {
  if (window.gapi?.load) return Promise.resolve();
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { s.remove(); reject(new Error(OPEN_FAILED)); };
      document.head.append(s);
    }).catch((e) => { loading = null; throw e; });
  }
  return loading;
};
const withLimit = (p) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(OPEN_FAILED)), LIMIT_MS);
  p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); reject(new Error(OPEN_FAILED)); });
});
const pickerReady = async (script) => {
  await loadScript(script);
  if (window.google?.picker?.PickerBuilder) return;
  await new Promise((resolve, reject) => {
    if (!window.gapi?.load) { reject(new Error(OPEN_FAILED)); return; }
    window.gapi.load('picker', { callback: resolve, onerror: reject });
  });
};

const viewFor = (g, kind, folder) => {
  if (kind === 'folder') {
    return new g.DocsView(g.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true).setEnableDrives(true);
  }
  // Without setEnableDrives: it would override setFileIds (Google's own note).
  if (kind === 'this-folder') {
    return new g.DocsView(g.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true).setFileIds(folder.id);
  }
  if (kind === 'table') return new g.DocsView(g.ViewId.DOCS).setMimeTypes(TABLES).setEnableDrives(true);
  return new g.DocsView(g.ViewId.DOCS).setEnableDrives(true);
};
const TITLES = {
  table: () => 'Pick a sheet or a spreadsheet file',
  attach: () => 'Pick files to attach',
  folder: () => 'Pick the folder new Sheets go in',
  'this-folder': (folder) => `Select ${folder?.name || 'the campaign folder'}, then press Select`,
};

export async function pickFromDrive({ kind, max = 1, folder = null, picker }) {
  if (!picker?.token) throw new Error(OPEN_FAILED);
  await withLimit(pickerReady(picker.script));
  const g = window.google.picker;
  return new Promise((resolve) => {
    const builder = new g.PickerBuilder()
      .setAppId(picker.appId)
      .setOAuthToken(picker.token)
      .setDeveloperKey(picker.apiKey)
      .setTitle(TITLES[kind](folder))
      .addView(viewFor(g, kind, folder))
      .setCallback((data) => {
        const what = data[g.Response.ACTION];
        if (what === g.Action.PICKED) {
          resolve((data[g.Response.DOCUMENTS] || []).map((d) => ({
            id: d[g.Document.ID], name: d[g.Document.NAME], mimeType: d[g.Document.MIME_TYPE],
          })));
        } else if (what === g.Action.CANCEL) resolve([]);
      });
    if (kind !== 'this-folder') builder.enableFeature(g.Feature.SUPPORT_DRIVES);
    if (kind === 'attach' && max > 1) builder.enableFeature(g.Feature.MULTISELECT_ENABLED).setMaxItems(max);
    builder.build().setVisible(true);
  });
}
