// Settings → Brand (managers): how base ground looks for the campaign — on
// every volunteer's phone, in the desk, on the sign-in page and on the
// server's public pages (unsubscribe, receipts, lessons).
//
//   Preset      a starting look (shared/brand.js PRESETS); picking one fills
//               the colours, font and corners. Reset to preset puts them back.
//   Name, logo  the top bar's (empty: the campaign's own name, base
//               ground's own mark); a logo is an upload (blast.picture,
//               /media/…) or an https:// address
//   Colours     primary, accent, background, text, text on primary, text on
//               accent: a colour picker and a hex field each
//   Font, corners
//   Preview     the app's own pieces in the brand being edited (the draft's
//               tokens on a wrapper, nothing else changes until Save)
//   Contrast    every pair shared/brand.js checks, with its ratio: field body
//               text held to 7:1, the rest 4.5:1. Saving with a pair under
//               its line asks first.
// Save → brand.save (ext/brand); the open app takes the new look at once
// (brand.js applyBrand) and every page the server sends after carries it.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PRESETS, PRESET_KEYS, FONTS, FONT_KEYS, CORNERS, CORNER_KEYS, COLOR_KEYS, COLOR_LABELS,
  brandOf, presetBrand, tokens, checks, isHex, isLogo, NAME_MAX,
} from '@base-ground/shared/brand';
import { ratioText } from '@base-ground/shared/contrast';
import { action, apiGet } from '../api.js';
import { applyBrand, assetUrl, BRAND_KEY } from '../brand.js';
import { NoSignal, noSignal, useOnline, NeedsSignalLine } from './NoSignal.jsx';
import { uploadImage } from './MarkdownField.jsx';
import { OwnMark } from './BrandMark.jsx';
import '../pages/map.css';
import './brand-settings.css';

const COLOR_HELP = {
  primary: 'Buttons, the top bar, links',
  accent: 'The spark: badges, the active tab, the avatar',
  surface: 'The page behind everything',
  ink: 'Body text',
  onPrimary: 'Words on primary buttons and the top bar',
  onAccent: 'Words on accent badges',
};
const SOURCE_WORDS = {
  saved: 'Saved here',
  settings: 'Pre-configured in the hosting’s settings (BASE_BRAND_*) — nothing saved here yet',
  default: 'The Ground preset — nothing saved yet',
};

// What the form edits: the brand, with each colour as typed (a hex field can
// be half-typed; only a whole colour reaches the draft brand).
const formOf = (b) => ({ ...b, name: b.name || '', logo: b.logo || '', hexText: Object.fromEntries(COLOR_KEYS.map((k) => [k, b[k]])) });
const brandFromForm = (f) => brandOf({ ...f, name: f.name, logo: f.logo || null });
const same = (a, b) => JSON.stringify(brandOf(a)) === JSON.stringify(brandOf(b));
const styleOf = (b) => {
  const t = tokens(b);
  const out = {};
  for (const [k, v] of Object.entries(t)) out[k === 'color-scheme' ? 'colorScheme' : k] = v;
  return out;
};

