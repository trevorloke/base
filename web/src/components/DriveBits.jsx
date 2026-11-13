// What every Google Drive button shares (server: ext/drive).
//   useDrive()            GET /api/drive: { setup, on, sheets, canSend, land, me, … }.
//                         A volunteer gets 403, so nothing is drawn for them.
//   driveOn(d)            Drive buttons are drawn only when setup && on
//   useDrivePicker(on)    the Picker's settings and narrowed token, fetched when
//                         the page opens and again 5 minutes before it expires
//   usePickFromDrive(on)  { pick(kind, opts) → docs | null, need, error, clear }:
//                         need 'connect' when this person must connect first
//   DriveConnect          GSI's GoogleConnect for Drive, with its one line
//   useDriveToast()       "Google Drive connected", once, after Google's return
//   whereSheetsGo(land)   "your Google Drive (base.win exports)" | "the campaign folder X"
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api.js';
import GoogleConnect, { useGoogleReturn } from './GoogleConnect.jsx';
import { OPEN_FAILED, pickFromDrive } from './drivePicker.js';
import './drive.css';

export const useDrive = () => useQuery({
  queryKey: ['drive'], queryFn: () => apiGet('/drive'), retry: false, staleTime: 60_000,
});
export const driveOn = (d) => Boolean(d?.setup && d?.on);

const EARLY = 5 * 60_000;
export const useDrivePicker = (on) => useQuery({
  queryKey: ['drive', 'picker'],
  queryFn: () => apiGet('/drive/picker'),
  enabled: Boolean(on),
  retry: false,
  staleTime: (q) => (q.state.data?.expiresAt ? Math.max(0, new Date(q.state.data.expiresAt) - Date.now() - EARLY) : 0),
  refetchInterval: (q) => (q.state.data?.expiresAt ? Math.max(60_000, new Date(q.state.data.expiresAt) - Date.now() - EARLY) : false),
  refetchOnWindowFocus: false,
});

export const UNSAFE = 'Google Drive can’t open safely on this server — tell us';
export function usePickFromDrive(on) {
  const q = useDrivePicker(on);
  const [need, setNeed] = useState(null);
  const [error, setError] = useState(null);
  const pick = async (kind, opts = {}) => {
    setError(null);
    let p = q.data;
    // Past its time (or never read): ask again first.
    if (!p || (p.expiresAt && new Date(p.expiresAt) - Date.now() < 60_000)) {
      try { p = (await q.refetch({ throwOnError: true })).data; } catch (e) { setError(e.message); return null; }
    }
    if (!p?.ready) { setError('Google Drive is off for this campaign'); return null; }
    if (p.connect) { setNeed('connect'); return null; }
    if (p.unsafe) { setError(UNSAFE); return null; }
    if (p.trouble) { setError(p.trouble); return null; }
    try {
      return await pickFromDrive({ kind, picker: p, ...opts });
    } catch (e) {
      setError(e.message || OPEN_FAILED);
      return null;
    }
  };
  return { pick, need, error, setError, clear: () => { setNeed(null); setError(null); }, ready: Boolean(q.data) };
}

export function DriveConnect({ back }) {
  return (
    <div className="drv-connect">
      <GoogleConnect purpose="drive" label="Connect Google Drive" back={back} />
      <p className="drv-line">base.win only sees the files you pick.</p>
    </div>
  );
}

// After Google's return (?google=connected): one toast, then gone.
// Said once however many Drive pieces a page has: the first to ask takes it.
let toastFor = null;
export function useDriveToast() {
  const code = useGoogleReturn();
  const [here] = useState(() => window.location.href);
  const [text, setText] = useState(null);
  const timer = useRef(null);
  const say = (t) => { clearTimeout(timer.current); setText(t); timer.current = setTimeout(() => setText(null), 4000); };
  // Claimed once committed, so a render React throws away claims nothing.
  useEffect(() => {
    if (code === 'connected' && toastFor !== here) { toastFor = here; say('Google Drive connected'); }
    return () => clearTimeout(timer.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return { text, say };
}
export function DriveToast({ text }) {
  return (
    <>
      <p className="drv-sr" aria-live="polite">{text || ''}</p>
      {text && <div className="toast drv-toast">{text}</div>}
    </>
  );
}

export const whereSheetsGo = (land) => (land?.kind === 'campaign' ? `the campaign folder ${land.name}` : 'your Google Drive (base.win exports)');
export const num = (n) => (Number(n) || 0).toLocaleString('en-CA');
export const mb = (bytes) => {
  const n = Number(bytes) || 0;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
};
