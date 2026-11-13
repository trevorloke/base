// The compose's "From Google Drive" (Outreach → Email, Media → Write a
// release; decision 14). Each picked file becomes an ordinary attachment
// (acts.attachDrive), listed like an uploaded one. A file too big to attach
// gets a row of its own with "Add a link instead": who can open the link
// (the people it's shared with in Drive, or anyone with it), then the link
// goes at the end of the message (acts.linkDrive).
//   const drive = useDriveAttach({ acts, count, max, online, busy, onAdded, onLink, back })
//   drive.on      Drive is set up and on here (draw the PDF clause)
//   drive.adding  the name being added ("Adding <name>…"), or null
//   drive.button  the quiet button (or Connect Google Drive in its place)
//   drive.rows    the too-big rows, each with its link choice
import { useState } from 'react';
import { action } from '../api.js';
import { DriveConnect, driveOn, useDrive, usePickFromDrive } from './DriveBits.jsx';

const WHO = [
  [false, 'People it’s shared with in Drive'],
  [true, 'Anyone with the link'],
];

function TooBig({ row, acts, online, onLink, onDone }) {
  const [asking, setAsking] = useState(false);
  const [anyone, setAnyone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const add = async () => {
    setBusy(true); setError(null);
    try {
      const r = await action(acts.linkDrive, { file_id: row.id, anyone });
      onLink(`[${r.name}](${r.url})`);
      onDone();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="ot-file drv-big">
      <span className="ot-file__name">{row.words}</span>
      {!asking ? (
        <button type="button" className="btn btn-quiet ot-btn-tap" disabled={!online} onClick={() => setAsking(true)}>Add a link instead</button>
      ) : (
        <div className="drv-ask" role="group" aria-label={`A link to ${row.name}`}>
          <p className="drv-ask__q" id={`drv-who-${row.id}`}>Who can open the link?</p>
          <div className="drv-chips" role="radiogroup" aria-labelledby={`drv-who-${row.id}`}>
            {WHO.map(([v, label]) => (
              <button key={label} type="button" role="radio" aria-checked={anyone === v} className={`chip drv-chip${anyone === v ? ' is-on' : ''}`} onClick={() => setAnyone(v)}>{label}</button>
            ))}
          </div>
          {anyone && <p className="drv-line">Anyone who gets this can open it, and pass it on.</p>}
          <div className="drv-acts">
            <button type="button" className="btn btn-quiet ot-btn-tap" disabled={busy || !online} onClick={add}>{busy ? 'Adding…' : 'Add link'}</button>
            <button type="button" className="btn btn-quiet ot-btn-tap" disabled={busy} onClick={() => { setAsking(false); setError(null); }}>Cancel</button>
          </div>
        </div>
      )}
      {error && <p className="error drv-wide" role="alert">{error}</p>}
    </li>
  );
}

export function useDriveAttach({ acts, count, max, online, busy, onAdded, onLink, onNote }) {
  const d = useDrive();
  const on = driveOn(d.data) && Boolean(acts.attachDrive);
  const picker = usePickFromDrive(on);
  const [adding, setAdding] = useState(null);
  const [big, setBig] = useState([]); // [{ id, name, words }]
  const room = max - count;

  const fromDrive = async () => {
    onNote(null);
    const docs = await picker.pick('attach', { max: room });
    if (!docs?.length) return;
    const notes = [];
    for (const doc of docs.slice(0, room)) {
      setAdding(doc.name);
      try {
        const r = await action(acts.attachDrive, { file_id: doc.id });
        onAdded(r.attachment);
      } catch (e) {
        if (e.body?.link) setBig((cur) => [...cur.filter((x) => x.id !== doc.id), { id: doc.id, name: doc.name, words: e.message }]);
        else notes.push(e.message);
      }
    }
    setAdding(null);
    if (docs.length > room) notes.push(`${max} files at most on one send`);
    if (notes.length) onNote(notes.join(' · '));
  };

  const button = !on ? null : picker.need === 'connect' ? <DriveConnect /> : (
    <button type="button" className="btn btn-quiet ot-btn-tap" disabled={busy || Boolean(adding) || room <= 0 || !online} onClick={fromDrive}>
      {adding ? 'Adding…' : 'From Google Drive'}
    </button>
  );
  const rows = big.length ? (
    <ul className="ot-files drv-bigs" aria-label="Too big to attach">
      {big.map((row) => (
        <TooBig key={row.id} row={row} acts={acts} online={online} onLink={onLink}
          onDone={() => setBig((cur) => cur.filter((x) => x.id !== row.id))} />
      ))}
    </ul>
  ) : null;
  return { on, adding, button, rows, error: picker.error };
}
