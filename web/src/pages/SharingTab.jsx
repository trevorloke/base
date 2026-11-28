// Outreach → Sharing: the posts the campaign hands every supporter to share
// with their own link (ext/socials/share.js). The list: each post's name,
// "14 sign-ups · 6 sharers", Open or Stopped, and "Page not live" when the
// page it opens is gone from the website. A tap opens it in place (?kit=):
// the name, the words (counted with the Authorized by line, "Under 280 fits
// X"), the page and the line (on every post once it is filled in:
// shared/site/authorized.js; a post saved before then that is now over 500
// with it is said, its words never changed); under More details the
// picture and Stop sharing / Share again; then its top sharers. Under the
// list: Top sharers (all links), and a quiet "Your own link" (/share).
// "New post to share" (the header's one yellow button) is ?new=1.
import { useEffect, useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, action } from '../api.js';
import { at } from '../base.js';
import { NeedsSignal, useOnline } from '../components/NoSignal.jsx';
import { Unavailable } from '../components/AudienceBits.jsx';
import { uploadImage } from '../components/MarkdownField.jsx';
import { hasArea } from '../Shell.jsx';
import { AuthorizedBanner, needsAsk, useAuthorized } from '../components/Authorized.jsx';
import { withLineOnce } from '@base-win/shared/site/authorized';
import './shifts.css';
import './share.css';

const KITS = ['share', 'kits'];
const TOP = ['share', 'top'];
const BODY_MAX = 500;
const X_MAX = 280;
const fmt = (n) => Number(n || 0).toLocaleString('en-CA');
const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);
// A sharer's name opens their profile only for someone who may read People
// (a volunteer granted Outreach alone sees the name).
const Who = ({ t, linked }) => (linked ? <Link to={`/people/${t.id}`}>{t.name}</Link> : <span>{t.name}</span>);
const say = (msg) => {
  const s = String(msg || '').replace(/^[a-z_.]+: /i, '').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Not saved';
};

function Nums({ k }) {
  return (
    <span className="sk-nums">
      <strong className="mono">{fmt(k.signups)}</strong> {plural(k.signups, 'sign-up')} · {fmt(k.sharers)} {plural(k.sharers, 'sharer')}
    </span>
  );
}

