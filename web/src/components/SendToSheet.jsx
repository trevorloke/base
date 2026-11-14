// "Send to Google Sheets", under "Take it out" (decision 15; server
// ext/drive drive.export). Drawn only when GET /api/drive says canSend:
// otherwise every page looks exactly as before.
//   <TakeItOut csvHref csvLabel source of name count head noun />
//     Lists and Reports: one quiet "Take it out" holding Download CSV and
//     Send to Google Sheets (or, without canSend, just the CSV link as before)
//   <SendToSheet source of name count head noun label csvHref />
//     the button and what it opens: the confirm (where it lands; whether it
//     holds people who asked not to be contacted), the progress read every
//     2 s, "In Google Sheets · Open", or the words of what stopped it and
//     Try again. Leaving the page doesn't stop it; Import & export lists it.
//   source 'list' | 'report' | 'dataset'; of: the list id or the name
//   head   the columns, so the do-not-contact line is said when they hold
//          an email or a phone
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet } from '../api.js';
import { NeedsSignal, useOnline } from './NoSignal.jsx';
import { DriveConnect, DriveToast, num, useDrive, useDriveToast, usePickFromDrive, whereSheetsGo } from './DriveBits.jsx';

const CONTACT = /email|phone|mobile|cell/i;
const going = (e) => e && (e.status === 'waiting' || e.status === 'sending');
const newKey = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID()
  : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (Math.random() * 16) >> (c / 4)).toString(16)));

// One export, as it stands: read every 2 s while it's going.
export const useExport = (id) => useQuery({
  queryKey: ['drive', 'export', id],
  queryFn: () => apiGet(`/drive/exports/${id}`).then((r) => r.export),
  enabled: Boolean(id),
  refetchInterval: (q) => (going(q.state.data) || !q.state.data ? 2000 : false),
  retry: false,
});

