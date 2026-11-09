// A section's form, made from its fields in the catalogue
// (shared/site/catalogue.js) — adding a module kind there adds its form here
// with nothing else to write. One component per field type:
//   text · textarea · markdown (a small toolbar, Preview, pictures) · url ·
//   link ({ label, href }) · image (upload or pick, a description for people
//   who can't see it) · select · toggle · number · words (chips) · list
//   (repeatable groups: open, move, remove) · campaign (a petition or
//   pledge) · page (one of the site's pages)
// Every box has its own label; a problem shows under its box (errors, keyed
// by the catalogue's path: 'items[2].title') and the box says it's invalid.
// ImageField is also the share picture's and the logo's (pages, settings,
// theme, posts).
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MODULE_BY_KIND } from '@starbase/shared/site/catalogue';
import { MarkdownField, uploadImage } from '../MarkdownField.jsx';
import { at } from '../../base.js';
import { Dialog } from './Bits.jsx';
import { useSitePictures } from './useSite.js';
import { isSiteLink, tidyLink } from './builder.js';

export const uploadSitePicture = (file) => uploadImage(file, 'site.picture');
const domId = (s) => String(s).replace(/[^A-Za-z0-9_-]+/g, '-');
const LINK_HINT = 'A page of the site (/donate, /#m-join) or a full address (https://…)';

function Problem({ id, text }) {
  if (!text) return null;
  return <p className="wb-field__err" id={id}>{text}</p>;
}
const describe = (...ids) => ids.filter(Boolean).join(' ') || undefined;

// ── One line, a paragraph ──
export function TextField({ id, label, value, onChange, max, error, hint, multiline = false, rows = 3, placeholder, required }) {
  const errId = error ? `${id}-err` : null;
  const hintId = hint ? `${id}-hint` : null;
  const v = value ?? '';
  const near = max && v.length > max * 0.8;
  const Tag = multiline ? 'textarea' : 'input';
  return (
    <div className="field wb-field">
      <label htmlFor={id}>{label}{required && <span className="wb-req"> (needed to publish)</span>}</label>
      <Tag id={id} className="input" value={v} maxLength={max || undefined} rows={multiline ? rows : undefined}
        type={multiline ? undefined : 'text'} placeholder={placeholder} aria-invalid={error ? 'true' : undefined}
        aria-describedby={describe(hintId, errId)} onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="wb-field__hint" id={hintId}>{hint}</p>}
      {near && <p className="wb-field__count" aria-live="polite">{v.length} of {max}</p>}
      <Problem id={errId} text={error} />
    </div>
  );
}

// ── A link: the site's own page or a full address ──
export function UrlField({ id, label, value, onChange, error, required, pages = [] }) {
  const [touched, setTouched] = useState(false);
  const v = value ?? '';
  const own = touched && !isSiteLink(v) ? LINK_HINT : null;
  const shown = error || own;
  const errId = shown ? `${id}-err` : null;
  const listId = pages.length ? `${id}-pages` : undefined;
  return (
    <div className="field wb-field">
      <label htmlFor={id}>{label}{required && <span className="wb-req"> (needed to publish)</span>}</label>
      <input id={id} className="input" type="text" inputMode="url" autoComplete="off" spellCheck={false} maxLength={500}
        value={v} list={listId} placeholder="/page or https://…" aria-invalid={shown ? 'true' : undefined} aria-describedby={describe(errId)}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => { setTouched(true); const t = tidyLink(v); if (t !== v) onChange(t); }} />
      {listId && (
        <datalist id={listId}>
          {pages.map((p) => <option key={p.slug} value={p.slug === 'home' ? '/' : `/${p.slug}`}>{p.title}</option>)}
        </datalist>
      )}
      <Problem id={errId} text={shown} />
    </div>
  );
}

// ── A button: its words and where it goes ──
function LinkField({ id, label, value, onChange, errors, path, pages }) {
  const v = value && typeof value === 'object' ? value : { label: '', href: '' };
  return (
    <fieldset className="wb-group">
      <legend>{label}</legend>
      <div className="form-row">
        <TextField id={`${id}-label`} label="Words on it" max={60} value={v.label} error={errors?.[`${path}.label`]}
          onChange={(label2) => onChange({ ...v, label: label2 })} />
        <UrlField id={`${id}-href`} label="Goes to" value={v.href} error={errors?.[`${path}.href`] || errors?.[path]} pages={pages}
          onChange={(href) => onChange({ ...v, href })} />
      </div>
    </fieldset>
  );
}