function KitEditor({ kit, line, pages, people, onClose, onSaved }) {
  const id = useId();
  const online = useOnline();
  const qc = useQueryClient();
  const [title, setTitle] = useState(kit?.title || '');
  const [body, setBody] = useState(kit?.body || '');
  const [path, setPath] = useState(kit?.path || pages[0]?.path || '/');
  const [media, setMedia] = useState(kit?.media_id ? { id: kit.media_id, url: kit.picture_url } : null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [said, setSaid] = useState('');
  const top = useQuery({ queryKey: ['share', 'kit', kit?.id], queryFn: () => apiGet(`/share/kits/${kit.id}`), enabled: Boolean(kit?.id) });

  // After the line's "needed from" date with none set: saving asks first.
  const auth = useAuthorized().data;
  const ask = needsAsk(auth);
  const [asked, setAsked] = useState(false);
  const words = withLineOnce(body.trim(), line);
  const n = words.length;
  const known = pages.some((p) => p.path === path);
  const live = kit && kit.path === path ? kit.live : known;

  const save = async (e) => {
    e.preventDefault();
    if (ask && !asked) { setAsked(true); return; }
    setBusy(true);
    setError(null);
    try {
      // The post's own saved choice (authorized) is never sent: it is kept.
      const r = await action('share.kit.save', {
        ...(kit ? { id: kit.id } : {}), title, body, path, media_id: media?.id || null,
        ...(ask ? { withoutAuthorized: true } : {}),
      });
      await qc.invalidateQueries({ queryKey: ['share'] });
      onSaved(r.kit, kit ? 'Saved' : 'Ready to share');
    } catch (err) {
      setError(say(err.message));
    } finally {
      setBusy(false);
    }
  };
  const setOpen = async (open) => {
    setBusy(true);
    setError(null);
    try {
      await action('share.kit.open', { id: kit.id, open });
      await qc.invalidateQueries({ queryKey: ['share'] });
      setSaid(open ? 'Sharing again' : 'Stopped — its links still work');
    } catch (err) {
      setError(say(err.message));
    } finally {
      setBusy(false);
    }
  };
  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const m = await uploadImage(file, 'share.picture');
      setMedia({ id: m.id, url: m.url });
      setSaid('Picture added — save to keep it');
    } catch (err) {
      setError(say(err.message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card sk-edit" onSubmit={save} aria-label={kit ? kit.title : 'New post to share'}>
      <div className="sk-field">
        <label htmlFor={`${id}-t`}>Title</label>
        <input id={`${id}-t`} className="input" value={title} maxLength={80} required onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="sk-field">
        <label htmlFor={`${id}-b`}>Words to share</label>
        <textarea id={`${id}-b`} className="input" value={body} maxLength={BODY_MAX} required onChange={(e) => setBody(e.target.value)} />
        <span className="sk-count" data-over={n > BODY_MAX ? 'true' : 'false'}>
          {fmt(n)} of {fmt(BODY_MAX)}{line ? ' with the Authorized by line' : ''}{n <= X_MAX ? ' · Under 280 fits X' : ''}
        </span>
      </div>
      <div className="sk-field">
        <label htmlFor={`${id}-p`}>Page</label>
        <select id={`${id}-p`} className="input" value={path} onChange={(e) => setPath(e.target.value)}>
          {!known && <option value={path}>{kit?.page_title || path}</option>}
          {pages.map((p) => <option key={p.path} value={p.path}>{p.title}</option>)}
        </select>
        {!live && <p className="sk-line" role="alert">The page this opens isn’t live. Pick another page.</p>}
      </div>
      <div className="sk-field">
        {line ? (
          <>
            <p className="sk-line">{line}</p>
            <p className="ops-meta">base.win adds this line to every post. Pictures should carry it too.</p>
          </>
        ) : (
          <p className="sk-line"><Link to="/website/settings">Add your authorization line in Website → Settings</Link></p>
        )}
      </div>

      <button type="button" className="btn btn-quiet ops-tap sk-more" aria-expanded={more} onClick={() => setMore((v) => !v)}>
        {more ? 'Fewer details' : 'More details'}
      </button>
      {more && (
        <div className="sk-field" style={{ marginTop: 12 }}>
          <span className="sk-label">Picture</span>
          {media && <img className="sk-pic" src={at(media.url)} alt="" />}
          <div className="sk-actions">
            <label className="btn ops-tap">
              {media ? 'Change picture' : 'Upload picture'}
              <input type="file" accept="image/jpeg,image/png,image/webp" hidden disabled={!online || busy} onChange={pick} />
            </label>
            {media && <button type="button" className="btn ops-tap" onClick={() => setMedia(null)}>Take it off</button>}
            {kit && (kit.open
              ? <button type="button" className="btn ops-tap" disabled={!online || busy} onClick={() => setOpen(false)}>Stop sharing</button>
              : <button type="button" className="btn ops-tap" disabled={!online || busy} onClick={() => setOpen(true)}>Share again</button>)}
          </div>
        </div>
      )}

      <AuthorizedBanner a={auth} />
      {error && <p className="error" role="alert">{error}</p>}
      <div className="sk-actions">
        <button type="submit" className="btn btn-primary ops-tap" disabled={!online || busy || n > BODY_MAX}>{busy ? 'Saving…' : ask && asked ? 'Save without it' : kit ? 'Save' : 'Save post'}</button>
        {ask && asked && <Link className="btn btn-quiet ops-tap" to="/website/settings#wb-s-agent">Add it first</Link>}
        <button type="button" className="btn btn-quiet ops-tap" onClick={onClose}>{kit ? 'Close' : 'Cancel'}</button>
        {!online && <NeedsSignal />}
      </div>
      <p className="ops-sr" aria-live="polite" role="status">{said}</p>

      {kit && (
        <div className="sk-section">
          <h2>Top sharers</h2>
          {top.isPending ? <p className="muted">Loading…</p> : top.isError ? <Unavailable onRetry={() => top.refetch()} />
            : top.data.top.length === 0 ? <p className="muted">No sign-ups through it yet.</p> : (
              <ul className="sk-top">
                {top.data.top.map((t) => (
                  <li key={t.id}><Who t={t} linked={people} /><span className="mono">{fmt(t.signups)}</span></li>
                ))}
              </ul>
            )}
        </div>
      )}
    </form>
  );
}

export default function SharingTab({ me, creating, onClose }) {
  const people = hasArea(me, 'people');
  const [params, setParams] = useSearchParams();
  const openId = params.get('kit');
  const q = useQuery({ queryKey: KITS, queryFn: () => apiGet('/share/kits') });
  const top = useQuery({ queryKey: TOP, queryFn: () => apiGet('/share/top') });
  const [said, setSaid] = useState('');
  useEffect(() => { if (creating) setSaid(''); }, [creating]);

  const close = () => (creating ? onClose() : setParams({}, { replace: true }));
  const onSaved = (kit, words) => { setSaid(words); setParams({ kit: kit.id }, { replace: true }); };

  if (q.isPending) return <p className="muted">Loading…</p>;
  if (q.isError) return <p role="alert"><Unavailable onRetry={() => q.refetch()} /></p>;
  const d = q.data;
  if (!d.ready) {
    return (
      <div className="sk-setup">
        <p className="muted">The website isn’t set up yet.</p>
        <Link className="btn btn-primary ops-tap" to="/website">Set it up</Link>
      </div>
    );
  }
  const open = openId ? d.kits.find((k) => k.id === openId) : null;

  return (
    <div className="sk-page">
      {d.over > 0 && (
        <p className="banner sk-over" role="status">
          {d.over === 1 ? '1 saved post is' : `${fmt(d.over)} saved posts are`} now over {fmt(BODY_MAX)} characters with the Authorized by line. Open {d.over === 1 ? 'it' : 'each'} and shorten the words.
        </p>
      )}
      {creating && <KitEditor key="new" line={d.line} pages={d.pages} people={people} onClose={close} onSaved={onSaved} />}
      {d.kits.length === 0 && !creating && <p className="muted">Nothing to share yet.</p>}
      <ul className="sk-list">
        {d.kits.map((k) => (
          <li key={k.id}>
            {open?.id === k.id ? (
              <KitEditor key={k.id} kit={k} line={d.line} pages={d.pages} people={people} onClose={close} onSaved={onSaved} />
            ) : (
              <button type="button" className="sk-row" onClick={() => setParams({ kit: k.id })}>
                <span className="sk-title">{k.title}</span>
                <Nums k={k} />
                <span className={`chip${k.open ? '' : ' muted'}`}>{k.open ? 'Open' : 'Stopped'}</span>
                {!k.live && <span className="chip sk-warn">Page not live</span>}
                {k.over && <span className="chip sk-warn">Over {fmt(BODY_MAX)} with the line</span>}
              </button>
            )}
          </li>
        ))}
      </ul>

      <section className="sk-section" aria-label="Top sharers">
        <h2>Top sharers <span className="muted">(all links)</span></h2>
        {top.isPending ? <p className="muted">Loading…</p> : top.isError ? <Unavailable onRetry={() => top.refetch()} />
          : top.data.top.length === 0 ? <p className="muted">Nobody has brought anyone in yet.</p> : (
            <ul className="sk-top">
              {top.data.top.map((t) => (
                <li key={t.id}><Who t={t} linked={people} /><span className="mono">{fmt(t.n)} brought in</span></li>
              ))}
            </ul>
          )}
      </section>
      <p className="sk-quiet"><Link to="/share" state={{ from: { to: '/outreach/sharing', label: 'Sharing' } }}>Your own link</Link></p>
      <p className="ops-sr" aria-live="polite" role="status">{said}</p>
    </div>
  );
}