// What stopped it, and what to do: Try again, choose the campaign folder, or connect again.
export function Stopped({ e, d, online, onAgain }) {
  const qc = useQueryClient();
  const picker = usePickFromDrive(e.said === 'pick-folder');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [reached, setReached] = useState(false);
  const again = async () => {
    setBusy(true); setError(null);
    try {
      await action('drive.export.retry', { id: e.id });
      await qc.invalidateQueries({ queryKey: ['drive'] });
      onAgain?.();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const reach = async () => {
    setError(null);
    const folder = d?.land?.kind === 'campaign' ? { id: d.land.id, name: d.land.name } : null;
    if (!folder) { setError('No campaign folder is set any more — Try again'); setReached(true); return; }
    const docs = await picker.pick('this-folder', { folder });
    if (!docs?.length) return;
    setBusy(true);
    try {
      await action('drive.folder.reach', { file_id: docs[0].id });
      setReached(true);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  if (e.said === 'reconnect') return <DriveConnect />;
  const folderFirst = e.said === 'pick-folder' && !reached;
  return (
    <div className="drv-stop">
      <p className="drv-said" role="status">
        {e.said === 'pick-folder' ? (reached ? '✓ base.win can save there now' : 'Choose the campaign folder once so base.win can save there') : (e.said || 'It stopped part-way')}
      </p>
      <div className="drv-acts">
        {folderFirst && picker.need === 'connect' ? <DriveConnect /> : folderFirst ? (
          <button type="button" className="btn btn-quiet ops-tap" disabled={busy || !online} onClick={reach}>Choose the campaign folder</button>
        ) : (
          <button type="button" className="btn btn-quiet ops-tap" disabled={busy || !online} onClick={again}>{busy ? 'Starting…' : 'Try again'}</button>
        )}
      </div>
      {picker.error && <p className="error" role="alert">{picker.error}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

// "Sending to Google Sheets… 4,000 of 12,408", a bar, and "Needs signal — still sending" without signal.
export function Progress({ e, online }) {
  const pct = e.rows ? Math.min(100, Math.round((e.done_rows / e.rows) * 100)) : 0;
  return (
    <div className="drv-progress">
      <p role="status">{online ? <>Sending to Google Sheets… {num(e.done_rows)} of {num(e.rows)}</> : 'Needs signal — still sending'}</p>
      <div className="drv-bar" role="progressbar" aria-label="Sent to Google Sheets" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function SendToSheet({ source, of, name, count = null, head = [], noun = 'people', label = 'Send to Google Sheets', csvHref = null }) {
  const d = useDrive();
  const online = useOnline();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(null);
  const [id, setId] = useState(null);
  const back = useDriveToast();
  const [said, setSaid] = useState(null);
  const ex = useExport(id);
  const e = ex.data;
  // Done: one toast, and the "Sent to Google Drive" list reads again.
  useEffect(() => {
    if (e?.status !== 'done') return undefined;
    setSaid('Sent to Google Sheets');
    qc.invalidateQueries({ queryKey: ['drive', 'exports'] });
    const t = setTimeout(() => setSaid(null), 4000);
    return () => clearTimeout(t);
  }, [e?.id, e?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d.data?.canSend) return null;
  const me = d.data.me;
  const connected = me?.connected && me.state === 'ok';
  const contact = head.some((h) => CONTACT.test(String(h)));
  const what = count != null ? `${num(count)} ${noun}` : `“${name}”`;
  const close = () => { setOpen(false); setRefused(null); };
  const send = async () => {
    setBusy(true); setRefused(null);
    try {
      const r = await action('drive.export', { source, ref: String(of), client_key: newKey() });
      setId(r.export.id);
      setOpen(false);
    } catch (err) {
      setRefused({ words: err.message, big: /^Too big for one Google Sheet/.test(err.message) });
    } finally { setBusy(false); }
  };
  const showing = id && e;
  return (
    <>
      {!showing || !going(e) ? (
        <button type="button" className="btn btn-quiet ops-tap" aria-expanded={open} disabled={!online && !open}
          onClick={() => (open ? close() : (setId(null), setOpen(true)))}>{label}</button>
      ) : null}
      {(open || showing || (id && !e)) && (
        <div className="drv-panel" role="group" aria-label="Google Sheets">
          {open && !connected && <DriveConnect />}
          {open && connected && count === 0 && <p role="status">Nothing to send yet</p>}
          {open && connected && count !== 0 && (
            <div className="drv-ask">
              <p className="drv-ask__q">Send {what} to a new Google Sheet in {whereSheetsGo(d.data.land)}?</p>
              {contact && <p className="drv-line">It includes people who asked not to be contacted.</p>}
              <div className="drv-acts">
                <button type="button" className="btn btn-quiet ops-tap" disabled={busy || !online} onClick={send}>{busy ? 'Sending…' : 'Send'}</button>
                <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={close}>Cancel</button>
              </div>
              {!online && <NeedsSignal className="drv-line" />}
              {refused && (
                <p className="error" role="alert">{refused.words}
                  {refused.big && csvHref && <> <a className="btn btn-quiet ops-tap" href={csvHref}>Download CSV</a></>}</p>
              )}
            </div>
          )}
          {id && !e && (ex.isError ? (
            <p role="status">Unavailable — <button type="button" className="btn btn-quiet" onClick={() => ex.refetch()}>Try again</button></p>
          ) : <p role="status">Loading…</p>)}
          {showing && going(e) && <Progress e={e} online={online} />}
          {showing && e.status === 'done' && (
            <p className="drv-done" role="status">In Google Sheets{' '}
              <a className="btn btn-quiet ops-tap" href={e.url} target="_blank" rel="noopener noreferrer">Open<span className="drv-sr"> {name || 'the Sheet'}</span></a>
              {e.said && <span className="drv-line"> {e.said}</span>}</p>
          )}
          {showing && (e.status === 'failed' || e.status === 'stopped') && (
            <Stopped e={e} d={d.data} online={online} onAgain={() => ex.refetch()} />
          )}
        </div>
      )}
      <DriveToast text={said || back.text} />
    </>
  );
}

// Lists and Reports: one quiet "Take it out" in place of the CSV link,
// only when Sheets may be sent from here — the row keeps its count of buttons.
export function TakeItOut({ csvHref, csvLabel = 'Download CSV', ...sheet }) {
  const d = useDrive();
  const [open, setOpen] = useState(false);
  if (!d.data?.canSend) return <a className="btn btn-quiet ops-tap" href={csvHref}>{csvLabel}</a>;
  return (
    <span className={`drv-take${open ? ' is-open' : ''}`}>
      <button type="button" className="btn btn-quiet disclose disclose--inline ops-tap" aria-expanded={open} onClick={() => setOpen((v) => !v)}>Take it out</button>
      {/* Kept while closed, so a Sheet on its way keeps its progress line. */}
      <span className="drv-take__menu" hidden={!open}>
        <a className="btn btn-quiet ops-tap" href={csvHref}>Download CSV</a>
        <SendToSheet {...sheet} csvHref={csvHref} />
      </span>
    </span>
  );
}