export default function BrandSettings({ me }) {
  const qc = useQueryClient();
  const online = useOnline();
  const q = useQuery({ queryKey: BRAND_KEY, queryFn: () => apiGet('/brand') });
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);
  const [asking, setAsking] = useState(null);
  const loadedRef = useRef(null);

  // The form starts from what's in force, and follows it while nothing is edited.
  useEffect(() => {
    if (!q.data?.brand) return;
    if (!form || (loadedRef.current && same(brandFromForm(form), loadedRef.current))) setForm(formOf(q.data.brand));
    loadedRef.current = q.data.brand;
  }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const draft = useMemo(() => (form ? brandFromForm(form) : null), [form]);
  const pairs = useMemo(() => (draft ? checks(draft) : []), [draft]);
  const low = pairs.filter((p) => !p.ok);
  const badHex = form ? COLOR_KEYS.filter((k) => !isHex(form.hexText[k])) : [];
  const badLogo = form && form.logo && !isLogo(form.logo.trim());

  if (!q.data || !form) {
    return noSignal(q) ? <NoSignal /> : q.isError ? <p className="error">{q.error.message}</p> : <p className="muted">Loading…</p>;
  }
  const changed = !same(draft, q.data.brand);
  const campaign = me?.workspace?.name || 'the campaign';

  const set = (patch) => { setSaved(null); setAsking(null); setForm((f) => ({ ...f, ...patch })); };
  const setColor = (k, v) => {
    const text = v.startsWith('#') ? v : `#${v}`;
    setSaved(null); setAsking(null);
    setForm((f) => ({ ...f, ...(isHex(text) ? { [k]: text.toLowerCase() } : {}), hexText: { ...f.hexText, [k]: v } }));
  };
  const pickPreset = (key) => {
    const p = presetBrand(key);
    setSaved(null); setAsking(null);
    setForm((f) => ({ ...formOf({ ...p, name: f.name, logo: f.logo }) }));
  };
  const resetToPreset = () => pickPreset(form.preset);

  const save = async (confirmLowContrast = false) => {
    if (badHex.length || badLogo) return;
    if (low.length && !confirmLowContrast) { setAsking(low); return; }
    setBusy(true); setError(null); setAsking(null);
    try {
      const res = await action('brand.save', { ...draft, name: form.name.trim() || null, logo: form.logo.trim() || null, confirmLowContrast });
      const name = res.brand.name || campaign;
      qc.setQueryData(BRAND_KEY, (old) => ({ ...(old || {}), brand: res.brand, source: 'saved', name, checks: res.checks, updatedAt: new Date().toISOString(), updatedBy: me?.user?.name || null }));
      applyBrand(res.brand, name);
      loadedRef.current = res.brand;
      setSaved('Saved. Everyone sees it the next time a screen loads; this one already does.');
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const clearSaved = async () => {
    setBusy(true); setError(null);
    try {
      const res = await action('brand.clear', {});
      const name = campaign;
      qc.setQueryData(BRAND_KEY, (old) => ({ ...(old || {}), brand: res.brand, source: res.source, name, checks: res.checks }));
      applyBrand(res.brand, name);
      loadedRef.current = res.brand;
      setForm(formOf(res.brand));
      setSaved(res.source === 'settings' ? 'Back to the pre-configured brand.' : 'Back to the Ground preset.');
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const onUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const media = await uploadImage(file);
      set({ logo: media.url });
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const src = q.data.source;
  return (
    <div className="bs">
      <p className="bs-lead">
        How base ground looks for {campaign}: on every volunteer’s phone, in the desk, on the sign-in page and on the
        pages the server sends (unsubscribe, receipts, lessons).
      </p>
      <p className="bs-source">
        <span className={`chip ${src === 'saved' ? 'chip-ok' : ''}`}>{SOURCE_WORDS[src]}</span>
        {src === 'saved' && q.data.updatedBy && <span className="muted"> · by {q.data.updatedBy}{q.data.updatedAt ? `, ${new Date(q.data.updatedAt).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}</span>}
      </p>
      {!online && <NeedsSignalLine>Saving the brand needs signal</NeedsSignalLine>}

      <div className="bs-grid">
        <div className="bs-form">
          <fieldset className="bs-sec">
            <legend className="bs-h">Preset</legend>
            <div className="bs-presets">
              {PRESET_KEYS.map((key) => {
                const p = PRESETS[key];
                return (
                  <label key={key} className={`bs-preset${form.preset === key ? ' is-on' : ''}`}>
                    <input type="radio" name="bs-preset" value={key} checked={form.preset === key} onChange={() => pickPreset(key)} />
                    <span className="bs-preset__sw" aria-hidden="true" style={{ background: p.surface, borderColor: p.ink }}>
                      <span style={{ background: p.primary }} />
                      <span style={{ background: p.accent }} />
                      <span style={{ background: p.ink }} />
                    </span>
                    <span className="bs-preset__text">
                      <span className="bs-preset__name">{p.label}{key === 'ground' ? ' · default' : ''}</span>
                      <span className="bs-preset__about">{p.about}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <button type="button" className="btn btn-quiet bs-reset" disabled={busy} onClick={resetToPreset}>
              Reset to preset ({PRESETS[form.preset].label})
            </button>
          </fieldset>

          <fieldset className="bs-sec">
            <legend className="bs-h">Name and logo</legend>
            <div className="field">
              <label htmlFor="bs-name">Name in the top bar</label>
              <input id="bs-name" className="input" maxLength={NAME_MAX} placeholder={campaign}
                value={form.name} onChange={(e) => set({ name: e.target.value })} />
            </div>
            <div className="bs-logo">
              <span className="bs-logo__show" aria-hidden="true" style={styleOf(draft)}>
                {form.logo && !badLogo ? <img src={assetUrl(form.logo.trim())} alt="" /> : <OwnMark className="bs-logo__mark" />}
              </span>
              <div className="bs-logo__acts">
                <input id="bs-logo-file" type="file" accept="image/jpeg,image/png,image/webp" className="bs-file" onChange={onUpload} disabled={busy || !online} />
                <label htmlFor="bs-logo-file" className={`btn ops-tap${busy || !online ? ' is-disabled' : ''}`}>Upload a logo</label>
                {form.logo && <button type="button" className="btn btn-quiet" onClick={() => set({ logo: '' })}>Use base ground’s mark</button>}
              </div>
            </div>
            <div className="field">
              <label htmlFor="bs-logo-url">Or the logo’s address</label>
              <input id="bs-logo-url" className="input" inputMode="url" placeholder="https://…" maxLength={500}
                value={form.logo} onChange={(e) => set({ logo: e.target.value })} aria-invalid={badLogo || undefined} />
              {badLogo && <span className="error">An https:// address of a picture, or upload one</span>}
            </div>
          </fieldset>

          <fieldset className="bs-sec">
            <legend className="bs-h">Colours</legend>
            <div className="bs-colors">
              {COLOR_KEYS.map((k) => (
                <div key={k} className="bs-color">
                  <label htmlFor={`bs-hex-${k}`} className="bs-color__label">{COLOR_LABELS[k]}<span className="bs-color__help">{COLOR_HELP[k]}</span></label>
                  <span className="bs-color__row">
                    <input type="color" className="bs-color__pick" aria-label={`${COLOR_LABELS[k]}: pick a colour`}
                      value={form[k]} onChange={(e) => setColor(k, e.target.value)} />
                    <input id={`bs-hex-${k}`} className="input bs-color__hex" spellCheck={false} autoCapitalize="off" maxLength={7}
                      value={form.hexText[k]} onChange={(e) => setColor(k, e.target.value.trim())}
                      aria-invalid={!isHex(form.hexText[k]) || undefined} />
                  </span>
                  {!isHex(form.hexText[k]) && <span className="error">Six hex digits, like #1f4d2e</span>}
                </div>
              ))}
            </div>
          </fieldset>

          <fieldset className="bs-sec">
            <legend className="bs-h">Font</legend>
            <div className="bs-fonts">
              {FONT_KEYS.map((key) => (
                <label key={key} className={`bs-font${form.font === key ? ' is-on' : ''}`}>
                  <input type="radio" name="bs-font" value={key} checked={form.font === key} onChange={() => set({ font: key })} />
                  <span className="bs-font__text">
                    <span className="bs-font__sample" style={{ fontFamily: FONTS[key].display, fontWeight: FONTS[key].displayWeight }}>{FONTS[key].label}</span>
                    <span className="bs-font__about" style={{ fontFamily: FONTS[key].sans }}>{FONTS[key].about}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="bs-sec">
            <legend className="bs-h">Corners</legend>
            <div className="bs-corners" role="radiogroup" aria-label="Corners">
              {CORNER_KEYS.map((key) => (
                <label key={key} className={`bs-corner${form.corners === key ? ' is-on' : ''}`}>
                  <input type="radio" name="bs-corners" value={key} checked={form.corners === key} onChange={() => set({ corners: key })} />
                  <span className="bs-corner__shape" aria-hidden="true" style={{ borderRadius: CORNERS[key].card }} />
                  {CORNERS[key].label}
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <div className="bs-side">
          <Preview brand={draft} name={form.name.trim() || campaign} logo={form.logo && !badLogo ? form.logo.trim() : null} />
          <Contrast pairs={pairs} />
        </div>
      </div>

      <div className="bs-bar" role="group" aria-label="Save the brand">
        {asking && (
          <div className="bs-ask" role="alertdialog" aria-labelledby="bs-ask-h">
            <p id="bs-ask-h" className="bs-ask__h">{asking.length === 1 ? 'One pair is' : `${asking.length} pairs are`} under the contrast line:</p>
            <ul className="bs-ask__list">
              {asking.map((p) => <li key={p.key}>{p.label}: {ratioText(p.ratio)}, needs {p.min}:1</li>)}
            </ul>
            <p className="muted">Volunteers read these outdoors, often in sun. Save anyway?</p>
            <span className="bs-ask__acts">
              <button type="button" className="btn ot-btn-danger" disabled={busy} onClick={() => save(true)}>Save anyway</button>
              <button type="button" className="btn btn-quiet" onClick={() => setAsking(null)}>Keep editing</button>
            </span>
          </div>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        {saved && <p className="bs-saved" role="status">✓ {saved}</p>}
        <span className="bs-bar__acts">
          <button type="button" className="btn btn-primary bs-save" disabled={busy || !online || !changed || badHex.length > 0 || badLogo}
            onClick={() => save(false)}>{busy ? 'Saving…' : 'Save brand'}</button>
          {changed && <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => { setForm(formOf(q.data.brand)); setAsking(null); setError(null); }}>Undo changes</button>}
          {!changed && src === 'saved' && (
            <button type="button" className="btn btn-quiet" disabled={busy || !online} onClick={clearSaved}>
              {q.data.preconfigured ? 'Back to the pre-configured brand' : 'Back to the Ground preset'}
            </button>
          )}
          {low.length > 0 && <span className="bs-bar__low">{low.length} under the contrast line</span>}
        </span>
      </div>
    </div>
  );
}

// The app's own pieces in the draft brand: its tokens on this box only.
function Preview({ brand, name, logo }) {
  const [rated, setRated] = useState('1');
  return (
    <section className="bs-preview" style={styleOf(brand)} aria-label="Preview">
      <div className="bs-pv-bar">
        <span className="bs-pv-brand">
          {logo ? <img className="bs-pv-logo" src={assetUrl(logo)} alt="" /> : <OwnMark className="bs-pv-logo" />}
          <span className="bs-pv-names">
            <span className="bs-pv-name">{name}</span>
            <span className="bs-pv-app">base ground</span>
          </span>
        </span>
        <span className="avatar" aria-hidden="true">AC</span>
      </div>
      <div className="bs-pv-tabs" aria-hidden="true">
        <span className="bs-pv-tab is-on">Today</span><span className="bs-pv-tab">Map</span><span className="bs-pv-tab">Calls</span>
      </div>
      <div className="bs-pv-body">
        <h2 className="bs-pv-h">Tonight’s canvass</h2>
        <p className="bs-pv-p">Forty doors in Newton, two hours. <a href="#preview" onClick={(e) => e.preventDefault()}>See the walk list</a>.</p>
        <div className="card bs-pv-card">
          <span className="eyebrow">Next door</span>
          <p className="bs-pv-addr">14322 72 Ave</p>
          <p className="muted bs-pv-quiet">Last knocked 3 days ago · no answer</p>
          <div className="rb" role="group" aria-label="Rating (preview)">
            <div className="rb-row">
              {[['1', 'support', 'Strong yes'], ['2', 'support', 'Lean yes'], ['3', 'undecided', 'Undecided'], ['4', 'opposed', 'Opposed']].map(([c, band, words]) => (
                <button key={c} type="button" className={`rb-btn rb-btn--${band}${rated === c ? ' is-active' : ''}`} aria-pressed={rated === c} onClick={() => setRated(c)}>
                  <span className="rb-btn__code">{c}</span><span className="rb-btn__sub">{words}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="field">
          <label htmlFor="bs-pv-input">Note</label>
          <input id="bs-pv-input" className="input" defaultValue="Wants a lawn sign" />
        </div>
        <div className="bs-pv-btns">
          <button type="button" className="btn btn-primary">Start walking</button>
          <button type="button" className="btn">Skip</button>
          <span className="chip chip-ok">3 sent</span>
        </div>
        <div className="bs-pv-alert" role="note">
          <strong>No signal.</strong> Knocks save on this phone and send when you’re back online.
        </div>
        <p className="error bs-pv-err">Couldn’t send — try again</p>
      </div>
    </section>
  );
}

function Contrast({ pairs }) {
  const low = pairs.filter((p) => !p.ok).length;
  return (
    <section className="bs-contrast" aria-label="Contrast check">
      <h3 className="bs-h">Contrast check</h3>
      <p className="muted bs-contrast__lead">
        {low ? `${low} ${low === 1 ? 'pair is' : 'pairs are'} under the line.` : 'Every pair reads.'} Body text on field screens needs 7:1 (read outdoors, in sun); everything else 4.5:1.
      </p>
      <ul className="bs-pairs">
        {pairs.map((p) => (
          <li key={p.key} className={`bs-pair${p.ok ? '' : ' is-low'}`}>
            <span className="bs-pair__sample" style={{ color: p.fg, background: p.bg }} aria-hidden="true">Aa</span>
            <span className="bs-pair__label">{p.label}</span>
            <span className="bs-pair__ratio">
              <span className="mono">{ratioText(p.ratio)}</span>
              <span className={p.ok ? 'bs-pair__ok' : 'bs-pair__bad'}>{p.ok ? `✓ ${p.min}:1` : `✕ needs ${p.min}:1`}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
