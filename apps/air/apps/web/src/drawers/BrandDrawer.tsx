import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  brandCss,
  brandFromPreset,
  contrastReport,
  normalizeHex,
  normalizeLogoUrl,
  PALETTE_KEYS,
  PALETTE_LABELS,
  presetById,
  schemesShown,
  type Brand,
  type BrandMode,
  type Corners,
  type FontId,
  type Palette,
  type Preset,
  type Scheme,
} from "@base-air/look";
import { api, errorText, type BrandResponse } from "../api";
import { Drawer } from "../components/Drawer";
import { PanelState } from "../components/PanelState";
import { useToast } from "../components/Toast";
import { applyBrand } from "../lib/brand";
import type { Role } from "../types";

/**
 * The Brand page (SUITE.md, "Look and brand"): a preset to start from, then name, logo, colours, font, corners and
 * mode, with a live preview of the room's own pieces and a contrast check. Owners save; everyone else can look.
 */
export function BrandDrawer({ myRole, workspaceName, onClose }: { myRole: Role | null; workspaceName: string; onClose: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<BrandResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Brand | null>(null);
  const [scheme, setScheme] = useState<Scheme>("dark");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Before the role is known (API-key mode), offer the controls; the server has the last word.
  const canEdit = myRole === null || myRole === "owner";

  const load = () => {
    setError(null);
    api
      .brand()
      .then((r) => {
        setData(r);
        setDraft(r.brand);
        setScheme(r.brand.mode === "light" ? "light" : "dark");
      })
      .catch((e: unknown) => setError(errorText(e)));
  };
  useEffect(load, []);

  const report = useMemo(() => (draft ? contrastReport(draft) : []), [draft]);
  const low = report.filter((p) => !p.ok);
  const dirty = !!draft && !!data && JSON.stringify(draft) !== JSON.stringify(data.brand);
  const preset = draft ? presetById(draft.preset) : null;
  const adjusted = !!draft && !!preset && JSON.stringify(withoutIdentity(draft)) !== JSON.stringify(withoutIdentity(brandFromPreset(preset.id)));

  const update = (fn: (b: Brand) => Brand) => {
    setConfirming(false);
    setSaveError(null);
    setDraft((d) => (d ? fn(d) : d));
  };
  const pickPreset = (p: Preset) => {
    update((d) => brandFromPreset(p.id, { name: d.name, logoUrl: d.logoUrl }));
    setScheme(p.mode === "light" ? "light" : "dark");
  };
  const setColor = (s: Scheme, key: keyof Palette, hex: string) => update((d) => ({ ...d, palettes: { ...d.palettes, [s]: { ...d.palettes[s], [key]: hex } } }));

  async function save(confirmLow: boolean) {
    if (!draft) return;
    if (low.length && !confirmLow) {
      setConfirming(true);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const r = await api.saveBrand({ ...draft, name: draft.name.trim() }, confirmLow);
      setData(r);
      setDraft(r.brand);
      setConfirming(false);
      applyBrand(r.brand);
      toast("Brand saved. Everyone in this workspace sees it now.");
    } catch (e) {
      setSaveError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  const footer =
    draft && canEdit ? (
      confirming ? (
        <div className="brand-confirm" role="alert">
          <p>
            <strong>
              {low.length} colour {low.length === 1 ? "pair is" : "pairs are"} under 4.5:1.
            </strong>{" "}
            Some people won't be able to read {low.length === 1 ? "it" : "them"}. Save anyway?
          </p>
          <div className="brand-foot-row">
            <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save(true)}>
              {saving ? "Saving…" : "Save anyway"}
            </button>
            <button type="button" className="btn" onClick={() => setConfirming(false)}>
              Keep editing
            </button>
          </div>
        </div>
      ) : (
        <div className="brand-foot-row">
          <button type="button" className="btn btn-primary" disabled={saving || !dirty} onClick={() => void save(false)}>
            {saving ? "Saving…" : "Save brand"}
          </button>
          <button type="button" className="btn btn-ghost" disabled={!dirty || saving} onClick={() => data && setDraft(data.brand)}>
            Discard changes
          </button>
          {low.length ? <span className="brand-foot-note">{low.length} low-contrast {low.length === 1 ? "pair" : "pairs"}</span> : null}
          {saveError ? (
            <span className="brand-foot-error" role="alert">
              {saveError}
            </span>
          ) : null}
        </div>
      )
    ) : null;

  return (
    <Drawer title="Brand" subtitle={`How Base Air looks for everyone in ${workspaceName || "this workspace"}`} onClose={onClose} className="brand-drawer" footer={footer}>
      {!draft || !data ? (
        <PanelState loading={!error} error={error} onRetry={load} />
      ) : (
        <div className="brand-layout">
          <div className="brand-form">
            {!canEdit ? <p className="brand-readonly">Only owners change the brand. This is how it's set now.</p> : null}
            <fieldset className="brand-section" disabled={!canEdit}>
              <legend>Preset</legend>
              <div className="brand-presets" role="radiogroup" aria-label="Preset">
                {data.choices.presets.map((p) => (
                  <PresetCard key={p.id} preset={p} selected={draft.preset === p.id} onPick={() => pickPreset(p)} />
                ))}
              </div>
              <div className="brand-preset-row">
                <span className="muted small">
                  {preset ? `Started from ${preset.label}` : "Custom"}
                  {adjusted ? ", adjusted" : ""}
                </span>
                <button type="button" className="btn btn-small" disabled={!adjusted} onClick={() => preset && pickPreset(preset)}>
                  Reset to preset
                </button>
              </div>
            </fieldset>

            <fieldset className="brand-section" disabled={!canEdit}>
              <legend>Name and logo</legend>
              <label className="field">
                <span>Name shown in Base Air</span>
                <input className="input" value={draft.name} maxLength={60} placeholder={workspaceName} onChange={(e) => update((d) => ({ ...d, name: e.target.value }))} />
              </label>
              <LogoField value={draft.logoUrl} name={draft.name || workspaceName} onChange={(logoUrl) => update((d) => ({ ...d, logoUrl }))} />
            </fieldset>

            <fieldset className="brand-section" disabled={!canEdit}>
              <legend>Colours</legend>
              <div className="brand-scheme-row">
                <Segmented
                  label="Colours for"
                  value={scheme}
                  options={[
                    { id: "light", label: "Light" },
                    { id: "dark", label: "Dark" },
                  ]}
                  onChange={(v) => setScheme(v as Scheme)}
                />
                <span className="muted small">{schemeNote(draft.mode, scheme)}</span>
              </div>
              <div className="brand-colors">
                {PALETTE_KEYS.map((key) => (
                  <ColorField key={`${scheme}-${key}`} label={PALETTE_LABELS[key]} value={draft.palettes[scheme][key]} onChange={(hex) => setColor(scheme, key, hex)} />
                ))}
              </div>
            </fieldset>

            <fieldset className="brand-section" disabled={!canEdit}>
              <legend>Type, corners and mode</legend>
              <div className="brand-fonts" role="radiogroup" aria-label="Font">
                {data.choices.fonts.map((f) => (
                  <label key={f.id} className={`brand-font${draft.font === f.id ? " is-on" : ""}`}>
                    <input type="radio" name="brand-font" value={f.id} checked={draft.font === f.id} onChange={() => update((d) => ({ ...d, font: f.id as FontId }))} />
                    <span className="brand-font-sample" style={{ fontFamily: fontStack(f.id) }}>
                      Aa
                    </span>
                    <span className="brand-font-name">{f.label}</span>
                  </label>
                ))}
              </div>
              <Segmented label="Corners" value={draft.corners} options={data.choices.corners} onChange={(v) => update((d) => ({ ...d, corners: v as Corners }))} />
              <Segmented
                label="Mode"
                value={draft.mode}
                options={data.choices.modes}
                onChange={(v) => {
                  update((d) => ({ ...d, mode: v as BrandMode }));
                  if (v !== "device") setScheme(v as Scheme);
                }}
              />
            </fieldset>

            <section className="brand-section" aria-labelledby="brand-contrast-h">
              <h3 id="brand-contrast-h" className="brand-legend">
                Contrast check
              </h3>
              <p className="muted small">
                Text needs at least 4.5:1 against what it sits on. {schemesShown(draft.mode).length === 2 ? "Both schemes are checked, since the room follows the device." : `The ${draft.mode} scheme is checked.`}
              </p>
              <ul className="brand-contrast">
                {report.map((p) => (
                  <li key={p.id} className={p.ok ? "is-ok" : "is-low"}>
                    <span className="brand-contrast-sample" style={{ color: p.fg, background: p.bg }} aria-hidden="true">
                      Aa
                    </span>
                    <span className="brand-contrast-label">
                      {p.label}
                      {schemesShown(draft.mode).length === 2 ? <span className="muted"> · {p.scheme}</span> : null}
                    </span>
                    <span className="brand-contrast-ratio mono">{p.ratio.toFixed(2)}:1</span>
                    <span className={`brand-contrast-flag ${p.ok ? "ok" : "low"}`}>{p.ok ? "Passes" : "Too low"}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
          <BrandPreview brand={draft} scheme={schemesShown(draft.mode).includes(scheme) ? scheme : schemesShown(draft.mode)[0]!} fallbackName={workspaceName} onScheme={setScheme} />
        </div>
      )}
    </Drawer>
  );
}

const withoutIdentity = (b: Brand) => ({ ...b, name: "", logoUrl: "" });

function schemeNote(mode: BrandMode, scheme: Scheme): string {
  if (mode === "device") return `Shown when the device is set to ${scheme}.`;
  if (mode === scheme) return "This is what everyone sees.";
  return `Only shown to someone who switches to ${scheme} themselves.`;
}

function fontStack(id: string): string {
  return (
    {
      "plex-sans": '"IBM Plex Sans", system-ui, sans-serif',
      inter: '"Inter", system-ui, sans-serif',
      "space-grotesk": '"Space Grotesk", system-ui, sans-serif',
      "source-serif": '"Source Serif 4", Georgia, serif',
      system: "system-ui, sans-serif",
    } as Record<string, string>
  )[id] ?? "inherit";
}

function PresetCard({ preset, selected, onPick }: { preset: Preset; selected: boolean; onPick: () => void }) {
  const shown = preset.mode === "light" ? preset.palettes.light : preset.palettes.dark;
  return (
    <label className={`brand-preset${selected ? " is-on" : ""}`}>
      <input type="radio" name="brand-preset" value={preset.id} checked={selected} onChange={onPick} />
      <span className="brand-preset-swatch" style={{ background: shown.surface, borderRadius: preset.corners === "round" ? 12 : preset.corners === "sharp" ? 2 : 7 }} aria-hidden="true">
        <span style={{ background: shown.primary }} />
        <span style={{ background: shown.accent }} />
        <span className="brand-preset-ink" style={{ color: shown.ink, fontFamily: fontStack(preset.font) }}>
          Aa
        </span>
      </span>
      <span className="brand-preset-name">{preset.label}</span>
      <span className="brand-preset-desc">{preset.description}</span>
    </label>
  );
}

function Segmented({ label, value, options, onChange }: { label: string; value: string; options: { id: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <div className="brand-seg-wrap">
      <span className="brand-seg-label" id={`seg-${label}`}>
        {label}
      </span>
      <div className="seg brand-seg" role="radiogroup" aria-labelledby={`seg-${label}`}>
        {options.map((o) => (
          <label key={o.id} className={`seg-btn${value === o.id ? " is-on" : ""}`}>
            <input type="radio" name={`seg-${label}`} value={o.id} checked={value === o.id} onChange={() => onChange(o.id)} />
            {o.label}
          </label>
        ))}
      </div>
    </div>
  );
}

/** A colour picker and a hex field that stay in step; the hex field takes #abc, #aabbcc or without the #. */
function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (hex: string) => void }) {
  const [text, setText] = useState(value);
  const [bad, setBad] = useState(false);
  useEffect(() => {
    setText(value);
    setBad(false);
  }, [value]);
  const id = `color-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <div className="brand-color">
      <label htmlFor={id} className="brand-color-label">
        {label}
      </label>
      <input type="color" className="brand-color-picker" value={value} aria-label={`${label}: pick a colour`} onChange={(e) => onChange(e.target.value)} />
      <input
        id={id}
        className="input brand-color-hex mono"
        value={text}
        spellCheck={false}
        autoComplete="off"
        maxLength={7}
        aria-invalid={bad}
        aria-describedby={bad ? `${id}-err` : undefined}
        onChange={(e) => {
          setText(e.target.value);
          const hex = normalizeHex(e.target.value);
          setBad(!hex && e.target.value.trim().length >= 4);
          if (hex && e.target.value.replace("#", "").length === 6) onChange(hex);
        }}
        onBlur={() => {
          const hex = normalizeHex(text);
          if (hex) onChange(hex);
          else {
            setBad(true);
          }
        }}
      />
      {bad ? (
        <span id={`${id}-err`} className="brand-color-err">
          Use a hex colour like #38bdf8
        </span>
      ) : null}
    </div>
  );
}

function LogoField({ value, name, onChange }: { value: string; name: string; onChange: (url: string) => void }) {
  const [url, setUrl] = useState(value);
  const [bad, setBad] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement | null>(null);
  useEffect(() => setUrl(value), [value]);

  const upload = async (f: File) => {
    if (!f.type.startsWith("image/")) {
      setUploadError("Choose an image (PNG, JPG, GIF or WebP).");
      return;
    }
    setUploadError(null);
    setProgress(0);
    try {
      const asset = await api.uploadMedia(f, setProgress, `${name} logo`).done;
      onChange(asset.url);
    } catch (e) {
      setUploadError(errorText(e));
    } finally {
      setProgress(null);
      if (file.current) file.current.value = "";
    }
  };

  return (
    <div className="brand-logo">
      <div className="brand-logo-preview" aria-hidden="true">
        {value ? <img src={value} alt="" /> : <span className="base-wordmark">Base</span>}
      </div>
      <div className="brand-logo-fields">
        <label className="field">
          <span>Logo address</span>
          <input
            className="input"
            type="url"
            inputMode="url"
            placeholder="https://… or upload an image"
            value={url}
            aria-invalid={bad}
            onChange={(e) => {
              setUrl(e.target.value);
              setBad(false);
            }}
            onBlur={() => {
              const v = normalizeLogoUrl(url);
              if (v === null) setBad(true);
              else onChange(v);
            }}
          />
        </label>
        {bad ? <span className="brand-color-err">The logo is an https address or an uploaded image.</span> : null}
        <div className="brand-logo-actions">
          <input ref={file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="sr-only" id="brand-logo-file" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
          <label htmlFor="brand-logo-file" className="btn btn-small" role="button" tabIndex={0} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && file.current?.click()}>
            {progress !== null ? `Uploading ${Math.round(progress * 100)}%` : "Upload image"}
          </label>
          {value ? (
            <button type="button" className="btn btn-small btn-ghost" onClick={() => onChange("")}>
              Remove logo
            </button>
          ) : (
            <span className="muted small">Empty: Base Air's own mark.</span>
          )}
        </div>
        {uploadError ? (
          <span className="brand-color-err" role="alert">
            {uploadError}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** The room's own pieces in the draft brand: a top bar, a heading, a card with figures, a form field, an alert. */
function BrandPreview({ brand, scheme, fallbackName, onScheme }: { brand: Brand; scheme: Scheme; fallbackName: string; onScheme: (s: Scheme) => void }) {
  const css = useMemo(() => brandCss(brand, ".brand-preview"), [brand]);
  const name = brand.name || fallbackName || "Your workspace";
  return (
    <aside className="brand-preview-col" aria-label="Live preview">
      <div className="brand-preview-head">
        <span className="brand-legend">Live preview</span>
        {schemesShown(brand.mode).length === 2 ? (
          <div className="seg brand-seg" role="group" aria-label="Preview scheme">
            {(["light", "dark"] as const).map((s) => (
              <button key={s} type="button" className="seg-btn" aria-pressed={scheme === s} onClick={() => onScheme(s)}>
                {s === "light" ? "Light" : "Dark"}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <style>{css}</style>
      <div className="brand-preview" data-theme={scheme}>
        <div className="bp-topbar">
          <span className="base-switcher-btn bp-switch" aria-hidden="true">
            <span className="base-wordmark">Base</span>
            <span className="base-switcher-app">Air</span>
          </span>
          {brand.logoUrl ? <img className="brand-logo-img" src={brand.logoUrl} alt="" /> : null}
          <span className="bp-name">{name}</span>
          <span className="bp-spacer" />
          <PreviewNum value="7" label="waiting" />
          <PreviewNum value="+38%" label="lift" />
        </div>
        <div className="bp-body">
          <h4 className="bp-h">Rising: transit levy vote</h4>
          <p className="bp-p">
            Mentions are up three hours running. <a href="#preview" onClick={(e) => e.preventDefault()}>See the evidence</a>.
          </p>
          <div className="bp-card">
            <div className="bp-card-row">
              <span className="pill">Queue</span>
              <span className="bp-faint">2 drafts · due 4:30 pm</span>
            </div>
            <p className="bp-card-text">Council votes on the levy tonight. Here's what it means for your commute.</p>
            <div className="bp-card-row">
              <span className="bp-fig mono">1,284</span>
              <span className="bp-faint">reach forecast, ±18%</span>
            </div>
          </div>
          <label className="field bp-field">
            <span>Reply</span>
            <input className="input" defaultValue="Thanks for asking!" readOnly tabIndex={-1} />
          </label>
          <div className="bp-actions">
            <button type="button" className="btn btn-primary" tabIndex={-1}>
              Approve
            </button>
            <button type="button" className="btn" tabIndex={-1}>
              Edit
            </button>
            <span className="bp-accent">New</span>
          </div>
          <div className="bp-alert" role="presentation">
            <strong>Red line close:</strong> this draft names an opponent.
          </div>
        </div>
      </div>
    </aside>
  );
}

function PreviewNum({ value, label }: { value: ReactNode; label: string }) {
  return (
    <span className="bp-num">
      <span className="mono">{value}</span>
      <span className="bp-num-label">{label}</span>
    </span>
  );
}
