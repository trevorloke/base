// Settings → Brand (managers): the campaign's own look, on every screen its
// people and the public see (server/ext/brand; the shades by
// shared/brand-look.js).
//   Logo, a logo for dark backgrounds, a square mark (the app's icon) — a
//   JPG, PNG, WebP or SVG, made ready in the browser (brand-pictures.js).
//   Brand colour and an optional second colour: every other shade is worked
//   out from them, so nothing here can be saved unreadable.
//   Sidebar (Light · Brand colour · Dark), Corners, Headings.
//   Under More: what training is called, the name under the home-screen
//   icon, the logo on top of newsletters.
// Beside it a live sample — the desk and the phone, in light and in dark —
// and what only a person can decide, in words (brand-notes.js): it reports,
// it never blocks. One primary: Save, live on every screen at once (there
// is no draft, so the sample is the preview; the page is read again so this
// screen wears it too). "Use the website's colours and logo" fills the form
// from Website → Theme; "Back to …" takes the saved brand off (brand.reset).
import { useEffect, useMemo, useRef, useState } from 'react';
import { CORNERS, HEADINGS, SIDEBARS, deriveLook, lookTokens } from '@starbase/shared/brand-look';
import { FONT_BY_VALUE } from '@starbase/shared/site/theme';
import { action, initials } from '../api.js';
import { at, NS } from '../base.js';
import { BRAND } from '../brand.js';
import { NeedsSignalLine, useOnline } from './NoSignal.jsx';
import { hexOf } from './site/colors.js';
import { useSite } from './site/useSite.js';
import { brandNotes, logoGrounds } from './brand-notes.js';
import { BRAND_ACCEPT, fileFrom, fitLogo, fitMark, iconsFrom, seenOn, uploadBrandPicture } from './brand-pictures.js';
import './brand-settings.css';

const SAVED_FLAG = `${NS}brand-saved`;
const SIDEBAR_WORD = { light: 'Light', brand: 'Brand colour', dark: 'Dark' };
const CORNER_WORD = { square: 'Square', soft: 'Soft', round: 'Round' };
const startWord = BRAND.key === 'imagine-surrey' ? 'Imagine Surrey’s look' : 'base.win’s look';