// ── A picture: upload or pick one, and say what it shows ──
export function ImageField({ id, label, value, onChange, error, altError, required, hint }) {
  const v = value && typeof value === 'object' ? value : { url: '', alt: '' };
  const file = useRef(null);
  const [busy, setBusy] = useState(false);
  const [upErr, setUpErr] = useState(null);
  const [picking, setPicking] = useState(false);
  const pick = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setBusy(true);
    setUpErr(null);
    try {
      const media = await uploadSitePicture(f);
      onChange({ url: media.url || `/media/${media.id}`, alt: v.alt || '' });
    } catch (err) {
      setUpErr(err.message);
    } finally {
      setBusy(false);
    }
  };
  const errText = error || upErr;
  const errId = errText ? `${id}-err` : null;
  const noAlt = v.url && !String(v.alt || '').trim();
  return (
    <fieldset className="wb-group wb-image" aria-describedby={describe(errId)}>
      <legend>{label}{required && <span className="wb-req"> (needed to publish)</span>}</legend>
      {hint && <p className="wb-field__hint">{hint}</p>}
      <div className="wb-image__row">
        <div className="wb-image__thumb" data-empty={v.url ? undefined : ''}>
          {v.url ? <img src={at(v.url)} alt={v.alt ? `Chosen: ${v.alt}` : 'The chosen picture'} loading="lazy" /> : <span aria-hidden="true">No picture</span>}
        </div>
        <div className="wb-image__tools">
          <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={pick} />
          <button type="button" className="btn wb-tap" disabled={busy} onClick={() => file.current?.click()}>
            {busy ? 'Uploading…' : v.url ? 'Upload another' : 'Upload a picture'}
          </button>
          <button type="button" className="btn btn-quiet wb-tap" onClick={() => setPicking(true)}>Choose one uploaded</button>
          {v.url && <button type="button" className="btn btn-quiet wb-tap" onClick={() => onChange({ url: '', alt: '' })}>Remove</button>}
        </div>
      </div>
      <Problem id={errId} text={errText} />
      {v.url && (
        <TextField id={`${id}-alt`} label="What the picture shows (for people who can’t see it)" max={300} value={v.alt}
          error={altError} hint={noAlt ? 'Say it in a few words, like “Volunteers knocking on doors on a sunny afternoon”.' : null}
          onChange={(alt) => onChange({ ...v, alt })} />
      )}
      {picking && <PicturePicker onClose={() => setPicking(false)} onPick={(p) => { setPicking(false); onChange({ url: p.url, alt: v.alt || '' }); }} />}
    </fieldset>
  );
}

