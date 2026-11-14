// What the writer's screens (pages/Letters.jsx, LetterPage.jsx) and the
// desk's (pages/MediaLetters.jsx) both say about a letter: its words, its
// count against a paper's limit, the campaign's own words in it.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { size } from '@starbase/shared/letters';
import { apiGet } from '../api.js';
import { phoneCopy, useKeepCopy } from './OfflineCache.js';

export const STATUS_WORDS = {
  new: 'New', working: 'Working on it', ready: 'Ready to send', sent: 'Sent', published: 'Published', declined: 'Declined', withdrawn: 'Withdrawn',
};
export const KIND_WORDS = { letter: 'Letter', op_ed: 'Op-ed' };
export const BODY_MAX = 20000;
export const LOADING = 'Loading…';
export const fmt = (n) => Number(n || 0).toLocaleString('en-CA');
export { dayWords } from './letterWords.js';
export const firstWords = (t, n = 8) => { const w = String(t || '').trim().split(/\s+/).filter(Boolean); return w.slice(0, n).join(' ') + (w.length > n ? '…' : ''); };
export function Unavailable({ onRetry }) {
  return <>Unavailable — <button type="button" className="btn btn-quiet lt-inline" onClick={onRetry}>Try again</button></>;
}
export function More({ label = 'More', children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="lt-more">
      <button type="button" className="disclose" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{label}</button>
      {open && <div className="lt-more__body">{children}</div>}
    </div>
  );
}
// The outlets that take this kind, with what the write screen needs (the
// talking points, the campaign's name, the writer's own sign-off): kept on
// this phone for this sign-in, so writing works with no signal.
export function useLetterOutlets(me, kind) {
  const name = `letters-outlets-${kind}`;
  const copy = phoneCopy(me, name);
  const q = useQuery({ queryKey: ['letters', 'outlets', kind], queryFn: () => apiGet(`/letters/outlets?kind=${kind}`), ...copy });
  useKeepCopy(me, name, q);
  return q;
}
// "≤ 250 words · only to them · local writers"
export const rulesLine = (o) => [
  o.limit ? `≤ ${fmt(o.limit)} ${o.limit_unit === 'characters' ? 'characters' : 'words'}` : null,
  o.exclusive ? 'only to them' : null,
  o.local_only ? 'local writers' : null,
  o.language ? `in ${o.language}` : null,
].filter(Boolean).join(' · ');
// "212 / 250 words", and "38 over" past the limit (never a block).
export function Count({ text, outlet }) {
  const unit = outlet?.limit_unit === 'characters' ? 'characters' : 'words';
  const n = size(text, unit);
  const limit = outlet?.limit || null;
  return (
    <p className="lt-count" aria-live="polite">
      <span className="mono">{fmt(n)}{limit ? ` / ${fmt(limit)}` : ''}</span> {unit}
      {limit && n > limit && <span className="chip chip-warn lt-over">{fmt(n - limit)} over</span>}
    </p>
  );
}
// "These words are the campaign's — say it your way", with the run shown.
export function CampaignWords({ run }) {
  if (!run) return null;
  return (
    <p className="lt-words" role="note">
      These words are the campaign’s — say it your way: <mark className="lt-mark">“{run}”</mark>
    </p>
  );
}
