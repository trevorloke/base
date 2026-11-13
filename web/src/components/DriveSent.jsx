// Import & export → "Sent to Google Drive" (decision 16): the Sheets sent
// from base.win (your last 10; managers: everyone's, with More) and the
// links opened to anyone that are still open, each with "Make private
// again" for the person who opened it. Drawn when Drive is on and there is
// something to show; what's sent stays in Google when someone leaves, so
// this is where to look.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet } from '../api.js';
import { useOnline } from './NoSignal.jsx';
import { driveOn, num, useDrive } from './DriveBits.jsx';
import { Progress, Stopped } from './SendToSheet.jsx';

const going = (e) => e.status === 'waiting' || e.status === 'sending';
// "13 Nov, 10:56 am", in the campaign's time zone (not this computer's).
const when = (iso, tz, time = true) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const fmt = (opts) => {
    try { return new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: tz || undefined }).formatToParts(d); } catch { return new Intl.DateTimeFormat('en-CA', opts).formatToParts(d); }
  };
  const part = (parts, type) => parts.find((p) => p.type === type)?.value || '';
  const p = fmt({ day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
  const day = `${part(p, 'day')} ${part(p, 'month').replace('.', '')}`;
  if (!time) return day;
  return `${day}, ${part(p, 'hour')}:${part(p, 'minute')} ${part(p, 'dayPeriod').replace(/\./g, '').toLowerCase()}`;
};
const chip = (e) => {
  if (e.status === 'done') return ['Done', 'chip-ok'];
  if (e.status === 'sending') return [`Sending ${e.rows ? Math.floor((e.done_rows / e.rows) * 100) : 0}%`, ''];
  if (e.status === 'waiting') return ['Waiting', ''];
  if (e.status === 'stopped') return ['Stopped', 'chip-warn'];
  return ['Failed', 'chip-warn'];
};
const firstName = (n) => String(n || '').split(/\s+/)[0] || 'them';

function SheetRow({ e, d, manager, online, tz }) {
  const [label, cls] = chip(e);
  const where = e.land === 'campaign' ? `In ${e.land_name || 'the campaign folder'}` : `In ${e.mine ? 'your' : `${firstName(e.by)}’s`} Google Drive`;
  return (
    <li className="drv-row">
      <div className="drv-row__main">
        <span className="drv-row__name">{e.name}</span>
        <span className="drv-row__facts">
          <span className={`chip ${cls}`}>{label}</span> {when(e.created_at, tz)}{manager ? <> · {e.mine ? 'by you' : `by ${e.by}`} · {where}</> : null}
        </span>
      </div>
      {e.status === 'done' && e.url && <a className="btn btn-quiet ops-tap" href={e.url} target="_blank" rel="noopener noreferrer">Open<span className="drv-sr"> {e.name}</span></a>}
      {going(e) && <div className="drv-wide"><Progress e={e} online={online} /></div>}
      {(e.status === 'failed' || e.status === 'stopped') && (e.mine || manager) && <div className="drv-wide"><Stopped e={e} d={d} online={online} /></div>}
    </li>
  );
}

function LinkRow({ l, online, onClosed, tz }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const close = async () => {
    setBusy(true); setError(null);
    try { await action('drive.link.close', { id: l.id }); await onClosed(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <li className="drv-row">
      <div className="drv-row__main">
        <span className="drv-row__name">{l.name}</span>
        <span className="drv-row__facts">{l.mine ? 'by you' : `by ${l.by}`} · {when(l.created_at, tz, false)}</span>
      </div>
      {l.mine ? (
        <button type="button" className="btn btn-quiet ops-tap" disabled={busy || !online} onClick={close}>{busy ? 'Closing…' : 'Make private again'}</button>
      ) : (
        <span className="drv-row__other">
          <a className="btn btn-quiet ops-tap" href={l.url} target="_blank" rel="noopener noreferrer">Open in Drive</a>
          <span className="drv-line">{l.left ? `${l.by} left — change it in Drive` : `Ask ${firstName(l.by)}, or change it in Drive`}</span>
        </span>
      )}
      {error && <p className="error drv-wide" role="alert">{error}</p>}
    </li>
  );
}

export default function DriveSent({ tz = null }) {
  const d = useDrive();
  const on = driveOn(d.data);
  const online = useOnline();
  const qc = useQueryClient();
  const [more, setMore] = useState(false);
  const sheets = useQuery({
    queryKey: ['drive', 'exports'], queryFn: () => apiGet('/drive/exports'), enabled: on, retry: false,
    refetchInterval: (q) => (q.state.data?.exports?.some(going) ? 2000 : false),
  });
  const older = useQuery({ queryKey: ['drive', 'exports', 'more'], queryFn: () => apiGet('/drive/exports?more=1'), enabled: on && more, retry: false });
  const links = useQuery({ queryKey: ['drive', 'links'], queryFn: () => apiGet('/drive/links'), enabled: on, retry: false });
  if (!on) return null;
  const manager = d.data.me && Object.prototype.hasOwnProperty.call(d.data, 'connected');
  const ex = [...(sheets.data?.exports || []), ...(more ? older.data?.exports || [] : [])];
  const open = links.data?.links || [];
  const loading = sheets.isPending || links.isPending;
  const failed = sheets.isError || links.isError;
  if (!loading && !failed && !ex.length && !open.length) return null;
  return (
    <section className="dt-sec drv-sent" aria-labelledby="dt-drive">
      <h2 id="dt-drive">Sent to Google Drive</h2>
      {loading && <p className="ops-meta" role="status">Loading…</p>}
      {failed && (
        <p className="ops-meta" role="status">Unavailable — <button type="button" className="btn btn-quiet" onClick={() => { sheets.refetch(); links.refetch(); }}>Try again</button></p>
      )}
      {ex.length > 0 && (
        <>
          <h3 className="drv-h3">Sheets</h3>
          <ul className="drv-rows">{ex.map((e) => <SheetRow key={e.id} e={e} d={d.data} manager={manager} online={online} tz={tz} />)}</ul>
          {manager && !more && (sheets.data?.exports?.length || 0) >= 10 && (
            <button type="button" className="btn btn-quiet disclose disclose--inline" aria-expanded={false} onClick={() => setMore(true)}>More</button>
          )}
          {more && older.isPending && <p className="ops-meta" role="status">Loading…</p>}
        </>
      )}
      {open.length > 0 && (
        <>
          <h3 className="drv-h3">Links opened to anyone</h3>
          <p className="ops-meta">{num(open.length)} still open. Anyone with one of these links can open the file.</p>
          <ul className="drv-rows">{open.map((l) => <LinkRow key={l.id} l={l} online={online} tz={tz} onClosed={() => qc.invalidateQueries({ queryKey: ['drive', 'links'] })} />)}</ul>
        </>
      )}
    </section>
  );
}