function PicturePicker({ onClose, onPick }) {
  const q = useSitePictures(true);
  const pics = q.data?.pictures || [];
  return (
    <Dialog open title="Choose a picture" onClose={onClose} wide>
      {q.isPending && <p className="muted">Loading…</p>}
      {q.isError && <p className="error" role="alert">{q.error.message}</p>}
      {q.isSuccess && pics.length === 0 && <p className="ops-empty">Nothing uploaded yet. Use “Upload a picture”.</p>}
      {pics.length > 0 && (
        <ul className="wb-pics">
          {pics.map((p) => (
            <li key={p.id}>
              <button type="button" className="wb-pics__btn" onClick={() => onPick(p)}>
                <img src={at(p.url)} alt="" loading="lazy" />
                <span>{p.name || 'Picture'}{p.width ? ` · ${p.width}×${p.height}` : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

// ── Choices ──
function SelectField({ id, label, value, options, onChange, error }) {
  const errId = error ? `${id}-err` : null;
  return (
    <div className="field wb-field">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="input" value={value ?? ''} aria-invalid={error ? 'true' : undefined} aria-describedby={describe(errId)}
        onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <Problem id={errId} text={error} />
    </div>
  );
}

export function ToggleField({ id, label, value, onChange, hint }) {
  const hintId = hint ? `${id}-hint` : null;
  return (
    <div className="wb-toggle">
      <input id={id} type="checkbox" className="wb-toggle__box" checked={Boolean(value)} aria-describedby={describe(hintId)}
        onChange={(e) => onChange(e.target.checked)} />
      <label htmlFor={id}>{label}</label>
      {hint && <p className="wb-field__hint" id={hintId}>{hint}</p>}
    </div>
  );
}

function NumberField({ id, label, value, min, max, onChange, error }) {
  const errId = error ? `${id}-err` : null;
  return (
    <div className="field wb-field wb-field--narrow">
      <label htmlFor={id}>{label}</label>
      <input id={id} className="input" type="number" inputMode="numeric" min={min} max={max} step={1}
        value={value ?? ''} aria-invalid={error ? 'true' : undefined} aria-describedby={describe(errId)}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
      <Problem id={errId} text={error} />
    </div>
  );
}

// ── Words, as chips: type one and press Enter (or Add) ──
function WordsField({ id, label, value, onChange, max, itemMax, error }) {
  const words = Array.isArray(value) ? value : [];
  const [typing, setTyping] = useState('');
  const full = max && words.length >= max;
  const add = () => {
    const parts = typing.split(',').map((w) => w.trim().slice(0, itemMax || 80)).filter(Boolean);
    if (!parts.length) return;
    const next = [...words];
    for (const w of parts) if (!next.includes(w) && (!max || next.length < max)) next.push(w);
    onChange(next);
    setTyping('');
  };
  const errId = error ? `${id}-err` : null;
  return (
    <fieldset className="wb-group wb-words" aria-describedby={describe(errId)}>
      <legend>{label}</legend>
      {words.length > 0 && (
        <ul className="wb-chips">
          {words.map((w, i) => (
            <li key={`${w}-${i}`} className="wb-chip">
              <span>{w}</span>
              <button type="button" className="wb-chip__x" aria-label={`Remove “${w}”`} onClick={() => onChange(words.filter((_, j) => j !== i))}>✕</button>
            </li>
          ))}
        </ul>
      )}
      <div className="wb-words__add">
        <label htmlFor={id} className="ws-sr">Add to {label}</label>
        <input id={id} className="input" type="text" value={typing} maxLength={(itemMax || 80) * 3} disabled={full}
          placeholder={full ? `That’s the most (${max})` : 'Type, then Enter'}
          onChange={(e) => setTyping(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <button type="button" className="btn wb-tap" disabled={full || !typing.trim()} onClick={add}>Add</button>
      </div>
      <Problem id={errId} text={error} />
    </fieldset>
  );
}

// ── A list of groups (points, questions, people…) ──
const ONE = {
  Points: 'point', Questions: 'question', People: 'person', Groups: 'group', Accounts: 'account', Promises: 'promise',
  'Other buttons': 'button', 'Why join': 'reason', 'Menu': 'link', 'Links': 'link', 'Title bar links': 'link',
};
const itemSummary = (f, item, i) => {
  for (const sub of f.of) {
    const v = item?.[sub.key];
    if (typeof v === 'string' && v.trim() && ['text', 'textarea'].includes(sub.type)) return v.trim().slice(0, 60);
  }
  return `${(ONE[f.label] || 'item').replace(/^./, (c) => c.toUpperCase())} ${i + 1}`;
};
const blankOf = (f) => Object.fromEntries(f.of.map((s) => [s.key, s.type === 'image' ? { url: '', alt: '' } : s.type === 'select' ? (s.options?.[0]?.value ?? '') : s.type === 'toggle' ? false : '']));

export function ListField({ id, f, value, onChange, errors, path, ctx }) {
  const items = Array.isArray(value) ? value : [];
  const [open, setOpen] = useState(() => new Set());
  const one = ONE[f.label] || 'item';
  const full = f.max && items.length >= f.max;
  // An item with a problem opens by itself.
  const badKey = Object.keys(errors || {}).filter((k) => k.startsWith(`${path}[`)).sort().join('|');
  useEffect(() => {
    if (!badKey) return;
    const bad = badKey.split('|').map((k) => Number(k.slice(path.length + 1).split(']')[0])).filter(Number.isInteger);
    setOpen((s) => (bad.every((i) => s.has(i)) ? s : new Set([...s, ...bad])));
  }, [badKey, path]);
  const toggle = (i) => setOpen((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
    setOpen((s) => { const n = new Set(); for (const k of s) n.add(k === i ? j : k === j ? i : k); return n; });
    ctx?.announce?.(`Moved to ${j + 1} of ${items.length}`);
  };
  const remove = (i) => {
    const gone = items[i];
    onChange(items.filter((_, k) => k !== i));
    setOpen(new Set());
    // Undo, later: back at its place in the list as it is then (a function
    // of the current list, so nothing typed since is lost).
    ctx?.toast?.(`Removed ${itemSummary(f, gone, i)}`, () => onChange((cur) => {
      const list = Array.isArray(cur) ? cur : [];
      return [...list.slice(0, i), gone, ...list.slice(i)];
    }));
  };
  const add = () => {
    onChange([...items, blankOf(f)]);
    setOpen((s) => new Set([...s, items.length]));
  };
  return (
    <fieldset className="wb-group wb-list">
      <legend>{f.label} <span className="wb-list__n">· {items.length}{f.max ? ` of ${f.max}` : ''}</span></legend>
      {items.length > 0 && (
        <ol className="wb-list__items">
          {items.map((item, i) => {
            const bodyId = `${id}-${i}-body`;
            const isOpen = open.has(i);
            const bad = Object.keys(errors || {}).some((k) => k.startsWith(`${path}[${i}]`));
            return (
              <li key={i} className="wb-list__item" data-open={isOpen ? '' : undefined} data-bad={bad ? '' : undefined}>
                <div className="wb-list__head">
                  <button type="button" className="wb-list__toggle" aria-expanded={isOpen} aria-controls={bodyId} onClick={() => toggle(i)}>
                    <span className="wb-list__num" aria-hidden="true">{i + 1}</span>
                    <span className="wb-list__sum">{itemSummary(f, item, i)}</span>
                    {bad && <span className="chip chip-danger">Needs a look</span>}
                  </button>
                  <button type="button" className="btn btn-quiet wb-icon" aria-label={`Move ${itemSummary(f, item, i)} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                  <button type="button" className="btn btn-quiet wb-icon" aria-label={`Move ${itemSummary(f, item, i)} down`} disabled={i === items.length - 1} onClick={() => move(i, 1)}>↓</button>
                  <button type="button" className="btn btn-quiet wb-icon wb-icon--danger" aria-label={`Remove ${itemSummary(f, item, i)}`} onClick={() => remove(i)}>✕</button>
                </div>
                {isOpen && (
                  <div className="wb-list__body" id={bodyId}>
                    {f.of.map((sub) => (
                      <Field key={sub.key} f={sub} id={`${id}-${i}-${sub.key}`} path={`${path}[${i}].${sub.key}`}
                        value={item?.[sub.key]} errors={errors} ctx={ctx}
                        onChange={(v) => onChange(items.map((x, k) => (k === i ? { ...x, [sub.key]: typeof v === 'function' ? v(x?.[sub.key]) : v } : x)))} />
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <button type="button" className="btn wb-tap wb-list__add" disabled={full} onClick={add}>
        {full ? `That’s the most (${f.max})` : `Add ${/^[aeiou]/i.test(one) ? 'an' : 'a'} ${one}`}
      </button>
    </fieldset>
  );
}

// ── A petition or pledge ──
// campaigns: null while they load (nothing is said to be gone till then).
function CampaignField({ id, label, value, kinds, onChange, error, required, campaigns = null }) {
  const errId = error ? `${id}-err` : null;
  const list = (campaigns || []).filter((c) => !kinds || kinds.includes(c.kind));
  const missing = value && !(campaigns || []).some((c) => c.id === value);
  return (
    <div className="field wb-field">
      <label htmlFor={id}>{label}{required && <span className="wb-req"> (needed to publish)</span>}</label>
      <select id={id} className="input" value={value || ''} aria-invalid={error ? 'true' : undefined} aria-describedby={describe(errId)}
        onChange={(e) => onChange(e.target.value)}>
        <option value="">Pick one…</option>
        {missing && <option value={value}>{campaigns ? '(one that’s gone — pick another)' : 'Loading…'}</option>}
        {list.map((c) => (
          <option key={c.id} value={c.id}>{c.kind === 'pledge' ? 'Pledge' : 'Petition'}: {c.title}{c.status === 'closed' ? ' (closed)' : ''}</option>
        ))}
      </select>
      <p className="wb-field__hint">
        <Link to="/website/petitions?new=1" target="_blank" rel="noopener">New petition or pledge<span aria-hidden="true"> ↗</span><span className="ws-sr"> (opens a new tab)</span></Link>
      </p>
      <Problem id={errId} text={error} />
    </div>
  );
}

// ── One of the site's pages ──
function PageField({ id, label, value, onChange, error, required, pages = [] }) {
  const errId = error ? `${id}-err` : null;
  return (
    <div className="field wb-field">
      <label htmlFor={id}>{label}{required && <span className="wb-req"> (needed to publish)</span>}</label>
      <select id={id} className="input" value={value || ''} aria-invalid={error ? 'true' : undefined} aria-describedby={describe(errId)}
        onChange={(e) => onChange(e.target.value)}>
        <option value="">Pick a page…</option>
        {pages.map((p) => <option key={p.slug} value={p.slug}>{p.title} ({p.slug === 'home' ? '/' : `/${p.slug}`}){p.status !== 'published' ? ' — not on the site yet' : ''}</option>)}
      </select>
      <Problem id={errId} text={error} />
    </div>
  );
}

// ── Any field, by its type ──
// ctx: { campaigns, pages, toast(text, undo), announce(text) }
export function Field({ f, id, path, value, onChange, errors, ctx }) {
  const err = errors?.[path];
  const common = { id, label: f.label, value, onChange, required: f.required };
  switch (f.type) {
    case 'text': return <TextField {...common} max={f.max} error={err} />;
    case 'textarea': return <TextField {...common} max={f.max} error={err} multiline rows={f.max > 400 ? 5 : 3} />;
    case 'markdown': return (
      <div className="wb-md">
        <MarkdownField id={id} label={f.label} value={value ?? ''} onChange={onChange} rows={8} upload={uploadSitePicture}
          links={(ctx?.pages || []).map((p) => ({ label: p.title, url: p.slug === 'home' ? '/' : `/${p.slug}` }))} />
        {f.max && String(value ?? '').length > f.max * 0.8 && <p className="wb-field__count">{String(value ?? '').length} of {f.max}</p>}
        <Problem id={`${id}-err`} text={err} />
      </div>
    );
    case 'url': return <UrlField {...common} error={err} pages={ctx?.pages} />;
    case 'link': return <LinkField {...common} errors={errors} path={path} pages={ctx?.pages} />;
    case 'image': return <ImageField {...common} error={err || errors?.[`${path}.url`]} altError={errors?.[`${path}.alt`]} />;
    case 'select': return <SelectField {...common} options={f.options || []} error={err} />;
    case 'toggle': return <ToggleField {...common} />;
    case 'number': return <NumberField {...common} min={f.min} max={f.max} error={err} />;
    case 'words': return <WordsField {...common} max={f.max} itemMax={f.itemMax} error={err || Object.entries(errors || {}).find(([k]) => k.startsWith(`${path}.`))?.[1]} />;
    case 'list': return <ListField id={id} f={f} value={value} onChange={onChange} errors={errors} path={path} ctx={ctx} />;
    case 'campaign': return <CampaignField {...common} kinds={f.kinds} error={err} campaigns={ctx?.campaigns} />;
    case 'page': return <PageField {...common} error={err} pages={ctx?.pages} />;
    default: return null;
  }
}

// A whole section's form. onChange(key, value) — or (key, current => value)
// for a change made later (an Undo), so it applies to the section as it is then.
export function ModuleForm({ module, onChange, errors, ctx }) {
  const def = MODULE_BY_KIND[module.kind];
  const uid = useId();
  if (!def) return <p className="error">This kind of section isn’t known any more — remove it.</p>;
  const props = module.props || {};
  return (
    <div className="wb-form">
      {def.fields.map((f) => (
        <Field key={f.key} f={f} id={`${domId(uid)}-${domId(module.id)}-${f.key}`} path={f.key} value={props[f.key]}
          errors={errors} ctx={ctx} onChange={(v) => onChange(f.key, v)} />
      ))}
    </div>
  );
}
