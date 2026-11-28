// Website → Theme (/website/theme): the site's look (shared/site/theme.js).
//   It opens on the looks (WEB 3b): Base, the campaign's own where its server
//   sends one (GET /api/site skins) and the ready looks every campaign gets
//   (shared/site/looks.js), the one in use marked; beside them, a live
//   preview of the published home page in the look being tried
//   (LookPreview: a preview link of the published page, the look posted to
//   it — web/src/site-preview.js). Nothing is live until "Use this look".
//   After a change, "Back to the look from <date>" (the server keeps the
//   look before: settings.look_before). Then the details: heading sizes
//   (As today · Modern) and shadow, the colours —
//   each pair that must stay readable (theme.js PAIRS) shows its contrast as
//   it changes, and one under 4.5:1 blocks saving, with "Fix it" (the
//   nearest readable colour for its text). Then the fonts (drawn in their
//   own letters; Change fonts opens the sheet: FontSheet.jsx, WA), the
//   corners, the logo. A live sample beside it: the title bar,
//   text and a link, the buttons, a soft panel and a band, in these colours.
//   One primary, "Use this look" (live on the site at once — there's no draft
//   of the theme); the server checks the contrast again (site.settings.save).
//   A website can instead follow the campaign's brand (Settings → Brand;
//   theme.follow — a new website does until it is given its own look): then
//   this screen says so and shows the sample, with "Give the website its own
//   look" (starts from what it wears now). A website with its own look has
//   "Use the campaign's brand" — and its own look is kept underneath
//   (theme.kept), so while it follows there is "Go back to the look it had"
//   beside "Start from the campaign's brand".
// Another website's look (/website/sites/:siteId/look) is this same screen
// with its site: always its own (no following the brand — "Start from the
// campaign's brand" copies the brand's look once), saved with
// site.microsite.save { theme }.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { COLOR_KEYS, FONT_BY_VALUE, RADII, SCALES, SKINS, lookOf } from '@base-win/shared/site/theme';
import { full } from './themeDraft.js';
import { defaultsFor } from '@base-win/shared/site/catalogue';
import { siteLooks } from '../components/site/builder.js';
import { ex } from '../brand.js';
import { fontFor, profileFor } from '@base-win/shared/site/fonts';
import FontSheet, { useAddedFonts } from '../components/site/FontSheet.jsx';
import { stackOf, useFaces } from '../components/site/fontFaces.js';
import { useSitePage } from '../components/site/useSite.js';
import { action, apiPost } from '../api.js';
import { at } from '../base.js';
import { NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import { SaveState, Toast, WebsiteTabs, useToast } from '../components/site/Bits.jsx';
import { ImageField } from '../components/site/Fields.jsx';
import { useMicrosite, useSite, useSiteRefresh } from '../components/site/useSite.js';
import { SiteBack, SiteGone } from './WebsiteSite.jsx';
import { colorWords, hexOf, pairsOf, ratioWords, readableInk } from '../components/site/colors.js';
import './shifts.css';
import '../editor.css';
import './website.css';
import './website-follow.css';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function ColorRow({ k, value, onChange }) {
  // What's being typed (null when not typing: the box shows the colour).
  const [typed, setTyped] = useState(null);
  const id = `wb-c-${k}`;
  const bad = typed != null && typed !== '' && !hexOf(typed);
  return (
    <div className="wb-color">
      <input type="color" className="wb-color__pick" value={value} aria-label={`${colorWords(k)}: pick a colour`}
        onChange={(e) => onChange(e.target.value)} />
      <div className="wb-color__words">
        <label htmlFor={id}>{colorWords(k)}</label>
        <input id={id} className="input wb-color__hex" value={typed ?? value} maxLength={7} spellCheck={false} autoComplete="off"
          aria-invalid={bad ? 'true' : undefined} aria-describedby={bad ? `${id}-err` : undefined}
          onChange={(e) => { setTyped(e.target.value); const h = hexOf(e.target.value); if (h) onChange(h); }}
          onBlur={() => setTyped(null)} />
        {bad && <p className="wb-field__err" id={`${id}-err`}>A colour like {ex('colour', '#4f46e5')}</p>}
      </div>
    </div>
  );
}

function Sample({ t, org, added }) {
  const c = t.colors;
  // The sample's band and first button read as a new section would here:
  // the catalogue's own starting words, or the campaign's (useSite).
  const band = defaultsFor('band');
  const cta = defaultsFor('hero').primaryCta?.label;
  const first = cta && cta !== 'Volunteer' ? cta : 'Sign up';
  const r = RADII.find((x) => x.value === t.radius)?.px ?? 10;
  const style = {
    '--s-brand': c.brand, '--s-brand-ink': c.brandInk, '--s-accent': c.accent, '--s-accent-ink': c.accentInk,
    '--s-ink': c.ink, '--s-paper': c.paper, '--s-surface': c.surface, '--s-line': c.line, '--s-link': c.link,
    '--s-action': c.action || c.brand, '--s-action-ink': c.actionInk || c.brandInk,
    '--s-radius': `${r}px`, '--s-head': stackOf(t.fonts.heading, added), '--s-body': stackOf(t.fonts.body, added),
  };
  return (
    <div className="wb-sample" style={style} aria-label="How it looks: a sample">
      <div className="wb-sample__bar">
        {t.logo?.url ? <img src={at(t.logo.url)} alt={t.logo.alt || org} className="wb-sample__logo" /> : <span className="wb-sample__org">{org || 'Your campaign'}</span>}
        <span className="wb-sample__menu" aria-hidden="true">Menu</span>
        <span className="wb-sample__btn wb-sample__btn--action">Donate</span>
      </div>
      <div className="wb-sample__page">
        <p className="wb-sample__h">A headline in this type</p>
        <p className="wb-sample__p">Words people read, on the page, with <span className="wb-sample__a">a link</span> in them.</p>
        <div className="wb-sample__btns">
          <span className="wb-sample__btn">{first}</span>
          <span className="wb-sample__btn wb-sample__btn--accent">Volunteer</span>
        </div>
        <div className="wb-sample__panel"><b>A soft panel</b> — newsletters and forms sit on these.</div>
      </div>
      <div className="wb-sample__band">
        <span className="wb-sample__bandh">{band.title} <mark>{band.highlight}</mark></span>
        <span className="wb-sample__btn wb-sample__btn--brand">{band.cta?.label || first}</span>
      </div>
    </div>
  );
}

// The first sentence of the home page's hero paragraph.
const heroWords = (page) => {
  const hero = (page?.published?.modules || page?.draft?.modules || []).find((m) => m.kind === 'hero' && !m.hidden);
  const text = String(hero?.props?.text || '').replace(/[*_#>`[\]]/g, '').trim();
  const first = (/^.*?[.!?](\s|$)/.exec(text)?.[0] || text).trim();
  return first.length <= 120 ? first : `${first.slice(0, 118).replace(/\s+\S*$/, '')}…`;
};

// The theme's two fonts, drawn in their own files; Change fonts opens the sheet.
function FontsCard({ t, added, org, words, onChange }) {
  const [open, setOpen] = useState(false);
  useFaces([t.fonts.heading, t.fonts.body], added);
  const h = fontFor(t.fonts.heading, added) || FONT_BY_VALUE.inter;
  const p = profileFor(h);
  return (
    <section className="card" aria-labelledby="wb-th-type">
      <h2 id="wb-th-type" className="wb-card-h">Fonts</h2>
      <p className="wb-fonts__h" style={{ fontFamily: h.stack, fontWeight: p.weight, textTransform: p.case, letterSpacing: p.tracking }}>{org || 'Your campaign’s name'}</p>
      <p className="wb-fonts__p" style={{ fontFamily: stackOf(t.fonts.body, added) }}>{words || 'We’re working for a city where everyone has a fair say.'}</p>
      <p className="wb-fonts__names">{h.label} for headings · {(fontFor(t.fonts.body, added) || FONT_BY_VALUE.inter).label} for body text</p>
      <button type="button" className="btn wb-tap" onClick={() => setOpen(true)}>Change fonts</button>
      <FontSheet open={open} onClose={() => setOpen(false)} value={t.fonts} siteName={org} words={words}
        onPick={(fonts) => { onChange(fonts); setOpen(false); }} />
    </section>
  );
}

// The published home page in the look being tried: a preview link of the
// page as it is published (never a newer draft), into which every change
// is posted (wa:look) and drawn at once, before anything is saved.
function LookPreview({ pageId, theme }) {
  const frame = useRef(null);
  const ready = useRef(false);
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let gone = false;
    setUrl(null);
    apiPost('/site/preview-token', { pageId, live: true })
      .then((r) => { if (!gone) setUrl(r.url); })
      .catch(() => { if (!gone) setFailed(true); });
    return () => { gone = true; };
  }, [pageId]);
  const post = () => {
    const w = frame.current?.contentWindow;
    if (w && ready.current) w.postMessage({ type: 'wa:look', theme }, window.location.origin);
  };
  useEffect(() => {
    const on = (e) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== window.location.origin) return;
      if (e.data?.type === 'wa:ready') { ready.current = true; post(); }
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(post, [theme]); // eslint-disable-line react-hooks/exhaustive-deps
  if (failed) return null;
  return (
    <figure className="wb-look-pv">
      <div className="wb-look-pv__box">
        {url ? <iframe ref={frame} src={url} title="Your published home page in this look" className="wb-look-pv__frame" tabIndex={-1} />
          : <p className="muted wb-look-pv__wait">Loading the preview…</p>}
      </div>
      <figcaption className="wb-field__hint">Your published home page in this look. Visitors see it once you use it.</figcaption>
    </figure>
  );
}

// The looks to start from, each with its colours and fonts; the one the site
// wears says so.
function LooksCard({ t, inUse, onPick, children }) {
  return (
    <section className="card" aria-labelledby="wb-th-skin">
      <h2 id="wb-th-skin" className="wb-card-h">Looks</h2>
      <div className="wb-skins" role="radiogroup" aria-labelledby="wb-th-skin">
        {siteLooks().map((s) => (
          <label key={s.key} className="wb-skin" data-on={t.skin === s.key ? '' : undefined}>
            <input type="radio" name="wb-skin" checked={t.skin === s.key} onChange={() => onPick(s.key)} />
            <span className="wb-skin__words">
              <span className="wb-skin__name">{s.label}</span>
              <span className="wb-skin__fonts">{(FONT_BY_VALUE[s.fonts.heading] || FONT_BY_VALUE.inter).label} · {(FONT_BY_VALUE[s.fonts.body] || FONT_BY_VALUE.inter).label}</span>
              {inUse === s.key && <span className="wb-skin__use">In use</span>}
            </span>
            <span className="wb-skin__dots" aria-hidden="true">
              {['brand', 'accent', 'ink', 'surface'].map((k) => <span key={k} style={{ background: s.colors[k] }} />)}
            </span>
          </label>
        ))}
      </div>
      <p className="wb-field__hint">Picking one shows it in the preview; your logo stays. Nothing changes on the site until you use it.</p>
      {children}
    </section>
  );
}

const day = (iso) => new Date(iso).toLocaleDateString('en-CA', { month: 'long', day: 'numeric' });

export default function WebsiteTheme() {
  const { me } = useOutletContext() || {};
  const { siteId } = useParams();
  // Always read: it also says which looks this campaign has (useSite).
  const mainQ = useSite();
  const msQ = useMicrosite(siteId);
  const q = siteId ? msQ : mainQ;
  // What it wears as saved: the main site's settings, or the other website's own.
  // A deleted website's look isn't edited (its overview brings it back).
  const savedTheme = siteId ? (q.data?.deleted ? null : q.data?.microsite?.theme) : q.data?.settings?.theme;
  const refresh = useSiteRefresh();
  const online = useOnline();
  const { toast, say, clear } = useToast();
  const [t, setT] = useState(null);
  const [saved, setSaved] = useState(null);
  const [state, setState] = useState(null);
  // Following the campaign's brand: as the server has it, until changed here.
  const [follow, setFollow] = useState(null);
  const [asking, setAsking] = useState(false);
  const [switching, setSwitching] = useState(false);
  const following = !siteId && (follow ?? (savedTheme?.follow === true));
  // Its own look from before it followed is still there (set to follow here,
  // or the server says so).
  const keptLook = follow === true || (follow == null && savedTheme?.kept === true);
  useEffect(() => {
    if (savedTheme && !t) {
      const f = full(savedTheme);
      setT(f);
      setSaved(f);
    }
  }, [q.data, t]);
  const pairs = useMemo(() => (t ? pairsOf(t.colors) : []), [t]);
  const failing = pairs.filter((p) => !p.ok);
  const dirty = t && saved && !same(t, saved);
  useEffect(() => {
    const warn = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const setColor = (k, v) => setT((x) => ({ ...x, colors: { ...x.colors, [k]: v } }));
  const pickSkin = (key) => {
    const s = lookOf(key) || SKINS.base;
    setT((x) => full({ ...s, skin: key, logo: x.logo, pop: s.pop }));
  };
  const fix = (p) => setColor(p.fg, readableInk(t.colors[p.fg], t.colors[p.bg]));
  const save = async () => {
    if (failing.length) return;
    setState({ state: 'saving' });
    try {
      const r = await action(...(siteId ? ['site.microsite.save', { id: siteId, theme: t }] : ['site.settings.save', { theme: t }]));
      setSaved(t);
      setState({ state: 'saved', at: Date.now() });
      say(['Saved — the site has its new look', ...(r?.notes || [])].join('. '));
      refresh(siteId ? ['microsite', siteId] : ['site']);
    } catch (e) {
      setState({ state: 'error', text: e.message });
    }
  };
  // Back to the look it had before the last change (the main site's).
  const before = !siteId ? q.data?.settings?.look_before : null;
  const goBack = async () => {
    const back = full(before.theme);
    setState({ state: 'saving' });
    try {
      await action('site.settings.save', { theme: back });
      setT(back);
      setSaved(back);
      setState({ state: 'saved', at: Date.now() });
      say(`The site has the look from ${day(before.at)} again`);
      refresh(['site']);
    } catch (e) {
      setState({ state: 'error', text: e.message });
    }
  };

  // To the campaign's brand and back. Both are live on the site at once.
  // back: 'kept' — to the look it had before it followed; else its own look
  // starts from what the site wears now, the brand's.
  const switchTo = async (on, back) => {
    setSwitching(back || true);
    setState(null);
    try {
      const own = on || back === 'kept' ? saved : full(q.data.brand_theme);
      await action('site.settings.save', { theme: { ...own, follow: on } });
      setT(own);
      setSaved(own);
      setFollow(on);
      setAsking(false);
      say(on ? 'The website now wears the campaign’s brand' : back === 'kept' ? 'The website has the look it had — change it here' : 'The website has its own look — change it here');
      refresh(['site']);
    } catch (e) {
      setState({ state: 'error', text: e.message });
    } finally {
      setSwitching(false);
    }
  };

  const shown = t && !(siteId && q.data?.deleted);
  // The campaign's added fonts, and the home page's first words for the samples.
  const added = useAddedFonts().data?.fonts || [];
  const homeId = !siteId ? (q.data?.pages || []).find((p) => p.slug === 'home')?.id : null;
  const home = useSitePage(homeId).data?.page;
  const words = heroWords(home);
  const org = siteId ? q.data?.microsite?.name || '' : q.data?.settings?.org?.shortName || q.data?.settings?.org?.name || '';
  // The live preview: the main site's published home page (else the sample).
  const homeLive = !siteId && (q.data?.pages || []).find((p) => p.slug === 'home' && p.status === 'published');
  const inUse = saved?.skin;
  return (
    <div className="wb-page wb-page--wide">
      {siteId && <SiteBack d={q.data} id={siteId} />}
      <div className="ops-head">
        <h1>{siteId ? 'Look' : 'Theme'}</h1>
        {shown && !following && (
          <div className="ops-head__actions">
            <SaveState state={state} />
            <button type="button" className="btn btn-primary ops-tap" onClick={save}
              disabled={!online || !dirty || failing.length > 0 || state?.state === 'saving'}>
              {state?.state === 'saving' ? 'Saving…' : 'Use this look'}
            </button>
          </div>
        )}
      </div>
      {!siteId && <WebsiteTabs />}
      {noSignal(q) && <NoSignal />}
      {q.isPending && !noSignal(q) && <p className="muted">Loading…</p>}
      {siteId ? <SiteGone q={q} id={siteId} /> : q.isError && !noSignal(q) && <p className="error" role="alert">{q.error.message}</p>}
      {shown && following && (
        <>
          <section className="card wb-follow" aria-labelledby="wb-th-follow">
            <h2 id="wb-th-follow" className="wb-card-h">Following the campaign’s brand</h2>
            <p className="wb-help">The website wears the logo, colours, type and corners set under {me?.role === 'manager' ? <Link to="/settings/brand">Settings → Brand</Link> : 'Settings → Brand (a manager’s)'}. Change them there and the website follows.</p>
            <SaveState state={state} />
            {keptLook ? (
              <>
                <div className="wb-follow__acts">
                  <button type="button" className="btn wb-tap" disabled={!online || Boolean(switching)} onClick={() => switchTo(false, 'kept')}>
                    {switching === 'kept' ? 'Working…' : 'Go back to the look it had'}
                  </button>
                  <button type="button" className="btn wb-tap" disabled={!online || Boolean(switching)} onClick={() => switchTo(false, 'brand')}>
                    {switching === 'brand' ? 'Working…' : 'Start from the campaign’s brand'}
                  </button>
                </div>
                <p className="wb-field__hint">The website’s own colours, type and logo were kept. Starting from the brand replaces them.</p>
              </>
            ) : (
              <>
                <button type="button" className="btn wb-tap" disabled={!online || Boolean(switching)} onClick={() => switchTo(false, 'brand')}>
                  {switching ? 'Working…' : 'Give the website its own look'}
                </button>
                <p className="wb-field__hint">It starts from what the website wears now; then every colour is yours to change here.</p>
              </>
            )}
          </section>
          <div className="wb-theme__sample wb-theme__sample--alone">
            <Sample t={full(q.data.brand_theme)} org={org} added={added} />
          </div>
        </>
      )}
      {shown && !following && (
        <>
          {failing.length > 0 && (
            <div className="wb-alert" role="alert">
              <p><b>{failing.length === 1 ? 'One colour pair is' : `${failing.length} colour pairs are`} too hard to read</b> — every pair needs 4.5:1 before the look can be saved.</p>
              {failing.map((p) => (
                <div key={`${p.fg}-${p.bg}`} className="wb-alert__fix">
                  <span>{p.label}: {ratioWords(p.ratio)}</span>
                  <button type="button" className="btn wb-tap" onClick={() => fix(p)}>Fix it<span className="ws-sr">: {p.label}</span></button>
                </div>
              ))}
            </div>
          )}
          <p className="wb-help">Try a look here: nothing on the site changes until you use it.</p>
          <div className="wb-theme">
            <div className="wb-theme__controls">
              <LooksCard t={t} inUse={inUse} onPick={pickSkin}>
                {before && (
                  <button type="button" className="btn btn-quiet wb-tap wb-back" disabled={!online || state?.state === 'saving'} onClick={goBack}>
                    Back to the look from {day(before.at)}
                  </button>
                )}
                {siteId && q.data?.brand_theme && (
                  <button type="button" className="btn wb-tap wb-follow__use" onClick={() => setT((x) => full({ ...q.data.brand_theme, logo: x.logo }))}>Start from the campaign’s brand</button>
                )}
                {!siteId && !asking && (
                  <button type="button" className="btn wb-tap wb-follow__use" disabled={!online || Boolean(switching)} onClick={() => setAsking(true)}>Use the campaign’s brand</button>
                )}
                {asking && (
                  <div className="wb-follow__ask" role="group" aria-label="Use the campaign’s brand">
                    <span>The website takes the logo, colours, type and corners from Settings → Brand at once. {dirty ? 'The look you last saved is kept to go back to; what you changed here since is not.' : 'Its own look is kept to go back to.'}</span>
                    <button type="button" className="btn wb-tap" disabled={!online || Boolean(switching)} onClick={() => switchTo(true)}>{switching ? 'Working…' : 'Yes, use it'}</button>
                    <button type="button" className="btn btn-quiet wb-tap" disabled={Boolean(switching)} onClick={() => setAsking(false)}>No</button>
                  </div>
                )}
              </LooksCard>

              <h2 className="wb-theme__more">Change the details</h2>
              <section className="card" aria-labelledby="wb-th-heads">
                <h2 id="wb-th-heads" className="wb-card-h">Headings</h2>
                <p className="wb-field__label" id="wb-th-scale">Heading sizes</p>
                <div className="wb-radii" role="radiogroup" aria-labelledby="wb-th-scale">
                  {SCALES.map((x) => (
                    <label key={x.value} className="wb-radius" data-on={(t.scale || 'classic') === x.value ? '' : undefined}>
                      <input type="radio" name="wb-scale" checked={(t.scale || 'classic') === x.value}
                        onChange={() => setT((cur) => { const { scale, ...rest } = cur; return x.value === 'modern' ? { ...rest, scale: 'modern' } : rest; })} />
                      <span>{x.label}</span>
                    </label>
                  ))}
                </div>
                <p className="wb-field__hint">Modern: calmer headings, with the top of each page the biggest thing on it.</p>
                {typeof t.pop === 'boolean' && siteLooks().some((l) => l.pop === true) && (
                  <div className="wb-toggle">
                    <input id="wb-pop" type="checkbox" className="wb-toggle__box" checked={t.pop} onChange={(e) => setT((x) => ({ ...x, pop: e.target.checked }))} />
                    <label htmlFor="wb-pop">A shadow under big headings</label>
                  </div>
                )}
              </section>

              <section className="card" aria-labelledby="wb-th-colors">
                <h2 id="wb-th-colors" className="wb-card-h">Colours</h2>
                <div className="wb-colors">
                  {COLOR_KEYS.map((k) => <ColorRow key={k} k={k} value={t.colors[k]} onChange={(v) => setColor(k, v)} />)}
                </div>
              </section>

              <section className="card" aria-labelledby="wb-th-read">
                <h2 id="wb-th-read" className="wb-card-h">Can everyone read it?</h2>
                <p className="wb-field__hint">Each pair needs a contrast of at least 4.5:1 (WCAG AA) — for people with low vision, and for everyone outdoors on a phone.</p>
                <ul className="wb-pairs">
                  {pairs.map((p) => (
                    <li key={`${p.fg}-${p.bg}`} className="wb-pair" data-ok={p.ok ? '' : undefined}>
                      <span className="wb-pair__sample" style={{ color: t.colors[p.fg], background: t.colors[p.bg] }} aria-hidden="true">Aa</span>
                      <span className="wb-pair__words">
                        <span className="wb-pair__label">{p.label}</span>
                        <span className="wb-pair__ratio">{ratioWords(p.ratio)} — {p.ok ? 'easy to read' : 'too hard to read (needs 4.5:1)'}</span>
                      </span>
                      {!p.ok && (
                        <button type="button" className="btn wb-tap" onClick={() => fix(p)} aria-label={`Fix it: ${p.label}`}>Fix it</button>
                      )}
                      {p.ok && <span className="wb-pair__ok" aria-hidden="true">✓</span>}
                    </li>
                  ))}
                </ul>
              </section>

              <FontsCard t={t} added={added} org={org} words={words} onChange={(fonts) => setT((x) => ({ ...x, fonts }))} />

              <section className="card" aria-labelledby="wb-th-corners">
                <h2 id="wb-th-corners" className="wb-card-h">Corners</h2>
                <div className="wb-radii" role="radiogroup" aria-labelledby="wb-th-corners">
                  {RADII.map((r) => (
                    <label key={r.value} className="wb-radius" data-on={t.radius === r.value ? '' : undefined}>
                      <input type="radio" name="wb-radius" checked={t.radius === r.value} onChange={() => setT((x) => ({ ...x, radius: r.value }))} />
                      <span className="wb-radius__box" style={{ borderRadius: `${r.px}px` }} aria-hidden="true" />
                      <span>{r.label}</span>
                    </label>
                  ))}
                </div>
              </section>

              <section className="card" aria-labelledby="wb-th-logo">
                <h2 id="wb-th-logo" className="wb-card-h">Logo</h2>
                <ImageField plain id="wb-logo" label="The logo in the title bar" value={t.logo}
                  hint="A PNG with a see-through background works best on the brand colour."
                  onChange={(v) => setT((x) => ({ ...x, logo: v }))} />
              </section>
            </div>
            <div className="wb-theme__sample">
              {homeLive ? <LookPreview pageId={homeLive.id} theme={t} /> : <Sample t={t} org={org} added={added} />}
            </div>
          </div>
        </>
      )}
      <Toast toast={toast} onClear={clear} />
    </div>
  );
}
