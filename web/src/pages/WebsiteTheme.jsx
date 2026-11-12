// Website → Theme (/website/theme): the site's look (shared/site/theme.js).
//   Start from a look (the skins: Base, Imagine Surrey), then the colours —
//   each pair that must stay readable (theme.js PAIRS) shows its contrast as
//   it changes, and one under 4.5:1 blocks saving, with "Fix it" (the
//   nearest readable colour for its text). Then the type (heading and body
//   fonts), the corners, the logo. A live sample beside it: the title bar,
//   text and a link, the buttons, a soft panel and a band, in these colours.
//   One primary, "Save the look" (live on the site at once — there's no draft
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
import { useEffect, useMemo, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { COLOR_KEYS, FONTS, FONT_BY_VALUE, RADII, SKINS } from '@starbase/shared/site/theme';
import { action } from '../api.js';
import { at } from '../base.js';
import { NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import { SaveState, Toast, WebsiteTabs, useToast } from '../components/site/Bits.jsx';
import { ImageField } from '../components/site/Fields.jsx';
import { useMicrosite, useSite, useSiteRefresh } from '../components/site/useSite.js';
import { SiteBack } from './WebsiteSite.jsx';
import { colorWords, hexOf, pairsOf, ratioWords, readableInk } from '../components/site/colors.js';
import './shifts.css';
import '../editor.css';
import './website.css';
import './website-follow.css';

// A theme as the server keeps it, with every key there (a skin's for any missing).
const full = (t) => {
  const skin = SKINS[t?.skin] || SKINS.base;
  const out = {
    skin: skin.key,
    colors: Object.fromEntries(COLOR_KEYS.map((k) => [k, hexOf(t?.colors?.[k]) || skin.colors[k]])),
    fonts: { heading: FONT_BY_VALUE[t?.fonts?.heading] ? t.fonts.heading : skin.fonts.heading, body: FONT_BY_VALUE[t?.fonts?.body] ? t.fonts.body : skin.fonts.body },
    radius: RADII.some((r) => r.value === t?.radius) ? t.radius : skin.radius,
    logo: { url: t?.logo?.url || '', alt: t?.logo?.alt || '' },
  };
  // A look with its own switches (the heading shadow, where theme.js has it) keeps them.
  if (typeof t?.pop === 'boolean' || typeof skin.pop === 'boolean') out.pop = typeof t?.pop === 'boolean' ? t.pop : Boolean(skin.pop);
  return out;
};
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
        {bad && <p className="wb-field__err" id={`${id}-err`}>A colour like #003979</p>}
      </div>
    </div>
  );
}

function Sample({ t, org }) {
  const c = t.colors;
  const r = RADII.find((x) => x.value === t.radius)?.px ?? 10;
  const style = {
    '--s-brand': c.brand, '--s-brand-ink': c.brandInk, '--s-accent': c.accent, '--s-accent-ink': c.accentInk,
    '--s-ink': c.ink, '--s-paper': c.paper, '--s-surface': c.surface, '--s-line': c.line, '--s-link': c.link,
    '--s-action': c.action || c.brand, '--s-action-ink': c.actionInk || c.brandInk,
    '--s-radius': `${r}px`, '--s-head': FONT_BY_VALUE[t.fonts.heading]?.stack, '--s-body': FONT_BY_VALUE[t.fonts.body]?.stack,
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
          <span className="wb-sample__btn">Join us</span>
          <span className="wb-sample__btn wb-sample__btn--accent">Volunteer</span>
        </div>
        <div className="wb-sample__panel"><b>A soft panel</b> — newsletters and forms sit on these.</div>
      </div>
      <div className="wb-sample__band">
        <span className="wb-sample__bandh">When we organize, <mark>we win</mark></span>
        <span className="wb-sample__btn wb-sample__btn--brand">Join us</span>
      </div>
    </div>
  );
}

export default function WebsiteTheme() {
  const { me } = useOutletContext() || {};
  const { siteId } = useParams();
  const mainQ = useSite(!siteId);
  const msQ = useMicrosite(siteId);
  const q = siteId ? msQ : mainQ;
  // What it wears as saved: the main site's settings, or the other website's own.
  const savedTheme = siteId ? q.data?.microsite?.theme : q.data?.settings?.theme;
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
    const s = SKINS[key];
    setT((x) => full({ ...s, skin: key, logo: x.logo, pop: s.pop }));
  };
  const fix = (p) => setColor(p.fg, readableInk(t.colors[p.fg], t.colors[p.bg]));
  const save = async () => {
    if (failing.length) return;
    setState({ state: 'saving' });
    try {
      await action(...(siteId ? ['site.microsite.save', { id: siteId, theme: t }] : ['site.settings.save', { theme: t }]));
      setSaved(t);
      setState({ state: 'saved', at: Date.now() });
      say('Saved — the site has its new look');
      refresh(siteId ? ['microsite', siteId] : ['site']);
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

  const org = siteId ? q.data?.microsite?.name || '' : q.data?.settings?.org?.shortName || q.data?.settings?.org?.name || '';
  return (
    <div className="wb-page wb-page--wide">
      {siteId && <SiteBack d={q.data} id={siteId} />}
      <div className="ops-head">
        <h1>{siteId ? 'Look' : 'Theme'}</h1>
        {t && !following && (
          <div className="ops-head__actions">
            <SaveState state={state} />
            <button type="button" className="btn btn-primary ops-tap" onClick={save}
              disabled={!online || !dirty || failing.length > 0 || state?.state === 'saving'}>
              {state?.state === 'saving' ? 'Saving…' : 'Save the look'}
            </button>
          </div>
        )}
      </div>
      {!siteId && <WebsiteTabs />}
      {noSignal(q) && <NoSignal />}
      {q.isPending && !noSignal(q) && <p className="muted">Loading…</p>}
      {q.isError && !noSignal(q) && <p className="error" role="alert">{q.error.message}</p>}
      {t && following && (
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
            <Sample t={full(q.data.brand_theme)} org={org} />
          </div>
        </>
      )}
      {t && !following && (
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
          <p className="wb-help">Changes show on the site as soon as you save — there’s no draft of the look.</p>
          <div className="wb-theme">
            <div className="wb-theme__controls">
              <section className="card" aria-labelledby="wb-th-skin">
                <h2 id="wb-th-skin" className="wb-card-h">Start from a look</h2>
                <div className="wb-skins" role="radiogroup" aria-labelledby="wb-th-skin">
                  {Object.values(SKINS).map((s) => (
                    <label key={s.key} className="wb-skin" data-on={t.skin === s.key ? '' : undefined}>
                      <input type="radio" name="wb-skin" checked={t.skin === s.key} onChange={() => pickSkin(s.key)} />
                      <span className="wb-skin__name">{s.label}</span>
                      <span className="wb-skin__dots" aria-hidden="true">
                        {['brand', 'accent', 'ink', 'surface'].map((k) => <span key={k} style={{ background: s.colors[k] }} />)}
                      </span>
                    </label>
                  ))}
                </div>
                <p className="wb-field__hint">Picking one sets its colours, type and corners; your logo stays.</p>
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

              <section className="card" aria-labelledby="wb-th-type">
                <h2 id="wb-th-type" className="wb-card-h">Type</h2>
                <div className="form-row">
                  {[['heading', 'Headings'], ['body', 'Everything else']].map(([k, label]) => (
                    <div className="field wb-field" key={k}>
                      <label htmlFor={`wb-font-${k}`}>{label}</label>
                      <select id={`wb-font-${k}`} className="input" value={t.fonts[k]}
                        onChange={(e) => setT((x) => ({ ...x, fonts: { ...x.fonts, [k]: e.target.value } }))}>
                        {FONTS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
                <p className="wb-field__hint">The site loads its own fonts; the sample here may use a near match.</p>
              </section>

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
                {typeof t.pop === 'boolean' && (
                  <div className="wb-toggle">
                    <input id="wb-pop" type="checkbox" className="wb-toggle__box" checked={t.pop} onChange={(e) => setT((x) => ({ ...x, pop: e.target.checked }))} />
                    <label htmlFor="wb-pop">A shadow under big headings</label>
                  </div>
                )}
              </section>

              <section className="card" aria-labelledby="wb-th-logo">
                <h2 id="wb-th-logo" className="wb-card-h">Logo</h2>
                <ImageField id="wb-logo" label="The logo in the title bar" value={t.logo}
                  hint="A PNG with a see-through background works best on the brand colour."
                  onChange={(v) => setT((x) => ({ ...x, logo: v }))} />
              </section>
            </div>
            <div className="wb-theme__sample">
              <Sample t={t} org={org} />
            </div>
          </div>
        </>
      )}
      <Toast toast={toast} onClear={clear} />
    </div>
  );
}
