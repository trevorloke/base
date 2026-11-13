// People → Import: "From Google Drive", beside "Paste text" (decision 13).
// Only where the file comes from changes: a picked Google Sheet's tab
// arrives as CSV text for the importer's loadText, a CSV or Excel file in
// Drive as a File for its loadFile — the size check, the workbook reader,
// the column matching and every message after are the importer's own.
//   <DriveImport busy reading setReading setLoadError loadText loadFile />
import { useState } from 'react';
import { apiGet } from '../api.js';
import { at } from '../base.js';
import { NeedsSignal, useOnline } from './NoSignal.jsx';
import { DriveConnect, DriveToast, driveOn, mb, useDrive, useDriveToast, usePickFromDrive } from './DriveBits.jsx';

const READING = 'Reading from Google Drive…';
const STOPPED = 'Google Drive stopped sending — Try again';
const CHIPS = 8;
const refusal = async (res) => (await res.json().catch(() => ({}))).error || STOPPED;

export default function DriveImport({ busy, setReading, setLoadError, loadText, loadFile }) {
  const d = useDrive();
  const on = driveOn(d.data);
  const online = useOnline();
  const toast = useDriveToast();
  const picker = usePickFromDrive(on);
  const [sheet, setSheet] = useState(null); // { id, name, tabs } while asking "Which tab?"
  const [more, setMore] = useState(false);
  if (!on) return null;

  const readTab = async (file, tab) => {
    setSheet(null);
    setLoadError(null);
    setReading(READING);
    try {
      const res = await fetch(at(`/api/drive/files/${encodeURIComponent(file.id)}/tabs/${tab.id}.csv`), { credentials: 'same-origin' });
      if (!res.ok) { setLoadError(await refusal(res)); return; }
      const text = await res.text();
      await loadText(text, `${file.name} · ${tab.title} (Google Drive)`, new Blob([text]).size);
    } catch {
      setLoadError(STOPPED);
    } finally {
      setReading(null);
    }
  };
  // A CSV or Excel file: its bytes as they come ("12.4 MB of 182 MB"), then the importer's own loadFile.
  const readContent = async (file) => {
    setLoadError(null);
    setReading(READING);
    let handed = false;
    try {
      const res = await fetch(at(`/api/drive/files/${encodeURIComponent(file.id)}/content`), { credentials: 'same-origin' });
      if (!res.ok) { setLoadError(await refusal(res)); return; }
      const total = Number(res.headers.get('content-length')) || 0;
      const parts = [];
      let got = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        setReading(total ? `${READING} ${mb(got)} of ${mb(total)}` : `${READING} ${mb(got)}`);
      }
      if (total && got < total) { setLoadError(STOPPED); return; }
      const ext = file.kind === 'xlsx' ? '.xlsx' : '.csv';
      const name = /\.[a-z0-9]{2,5}$/i.test(file.name) ? file.name : `${file.name}${ext}`;
      handed = true;
      await loadFile(new File(parts, name));
    } catch {
      setLoadError(STOPPED);
    } finally {
      if (!handed) setReading(null);
    }
  };

  const fromDrive = async () => {
    setLoadError(null);
    setSheet(null);
    const docs = await picker.pick('table');
    if (!docs?.length) return;
    setReading(READING);
    let file;
    try {
      file = await apiGet(`/drive/files/${encodeURIComponent(docs[0].id)}`);
    } catch (e) {
      setReading(null);
      setLoadError(e.message);
      return;
    }
    setReading(null);
    if (file.kind === 'sheet') {
      if (!file.tabs?.length) { setLoadError('That Sheet has no tabs to read'); return; }
      if (file.tabs.length === 1) { await readTab(file, file.tabs[0]); return; }
      setMore(false);
      setSheet(file);
      return;
    }
    if (file.kind === 'csv' || file.kind === 'xlsx') { await readContent(file); return; }
    setLoadError('Pick a Google Sheet, a CSV or an Excel file');
  };

  const tabs = sheet ? (more ? sheet.tabs : sheet.tabs.slice(0, CHIPS)) : [];
  return (
    <>
      {picker.need === 'connect' ? <DriveConnect /> : (
        <button type="button" className="btn btn-quiet imp-tap" disabled={busy || !online} onClick={fromDrive}>From Google Drive</button>
      )}
      {!online && <NeedsSignal className="drv-line" />}
      {picker.error && <p className="error" role="alert">{picker.error}</p>}
      {sheet && (
        <div className="drv-tabs" role="group" aria-label="Which tab?">
          <p className="drv-tabs__q">Which tab? <span className="muted">{sheet.name}</span></p>
          <div className="drv-chips">
            {tabs.map((t) => (
              <button key={t.id} type="button" className="chip drv-chip" disabled={busy || !online} onClick={() => readTab(sheet, t)}>
                {t.title}
              </button>
            ))}
            {!more && sheet.tabs.length > CHIPS && (
              <button type="button" className="btn btn-quiet disclose disclose--inline" aria-expanded={false} onClick={() => setMore(true)}>More</button>
            )}
          </div>
        </div>
      )}
      <DriveToast text={toast.text} />
    </>
  );
}
