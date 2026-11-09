// Website → Theme (/website/theme): the site's look (shared/site/theme.js).
//   Start from a look (the skins: Base, Imagine Surrey), then the colours —
//   each pair that must stay readable (theme.js PAIRS) shows its contrast as
//   it changes, and one under 4.5:1 blocks saving, with "Fix it" (the
//   nearest readable colour for its text). Then the type (heading and body
//   fonts), the corners, the logo. A live sample beside it: the title bar,
//   text and a link, the buttons, a soft panel and a band, in these colours.
//   One yellow "Save the look" (live on the site at once — there's no draft
//   of the theme); the server checks the contrast again (site.settings.save).
import { useEffect, useMemo, useState } from 'react';
import { COLOR_KEYS, FONTS, FONT_BY_VALUE, RADII, SKINS } from '@starbase/shared/site/theme';
import { action } from '../api.js';
import { at } from '../base.js';
import { NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import { SaveState, Toast, WebsiteTabs, useToast } from '../components/site/Bits.jsx';
import { ImageField } from '../components/site/Fields.jsx';
import { useSite, useSiteRefresh } from '../components/site/useSite.js';
import { colorWords, hexOf, pairsOf, ratioWords, readableInk } from '../components/site/colors.js';
import './shifts.css';
import '../editor.css';
import './website.css';

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
  const q = useSite();
  const refresh = useSiteRefresh();
  const online = useOnline();
  const { toast, say, clear } = useToast();
  const [t, setT] = useState(null);
  const [saved, setSaved] = useState(null);
  const [state, setState] = useState(null);
  useEffect(() => {
    if (q.data?.settings && !t) {
      const f = full(q.data.settings.theme);
      setT(f);
      setSaved(f);
    }
  }, [q.data, t]);
  const pairs = useMemo(() => (t ? pairsOf(t.colors) : []), [t]);
  const failing = pairs.filter((p) => !p.ok);
  const dirty = t && saved && !same(t, saved);

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
      await action('site.settings.save', { theme: t });
      setSaved(t);
      setState({ state: 'saved', at: Date.now() });
      say('Saved — the site has its new look');
      refresh(['site']);
    } catch (e) {
      setState({ state: 'error', text: e.message });
    }
  };

  const org = q.data?.settings?.org?.shortName || q.data?.settings?.org?.name || '';
  return (
    <div className="wb-page wb-page--wide">
      <div className="ops-head">
        <h1>Theme</h1>
        {t && (
          <div className="ops-head__actions">
            <SaveState state={state} />
            <button type="button" className="btn btn-primary ops-tap" onClick={save}
              disabled={!online || !dirty || failing.length > 0 || state?.state === 'saving'}>
              {state?.state === 'saving' ? 'Saving…' : 'Save the look'}
            </button>
          </div>
        )}
      </div>
      <WebsiteTabs />
      {noSignal(q) && <NoSignal />}
      {q.isPending && !noSignal(q) && <p className="muted">Loading…</p>}
      {q.isError && !noSignal(q) && <p className="error" role="alert">{q.error.message}</p>}
      {t && (
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
