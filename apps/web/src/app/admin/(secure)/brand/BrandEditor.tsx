"use client";

import { useActionState, useId, useMemo, useState } from "react";
import { Notice } from "@/components/admin/Notice";
import { SubmitButton } from "@/components/admin/SubmitButton";
import { ImageControl } from "@/components/admin/content/ImageField";
import { AmountPicker, type Choice } from "@/components/forms/AmountPicker";
import {
  brandFromPreset,
  brandName,
  brandTokens,
  COLOR_FIELDS,
  contrastPairs,
  CORNER_IDS,
  CORNERS,
  FONT_IDS,
  FONTS,
  PRESET_IDS,
  PRESETS,
  type Brand,
  type ColorId,
  type PresetId,
} from "@/lib/brand";
import { saveBrandAction } from "./actions";
import "./brand.css";

const HEX = /^#?[0-9a-fA-F]{6}$/;

export function BrandEditor({ initial, orgName, limitCents }: { initial: Brand; orgName: string; limitCents: number }) {
  const [brand, setBrand] = useState<Brand>(initial);
  const [state, action] = useActionState(saveBrandAction, null);
  const pairs = useMemo(() => contrastPairs(brand), [brand]);
  const low = pairs.filter((p) => !p.ok);
  const tokens = useMemo(() => brandTokens(brand) as React.CSSProperties, [brand]);
  const preset = PRESETS[brand.preset];
  const differsFromPreset =
    brand.font !== preset.font || brand.corners !== preset.corners || COLOR_FIELDS.some((c) => brand.colors[c.id].toLowerCase() !== preset.colors[c.id].toLowerCase());

  const choosePreset = (id: PresetId) => setBrand((b) => ({ ...brandFromPreset(id, { name: b.name, logoUrl: b.logoUrl, logoOnDarkUrl: b.logoOnDarkUrl }) }));
  const setColor = (id: ColorId, value: string) => setBrand((b) => ({ ...b, colors: { ...b.colors, [id]: value } }));

  return (
    <form action={action} className="brand-editor">
      <input type="hidden" name="brand" value={JSON.stringify(brand)} />
      <div className="brand-controls stack">
        <fieldset className="brand-fieldset">
          <legend>Preset</legend>
          <p className="small">A starting look. Picking one fills in the colours, font and corners below; the name and logo stay.</p>
          <div className="brand-presets">
            {PRESET_IDS.map((id) => {
              const p = PRESETS[id];
              return (
                <label key={id} className="brand-preset">
                  <input type="radio" name="preset-choice" value={id} checked={brand.preset === id} onChange={() => choosePreset(id)} />
                  <span className="brand-preset__swatches" aria-hidden="true">
                    {(["primary", "accent", "highlight", "surface"] as const).map((c) => (
                      <span key={c} style={{ background: p.colors[c] }} />
                    ))}
                  </span>
                  <span className="brand-preset__name" style={{ fontFamily: `var(${FONTS[p.font].cssVar})` }}>
                    {p.label}
                  </span>
                  <span className="brand-preset__desc">{p.description}</span>
                </label>
              );
            })}
          </div>
          <button type="button" className="btn btn--outline" onClick={() => choosePreset(brand.preset)} disabled={!differsFromPreset}>
            Reset to preset ({preset.label})
          </button>
        </fieldset>

        <fieldset className="brand-fieldset">
          <legend>Name and logo</legend>
          <div className="field">
            <label htmlFor="brand-name">Name</label>
            <input
              id="brand-name"
              className="input"
              maxLength={80}
              value={brand.name}
              placeholder={orgName}
              onChange={(e) => setBrand((b) => ({ ...b, name: e.target.value }))}
              aria-describedby="brand-name-help"
            />
            <p id="brand-name-help" className="small">
              Shown when there is no logo, and as the logo&apos;s description. Blank uses the organization&apos;s name ({orgName}).
            </p>
          </div>
          <ImageControl idPrefix="brand-logo" label="Logo" showAlt={false} altRequired={false} value={{ url: brand.logoUrl, alt: "" }} onChange={(v) => setBrand((b) => ({ ...b, logoUrl: v.url }))} />
          <ImageControl
            idPrefix="brand-logo-dark"
            label="Logo on dark backgrounds (the footer)"
            showAlt={false}
            altRequired={false}
            value={{ url: brand.logoOnDarkUrl, alt: "" }}
            onChange={(v) => setBrand((b) => ({ ...b, logoOnDarkUrl: v.url }))}
          />
          <p className="small">With no logo, the name is shown as a wordmark.</p>
        </fieldset>

        <fieldset className="brand-fieldset">
          <legend>Colours</legend>
          <div className="brand-colors">
            {COLOR_FIELDS.map((c) => (
              <ColorField key={c.id} id={c.id} label={c.label} help={c.help} value={brand.colors[c.id]} onChange={(v) => setColor(c.id, v)} />
            ))}
          </div>
        </fieldset>

        <fieldset className="brand-fieldset">
          <legend>Font</legend>
          <p className="small">Bundled with the site: no requests to font services.</p>
          <div className="brand-choices">
            {FONT_IDS.map((id) => (
              <label key={id} className="brand-choice">
                <input type="radio" name="font-choice" value={id} checked={brand.font === id} onChange={() => setBrand((b) => ({ ...b, font: id }))} />
                <span style={{ fontFamily: `var(${FONTS[id].cssVar})`, fontWeight: 700, fontSize: 18 }}>{FONTS[id].label}</span>
                <span className="small">{FONTS[id].note}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="brand-fieldset">
          <legend>Corners</legend>
          <div className="brand-choices brand-choices--row">
            {CORNER_IDS.map((id) => (
              <label key={id} className="brand-choice">
                <input type="radio" name="corner-choice" value={id} checked={brand.corners === id} onChange={() => setBrand((b) => ({ ...b, corners: id }))} />
                <span className="brand-corner-sample" aria-hidden="true" style={{ borderRadius: CORNERS[id].radius }} />
                <span>{CORNERS[id].label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <div className="brand-side stack">
        <section aria-labelledby="contrast-title" className="brand-contrast">
          <h2 id="contrast-title" className="h3">
            Contrast check
          </h2>
          <p role="status" className={low.length ? "brand-contrast__summary is-bad" : "brand-contrast__summary"}>
            {low.length === 0 ? "Every pair reaches 4.5:1." : `${low.length === 1 ? "1 pair is" : `${low.length} pairs are`} under 4.5:1, so some text will be hard to read.`}
          </p>
          <table className="brand-contrast__table">
            <caption className="visually-hidden">Text and background pairs with their contrast ratios</caption>
            <thead>
              <tr>
                <th scope="col">Where</th>
                <th scope="col">Sample</th>
                <th scope="col">Ratio</th>
              </tr>
            </thead>
            <tbody>
              {pairs.map((p) => (
                <tr key={p.id} className={p.ok ? undefined : "is-bad"}>
                  <th scope="row">{p.label}</th>
                  <td>
                    <span className="brand-contrast__sample" style={{ color: p.text, background: p.background }}>
                      Aa
                    </span>
                  </td>
                  <td>
                    {p.ratio.toFixed(2)}:1 {p.ok ? <span className="visually-hidden">passes</span> : <strong className="brand-flag">Under 4.5:1</strong>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section aria-labelledby="preview-title">
          <h2 id="preview-title" className="h3">
            Preview
          </h2>
          <p className="small">The public site&apos;s key pieces in this look. Nothing changes on the site until you save.</p>
          <BrandPreview brand={brand} tokens={tokens} orgName={orgName} limitCents={limitCents} />
        </section>

        <div className="brand-save stack">
          <Notice state={state} />
          {low.length > 0 && (
            <label className="check brand-confirm">
              <input type="checkbox" name="confirmLowContrast" required />
              <span>Save anyway, with {low.length === 1 ? "1 pair" : `${low.length} pairs`} under 4.5:1</span>
            </label>
          )}
          <SubmitButton className="btn btn--primary btn--lg" pendingText="Saving…" confirm={low.length ? "Some text in this look is under 4.5:1 against its background. Save it anyway?" : undefined}>
            Save brand
          </SubmitButton>
        </div>
      </div>
    </form>
  );
}

function ColorField({ id, label, help, value, onChange }: { id: string; label: string; help: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  const [shown, setShown] = useState(value);
  const errorId = useId();
  // Follow outside changes (a preset, Reset) without losing a half-typed value.
  if (value !== shown) {
    setShown(value);
    setText(value);
  }
  const invalid = !HEX.test(text.trim());
  const commit = (v: string) => {
    const t = v.trim();
    if (HEX.test(t)) {
      const next = `#${t.replace(/^#/, "").toLowerCase()}`;
      setShown(next);
      onChange(next);
    }
  };
  return (
    <div className="brand-color">
      <label htmlFor={`color-${id}`} className="brand-color__label">
        {label}
      </label>
      <div className="brand-color__inputs">
        <input type="color" aria-label={`${label}: colour picker`} value={value} onChange={(e) => commit(e.target.value)} className="brand-color__picker" />
        <input
          id={`color-${id}`}
          className="input brand-color__hex"
          value={text}
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={invalid}
          aria-describedby={`${errorId}-help${invalid ? ` ${errorId}` : ""}`}
          onChange={(e) => {
            setText(e.target.value);
            commit(e.target.value);
          }}
          onBlur={() => setText(value)}
        />
      </div>
      <p id={`${errorId}-help`} className="small brand-color__help">
        {help}
      </p>
      {invalid && (
        <p id={errorId} className="field-error" role="alert">
          Use six hex digits, like #003979.
        </p>
      )}
    </div>
  );
}

/** The public site's pieces with the brand's tokens set on a wrapper, so the real stylesheets draw them. */
function BrandPreview({ brand, tokens, orgName, limitCents }: { brand: Brand; tokens: React.CSSProperties; orgName: string; limitCents: number }) {
  const [choice, setChoice] = useState<Choice>({ frequency: "one_time", tier: "standard", amountCents: 5000 });
  const name = brandName(brand, orgName);
  return (
    <div className="brand-preview" style={tokens}>
      <div className="brand-preview__bar">
        {brand.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- any uploaded image
          <img src={brand.logoUrl} alt={name} className="brand-preview__logo" />
        ) : (
          <span className="logo--text">{name}</span>
        )}
        <span className="btn btn--accent">Donate</span>
      </div>
      <div className="section section--primary hero brand-preview__hero">
        <p className="hero-title" style={{ minHeight: 0 }}>
          Fighting for <span className="hero-word">safer streets</span>
        </p>
        <p className="hero-text">Residents organizing for a City Hall that gets the basics right.</p>
        <div className="btn-row">
          <span className="btn btn--highlight">Become a member</span>
          <span className="btn btn--ghost">Chip in</span>
        </div>
      </div>
      <div className="section section--surface brand-preview__body">
        <div className="card-grid brand-preview__grid">
          <article className="card">
            <p className="eyebrow">November 7, 2026</p>
            <h3 className="h3">A card heading</h3>
            <p>Body text in a card, with a link that follows the brand.</p>
            <a href="#preview-title" className="text-link" onClick={(e) => e.preventDefault()}>
              Read more
            </a>
          </article>
          <div className="form-card">
            <div className="field">
              <label htmlFor="preview-email">Email</label>
              <input id="preview-email" className="input" placeholder="you@example.ca" />
            </div>
            <label className="check">
              <input type="checkbox" />
              <span>Send me email updates</span>
            </label>
            <span className="btn btn--primary">Sign up</span>
          </div>
        </div>
        <div className="stack" style={{ gap: 10, marginTop: 20 }}>
          <div className="alert" role="presentation">
            <span aria-hidden="true" className="alert-icon">
              !
            </span>
            <span>An error alert: something needs fixing.</span>
          </div>
          <div className="alert alert--note" role="presentation">
            <span aria-hidden="true" className="alert-icon">
              ✓
            </span>
            <span>A note: something went well.</span>
          </div>
        </div>
      </div>
      <div className="section brand-preview__body">
        <p className="eyebrow">Chip in</p>
        <AmountPicker choice={choice} onChange={setChoice} limitCents={limitCents} idPrefix="brand-preview-amount" monthlyNote="" clubNote="" />
      </div>
      <div className="section section--highlight brand-preview__band">
        <p className="display" style={{ margin: 0, fontSize: 26 }}>
          When we organize, we win
        </p>
      </div>
    </div>
  );
}