const kept = (p) => (p?.id && p.type ? { id: p.id, url: `/brand/${p.id}.${p.type}`, w: p.w, h: p.h } : null);
// The form as it opens: the saved brand, or the look the campaign started in
// (its own logo files, by address — uploaded when the brand is first saved).
const formOf = (saved) => (saved?.v === 1 ? {
  color: hexOf(saved.color) || BRAND.color, second: hexOf(saved.second) || '',
  sidebar: SIDEBARS.includes(saved.sidebar) ? saved.sidebar : 'light',
  corners: CORNERS[saved.corners] ? saved.corners : 'soft',
  heading: HEADINGS.includes(saved.heading) ? saved.heading : 'inter',
  learn: saved.learn || BRAND.learn, shortName: saved.shortName || 'base.win', emailHeader: saved.emailHeader === true,
  logo: kept(saved.logo), logoDark: kept(saved.logoDark), mark: kept(saved.mark), icons: saved.icons || null,
} : {
  color: BRAND.color, second: BRAND.second || '', sidebar: BRAND.sidebar || 'light', corners: BRAND.corners || 'soft', heading: BRAND.heading || 'inter',
  learn: BRAND.learn, shortName: 'base.win', emailHeader: false,
  logo: BRAND.logo ? { url: BRAND.logo } : null, logoDark: BRAND.logoDark ? { url: BRAND.logoDark } : null, mark: null, icons: null,
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// What the shades are worked out from.
const lookOf = (f) => ({ color: f.color, second: f.second || null, sidebar: f.sidebar, corners: f.corners, heading: f.heading, logo: f.logo, logoDark: f.logoDark });

function ColourField({ id, label, value, fallback, onChange, hint, optional }) {
  const [typed, setTyped] = useState(null);
  const bad = typed != null && typed !== '' && !hexOf(typed);
  return (
    <div className="bs-colour">
      <input type="color" className="bs-colour__pick" value={value || fallback} aria-label={`${label}: pick a colour`}
        onChange={(e) => { setTyped(null); onChange(e.target.value); }} />
      <div className="field bs-colour__words">
        <label htmlFor={id}>{label}{optional && <span className="bs-opt"> (optional)</span>}</label>
        <input id={id} className="input bs-colour__hex" value={typed ?? value} maxLength={7} spellCheck={false} autoComplete="off"
          placeholder={optional ? 'None' : undefined}
          aria-invalid={bad ? 'true' : undefined} aria-describedby={[hint ? `${id}-hint` : null, bad ? `${id}-err` : null].filter(Boolean).join(' ') || undefined}
          onChange={(e) => {
            setTyped(e.target.value);
            const h = hexOf(e.target.value);
            if (h) onChange(h); else if (optional && !e.target.value.trim()) onChange('');
          }}
          onBlur={() => setTyped(null)} />
        {hint && <p className="bs-hint" id={`${id}-hint`}>{hint}</p>}
        {bad && <p className="error bs-err" id={`${id}-err`}>A colour like #003979</p>}
      </div>
    </div>
  );
}

// One of the brand's pictures: what is there now on the ground it sits on,
// Upload / Replace, Remove.
function PictureField({ id, label, hint, value, dark, busy, error, disabled, onPick, onRemove }) {
  const file = useRef(null);
  return (
    <div className="bs-pic" role="group" aria-labelledby={`${id}-label`}>
      <span className={`bs-pic__well${dark ? ' bs-pic__well--dark' : ''}`}>
        {value ? <img src={at(value.url)} alt={`${label} now`} /> : <span className="bs-pic__none">None</span>}
      </span>
      <div className="bs-pic__words">
        <span className="bs-pic__label" id={`${id}-label`}>{label}</span>
        <span className="bs-hint" id={`${id}-hint`}>{hint}</span>
        <span className="bs-pic__acts">
          <button type="button" className="btn ot-btn-tap" disabled={disabled || busy} aria-describedby={`${id}-hint`}
            onClick={() => file.current?.click()}>
            {busy ? 'Uploading…' : value ? 'Replace' : 'Upload'}<span className="ot-sr">: {label}</span>
          </button>
          {value && !busy && (
            <button type="button" className="btn btn-quiet ot-btn-tap" disabled={disabled} onClick={onRemove}>Remove<span className="ot-sr">: {label}</span></button>
          )}
        </span>
        <input ref={file} id={id} type="file" accept={BRAND_ACCEPT} hidden
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onPick(f); }} />
        {error && <p className="error bs-err" role="alert">{error}</p>}
      </div>
    </div>
  );
}

function PickOne({ label, id, value, options, words, onChange }) {
  return (
    <div className="bs-field">
      <span className="bs-label" id={id}>{label}</span>
      <div className="ot-seg bs-seg" role="group" aria-labelledby={id}>
        {options.map((o) => (
          <button key={o} type="button" aria-pressed={value === o} onClick={() => onChange(o)}>{words[o]}</button>
        ))}
      </div>
    </div>
  );
}

// The ratings' own colours (app.css): data, which a brand never recolours.
const RATING = { light: ['#1f7a4d', '#1f7a4d', '#9a5b00', '#c8151b'], dark: ['#5fd39a', '#5fd39a', '#f0b955', '#ff8a8a'] };

// The campaign's mark as the shell draws it (BrandMark.jsx), in a sample.
function SampleMark({ f, name, dark, sideDark, paleSide }) {
  if (!f.logo) return <span className="bs-s__mono" aria-hidden="true">{initials(name || 'Your campaign')}</span>;
  const darkGround = sideDark || (dark && !paleSide);
  const src = darkGround && f.logoDark ? f.logoDark.url : f.logo.url;
  return <img className={`bs-s__logo${darkGround && !f.logoDark ? ' bs-s__logo--chip' : ''}`} src={at(src)} alt="" />;
}

function Frame({ f, name, scheme, phone }) {
  const dark = scheme === 'dark';
  const tokens = useMemo(() => { const t = lookTokens(lookOf(f)); return { ...t.light, ...(dark ? t.dark : {}) }; }, [f.color, f.second, f.sidebar, f.corners, f.heading, dark]); // eslint-disable-line react-hooks/exhaustive-deps
  const g = logoGrounds(lookOf(f));
  const mark = <SampleMark f={f} name={name} dark={dark} sideDark={g.sideDark} paleSide={g.paleSide} />;
  const body = (
    <>
      <p className="bs-s__h">Today</p>
      <div className="bs-s__card">
        <p className="bs-s__p">12 doors left on Maple Street. <span className="bs-s__a">See the list</span></p>
        <p className="bs-s__q">Quiet words sit under the main ones.</p>
        <div className="bs-s__row">
          <span className="bs-s__btn">Start</span>
          <span className="bs-s__chip">This week</span>
        </div>
        <div className="bs-s__rate">
          {RATING[scheme].map((c, i) => <span key={i} style={{ '--band': c }}>{i + 1}</span>)}
        </div>
      </div>
    </>
  );
  return (
    <div className={`bs-s bs-s--${phone ? 'phone' : 'desk'}`} style={tokens} data-scheme={scheme}>
      {phone ? (
        <>
          <div className="bs-s__top">{mark}{!f.logo && <span className="bs-s__org">{name}</span>}</div>
          <div className="bs-s__main">{body}</div>
          <div className="bs-s__tabs">{['Today', 'Map', 'People', 'More'].map((t, i) => <span key={t} data-on={i === 0 ? '' : undefined}>{t}</span>)}</div>
        </>
      ) : (
        <>
          <div className="bs-s__side">
            <div className="bs-s__brand">{mark}{!f.logo && <span className="bs-s__org">{name}</span>}</div>
            <span className="bs-s__by">base.win</span>
            {['Today', 'People', 'Map', 'Shifts'].map((t, i) => <span key={t} className="bs-s__nav" data-on={i === 0 ? '' : undefined}>{t}</span>)}
          </div>
          <div className="bs-s__main">{body}</div>
        </>
      )}
    </div>
  );
}

function Sample({ f, name }) {
  return (
    <div className="bs-sample" role="img" aria-label="How it looks: the desk and the phone, in light and in dark">
      {[['light', false, 'Desk, light'], ['dark', false, 'Desk, dark'], ['light', true, 'Phone, light'], ['dark', true, 'Phone, dark']].map(([scheme, phone, words]) => (
        <figure key={words} className={`bs-fig${phone ? ' bs-fig--phone' : ''}`}>
          <Frame f={f} name={name} scheme={scheme} phone={phone} />
          <figcaption>{words}</figcaption>
        </figure>
      ))}
    </div>
  );
}

export default function BrandSettings({ me }) {
  const online = useOnline();
  const name = me?.workspace?.name || '';
  const saved = me?.workspace?.settings?.brand;
  const [start] = useState(() => formOf(saved));
  const [f, setF] = useState(start);
  const [busy, setBusy] = useState(null); // 'save' | 'reset' | 'site' | a picture's kind
  const [error, setError] = useState(null);
  const [picErr, setPicErr] = useState({});
  // After a save the page is read again; what was done is said once.
  const [said, setSaid] = useState(() => { try { return sessionStorage.getItem(SAVED_FLAG); } catch { return null; } });
  useEffect(() => { try { sessionStorage.removeItem(SAVED_FLAG); } catch { /* nothing kept */ } }, []);
  const [confirming, setConfirming] = useState(false);
  const [more, setMore] = useState(false);
  const [seen, setSeen] = useState({});
  const leaving = useRef(false);
  const set = (patch) => { setSaid(null); setF((x) => ({ ...x, ...patch })); };
  const dirty = !same(f, start);
  // A look's own logo, not yet this campaign's upload: the first save keeps it.
  const unsaved = saved?.v !== 1;

  useEffect(() => {
    const warn = (e) => { if (dirty && !leaving.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // How much of each logo can be seen where it will sit.
  const look = lookOf(f);
  const grounds = useMemo(() => logoGrounds(look), [f.color, f.sidebar]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let off = false;
    const read = async (key, p, on) => {
      if (!p) return [key, undefined];
      try { return [key, await seenOn(p.url, on)]; } catch { return [key, undefined]; }
    };
    Promise.all([read('logo', f.logo, grounds.logo), read('logoDark', f.logoDark, grounds.logoDark)])
      .then((pairs) => { if (!off) setSeen(Object.fromEntries(pairs)); });
    return () => { off = true; };
  }, [f.logo?.url, f.logoDark?.url, grounds]); // eslint-disable-line react-hooks/exhaustive-deps
  const notes = useMemo(() => brandNotes(look, seen), [f, seen]); // eslint-disable-line react-hooks/exhaustive-deps

  // The website's own look (Website → Theme), when it has one.
  const site = useSite();
  const siteTheme = site.data?.settings?.theme;
  const siteOwn = siteTheme && siteTheme.follow !== true;

  const pick = (kind, word) => async (file) => {
    setBusy(kind); setPicErr((e) => ({ ...e, [kind]: null }));
    try {
      if (kind === 'mark') {
        const m = await fitMark(file);
        const mark = await uploadBrandPicture('mark', m.blob, file.name);
        const made = await iconsFrom(m.canvas);
        const ids = {};
        for (const [k, key] of [['icon192', 'i192'], ['icon512', 'i512'], ['maskable', 'maskable'], ['touch', 'touch']]) {
          ids[key] = (await uploadBrandPicture(k, made[k], file.name)).id;
        }
        set({ mark, icons: ids });
      } else {
        const p = await fitLogo(file, word);
        set({ [kind]: await uploadBrandPicture(kind, p.blob, file.name) });
      }
    } catch (e) {
      setPicErr((x) => ({ ...x, [kind]: e.message }));
    } finally { setBusy(null); }
  };
  // A logo that is still a file of the look's or the website's: uploaded now.
  const keep = async (kind, p, word) => {
    if (!p) return null;
    if (p.id) return { id: p.id };
    const made = await fitLogo(await fileFrom(p.url), word);
    return { id: (await uploadBrandPicture(kind, made.blob, p.url.split('/').pop())).id };
  };
  const reload = (flag) => {
    leaving.current = true;
    try { sessionStorage.setItem(SAVED_FLAG, flag); } catch { /* private mode: no line after the reload */ }
    window.location.reload();
  };
  const save = async (e) => {
    e.preventDefault();
    setBusy('save'); setError(null);
    try {
      await action('brand.save', {
        color: f.color, second: f.second || null, sidebar: f.sidebar, corners: f.corners, heading: f.heading,
        learn: f.learn.trim() || undefined, short_name: f.shortName.trim() || undefined, email_header: f.emailHeader,
        logo: await keep('logo', f.logo, 'logo'), logo_dark: await keep('logoDark', f.logoDark, 'logo for dark backgrounds'),
        mark: f.mark ? { id: f.mark.id } : null, icons: f.mark ? f.icons : null,
      });
      reload('saved');
    } catch (err) { setError(err.message); setBusy(null); }
  };
  const reset = async () => {
    setBusy('reset'); setError(null);
    try { await action('brand.reset', {}); reload('reset'); } catch (err) { setError(err.message); setBusy(null); setConfirming(false); }
  };
  const fromSite = async () => {
    const t = siteTheme;
    const footer = site.data?.settings?.footer?.logo?.url;
    set({
      color: hexOf(t.colors?.brand) || f.color, second: hexOf(t.colors?.accent) || '',
      corners: CORNERS[t.radius] ? t.radius : f.corners, heading: HEADINGS.includes(t.fonts?.heading) ? t.fonts.heading : f.heading,
      ...(t.logo?.url ? { logo: { url: t.logo.url } } : {}), ...(footer ? { logoDark: { url: footer } } : {}),
    });
    setSaid('site');
  };

  const off = !online || Boolean(busy);
  return (
    <form className="bs" onSubmit={save} aria-label="Brand">
      <div className="bs-form">
        <p className="muted bs-lede">Your logo and colour on every screen: the app, sign-in, emails, receipts and a website that follows them. Ratings and statuses keep their own colours.</p>
        {said === 'saved' && <p className="bs-said" role="status">✓ Saved — every screen wears it now.</p>}
        {said === 'reset' && <p className="bs-said" role="status">✓ Back to {startWord}.</p>}

        <h2 className="ot-sec-h">Logo</h2>
        <PictureField id="bs-logo" label="Logo" value={f.logo} busy={busy === 'logo'} disabled={off} error={picErr.logo}
          hint="A PNG with a see-through background works best. JPG, WebP and SVG work too."
          onPick={pick('logo', 'logo')} onRemove={() => set({ logo: null })} />
        <PictureField id="bs-logo-dark" label="Logo for dark backgrounds" value={f.logoDark} dark busy={busy === 'logoDark'} disabled={off} error={picErr.logoDark}
          hint="Optional: a white or light version, for dark mode and a dark sidebar."
          onPick={pick('logoDark', 'logo for dark backgrounds')} onRemove={() => set({ logoDark: null })} />
        <PictureField id="bs-mark" label="Square mark" value={f.mark} busy={busy === 'mark'} disabled={off} error={picErr.mark}
          hint="Optional: the icon on a phone’s home screen and the browser’s tab."
          onPick={pick('mark', 'square mark')} onRemove={() => set({ mark: null, icons: null })} />

        <h2 className="ot-sec-h">Colours</h2>
        <div className="bs-colours">
          <ColourField id="bs-color" label="Brand colour" value={f.color} fallback={f.color} onChange={(v) => v && set({ color: v })}
            hint="Buttons, links, the selected item." />
          <ColourField id="bs-second" label="Second colour" optional value={f.second} fallback={f.color} onChange={(v) => set({ second: v })}
            hint="Badges and highlights." />
        </div>

        <h2 className="ot-sec-h">Shape</h2>
        <PickOne id="bs-sidebar" label="Sidebar" value={f.sidebar} options={SIDEBARS} words={SIDEBAR_WORD} onChange={(v) => set({ sidebar: v })} />
        <PickOne id="bs-corners" label="Corners" value={f.corners} options={Object.keys(CORNERS)} words={CORNER_WORD} onChange={(v) => set({ corners: v })} />
        <div className="field bs-field">
          <label htmlFor="bs-heading">Headings</label>
          <select id="bs-heading" className="input" value={f.heading} onChange={(e) => set({ heading: e.target.value })}>
            {HEADINGS.map((h) => <option key={h} value={h}>{FONT_BY_VALUE[h].label}</option>)}
          </select>
        </div>

        <button type="button" className="btn btn-quiet disclose disclose--inline bs-more" aria-expanded={more} aria-controls="bs-more" onClick={() => setMore((m) => !m)}>More</button>
        <div id="bs-more" hidden={!more}>
          <div className="field bs-field">
            <label htmlFor="bs-learn">What training is called</label>
            <input id="bs-learn" className="input" maxLength={40} value={f.learn} onChange={(e) => set({ learn: e.target.value })} />
          </div>
          <div className="field bs-field">
            <label htmlFor="bs-short">Name under the home-screen icon</label>
            <input id="bs-short" className="input" maxLength={30} value={f.shortName} aria-describedby="bs-short-hint" onChange={(e) => set({ shortName: e.target.value })} />
            <p className="bs-hint" id="bs-short-hint">About 12 characters fit under an icon.</p>
          </div>
          <label className="ot-check bs-check">
            <input type="checkbox" checked={f.emailHeader} disabled={!f.logo} onChange={(e) => set({ emailHeader: e.target.checked })} />
            <span>Put the logo on top of newsletters</span>
          </label>
        </div>
      </div>

      <div className="bs-side">
        <Sample f={f} name={name} />
        <section aria-labelledby="bs-read">
          <h2 className="ot-sec-h" id="bs-read">Can everyone read it?</h2>
          <ul className="bs-notes" aria-live="polite">
            {notes.map((n) => (
              <li key={n.text} className={`bs-note bs-note--${n.kind}`}>
                <span className="bs-note__mark" aria-hidden="true">{n.kind === 'ok' ? '✓' : n.kind === 'warn' ? '!' : '·'}</span>
                <span className="bs-note__words">
                  {n.kind === 'warn' && <span className="ot-sr">Warning: </span>}{n.text}
                  {n.fix && <button type="button" className="btn ot-btn-tap bs-note__fix" onClick={() => set({ sidebar: n.fix.sidebar })}>{n.fix.label}</button>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="bs-acts">
        {said === 'site' && <p className="bs-said" role="status">Copied from the website. Save to use them.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {!online && <NeedsSignalLine>Changing the brand needs signal</NeedsSignalLine>}
        <div className="bs-acts__row">
          <button type="submit" className="btn btn-primary ot-btn-tap" disabled={off || (!dirty && !unsaved)}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
          {siteOwn && <button type="button" className="btn ot-btn-tap" disabled={off} onClick={fromSite}>Use the website’s colours and logo</button>}
          {!unsaved && !confirming && <button type="button" className="btn btn-quiet ot-btn-tap" disabled={off} onClick={() => setConfirming(true)}>Back to {startWord}</button>}
        </div>
        {confirming && (
          <div className="ot-confirm" role="group" aria-label={`Back to ${startWord}`}>
            <span>Take your colours and logo off every screen?</span>
            <button type="button" className="btn ot-btn-tap" disabled={off} onClick={reset}>{busy === 'reset' ? 'Going back…' : 'Yes, go back'}</button>
            <button type="button" className="btn btn-quiet ot-btn-tap" disabled={off} onClick={() => setConfirming(false)}>No</button>
          </div>
        )}
      </div>
    </form>
  );
}
