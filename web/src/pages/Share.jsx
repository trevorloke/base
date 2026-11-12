// Share (/share, every role): the campaign's posts to share, each with your
// own link. Your link first ("Sign-ups through it count as yours", Copy, the
// people you brought in); then one card per post: its picture, its words,
// the page it opens, and Share — the phone's own share sheet where there is
// one (Instagram, TikTok, WhatsApp…), else WhatsApp · Text · Facebook · X ·
// Email · Copy in place. Under each: Copy words (for a caption) and Save
// picture. The first open makes the link (share.me, which needs signal once).
// Kept on the phone: with no signal the posts and the link still show and
// copying works; Share then sends the words and link only.
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useOutletContext } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, action } from '../api.js';
import { at } from '../base.js';
import { NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import { Unavailable } from '../components/AudienceBits.jsx';
import { phoneCopy, showingCopy, useKeepCopy } from '../components/OfflineCache.js';
import './shifts.css';
import './share.css';

const KEY = ['share'];
const COPY = 'share';
const fmt = (n) => Number(n || 0).toLocaleString('en-CA');
const enc = encodeURIComponent;

// The in-place share row: the kit's own link everywhere (its ?k= is what
// counts the post), never a share-<channel> tag in its place.
export const shareTargets = ({ link, text, title }) => {
  const msg = `${text}\n${link}`;
  return [
    ['WhatsApp', `https://wa.me/?text=${enc(msg)}`],
    ['Text', `sms:?&body=${enc(msg)}`],
    ['Facebook', `https://www.facebook.com/sharer/sharer.php?u=${enc(link)}`],
    ['X', `https://x.com/intent/tweet?text=${enc(text)}&url=${enc(link)}`],
    ['Email', `mailto:?subject=${enc(title || '')}&body=${enc(msg)}`],
  ];
};

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* the old way below */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

function CopyButton({ text, label, what, say }) {
  const [done, setDone] = useState(false);
  const t = useRef(null);
  useEffect(() => () => clearTimeout(t.current), []);
  const go = async () => {
    const ok = await copyText(text);
    say(ok ? `${what} copied` : 'Couldn’t copy — press and hold to copy it');
    if (!ok) return;
    setDone(true);
    clearTimeout(t.current);
    t.current = setTimeout(() => setDone(false), 1600);
  };
  return <button type="button" className="btn ops-tap" onClick={go}>{done ? 'Copied' : label}</button>;
}

function BackLink() {
  const from = useLocation().state?.from;
  return <Link className="ops-back" to={from?.to || '/'}>← {from?.label || 'Today'}</Link>;
}

function KitCard({ kit, online, say }) {
  const [open, setOpen] = useState(false);
  const file = useRef(null);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const picture = kit.picture_url ? at(kit.picture_url) : null;
  // The picture, fetched ahead so Share stays one tap (a phone only opens its
  // share sheet straight from the tap).
  useEffect(() => {
    if (!canShare || !picture || !online || typeof navigator.canShare !== 'function') return undefined;
    let gone = false;
    fetch(picture).then((r) => (r.ok ? r.blob() : null)).then((b) => {
      if (gone || !b) return;
      const ext = (b.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
      const f = new File([b], `${kit.code}.${ext}`, { type: b.type });
      try { if (navigator.canShare({ files: [f] })) file.current = f; } catch { /* words and link only */ }
    }).catch(() => {});
    return () => { gone = true; };
  }, [canShare, picture, online, kit.code]);

  const share = async () => {
    if (!canShare) { setOpen((v) => !v); return; }
    const data = { text: kit.text, url: kit.link };
    if (file.current && online) data.files = [file.current];
    try {
      await navigator.share(data);
      say('Shared');
    } catch (e) {
      if (e?.name !== 'AbortError') say('Couldn’t open sharing — use Copy words');
    }
  };

  return (
    <article className="card sh-kit" aria-label={kit.title}>
      {picture && online && <img className="sh-pic" src={picture} alt="" loading="lazy" />}
      <p className="sh-text">{kit.text}</p>
      <p className="ops-meta">Opens: {kit.page_title}</p>
      <div className="sh-go">
        <button type="button" className="btn ops-tap sh-share" aria-expanded={canShare ? undefined : open} onClick={share}>Share</button>
      </div>
      {open && (
        <ul className="sh-targets" aria-label="Share to">
          {shareTargets({ link: kit.link, text: kit.text, title: kit.title }).map(([label, href]) => (
            <li key={label}><a className="btn ops-tap" href={href} target="_blank" rel="noopener noreferrer">{label}</a></li>
          ))}
          <li><CopyButton text={kit.link} label="Copy" what="Link" say={say} /></li>
        </ul>
      )}
      <div className="sh-under">
        <CopyButton text={`${kit.text}\n${kit.link}`} label="Copy words" what="Words and link" say={say} />
        {picture && (online
          ? <a className="btn ops-tap" href={picture} download={`${kit.code}`}>Save picture</a>
          : <span className="ops-meta">Pictures need signal</span>)}
      </div>
    </article>
  );
}

export default function Share() {
  const { me } = useOutletContext();
  const online = useOnline();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => apiGet('/share'), ...phoneCopy(me, COPY), initialDataUpdatedAt: 0 });
  useKeepCopy(me, COPY, q);
  const [said, setSaid] = useState('');
  const [making, setMaking] = useState(null); // null · 'busy' · an error
  const asked = useRef(false);
  const d = q.data;

  // The first open makes their link, once.
  useEffect(() => {
    if (!d || d.ready === false || d.code || asked.current || !online || q.isFetching) return;
    asked.current = true;
    setMaking('busy');
    action('share.me', {})
      .then(() => qc.invalidateQueries({ queryKey: KEY }))
      .then(() => setMaking(null))
      .catch((e) => setMaking(e.message || 'Couldn’t make your link'));
  }, [d, online, q.isFetching, qc]);

  const copy = showingCopy(q);
  let body;
  if (noSignal(q)) body = <NoSignal />;
  else if (q.isPending) body = <p className="muted">Loading…</p>;
  else if (q.isError && !d) {
    body = <p role="alert"><Unavailable onRetry={() => q.refetch()} /></p>;
  } else if (d.ready === false) body = <p className="muted">The website isn’t set up yet.</p>;
  else {
    const link = d.code ? `${d.base}/r/${d.code}` : null;
    body = (
      <>
        <section className="card sh-mine" aria-label="Your link">
          <h2>Your link</h2>
          <p className="ops-meta">Sign-ups through it count as yours</p>
          {link ? (
            <div className="sh-link">
              <span className="sh-url mono">{link}</span>
              <CopyButton text={link} label="Copy" what="Your link" say={setSaid} />
            </div>
          ) : (
            <p className="muted" role="status">
              {!online ? 'Sharing needs signal for the first time' : making && making !== 'busy' ? making : 'Making your link…'}
            </p>
          )}
          <p className="sh-big"><strong className="mono">{fmt(d.brought)}</strong> {d.brought === 1 ? 'person' : 'people'} brought in</p>
        </section>
        {d.code && d.kits.length === 0 && <p className="muted sh-empty">Nothing to share yet.</p>}
        {d.code && d.kits.map((k) => <KitCard key={k.id} kit={k} online={online} say={setSaid} />)}
      </>
    );
  }

  return (
    <div className="ops-page sh-page">
      <BackLink />
      <div className="ops-head"><h1>Share</h1></div>
      {copy && <p className="ops-copy"><span className="chip obx-copy">Offline copy</span></p>}
      {body}
      <p className="ops-sr" aria-live="polite" role="status">{said}</p>
    </div>
  );
}
