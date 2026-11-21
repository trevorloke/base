// A section's form, made from its fields in the catalogue
// (shared/site/catalogue.js) — adding a module kind there adds its form here
// with nothing else to write. One component per field type:
//   text · textarea · markdown (a small toolbar, Preview, pictures) · url ·
//   link ({ label, href }) · image (upload or pick, a description for people
//   who can't see it) · select (the columns' icon: a grid of the drawn
//   icons; a background: swatches in the theme's colours) · toggle · number
//   · words (chips) · list (repeatable groups: a drag handle, ⋯ to move or
//   remove, Undo) · campaign (a petition or pledge) · page (one of the
//   site's pages)
// Every box has its own label; a problem shows under its box (errors, keyed
// by the catalogue's path: 'items[2].title') and the box says it's invalid.
// ImageField is also the share picture's and the logo's (pages, settings,
// theme, posts).
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MODULE_BY_KIND } from '@starbase/shared/site/catalogue';
import { Icon } from '@starbase/shared/site/components/icons';
import { useDragDrop } from '../useDragDrop.js';
import { MarkdownField, shrinkImage, toDataUrl, uploadImage } from '../MarkdownField.jsx';
import { pictureCopies } from '../brand-pictures.js';
import './pictures.css';
import { action } from '../../api.js';
import { at } from '../../base.js';
import { Dialog, MoreMenu } from './Bits.jsx';
import { useSitePictures } from './useSite.js';
import { isSiteLink, tidyLink } from './builder.js';

export const uploadSitePicture = (file) => uploadImage(file, 'site.picture');
// A section's or a post's picture: with its smaller copies (480, 960 and
// 1,600 px), so a phone fetches a phone-sized one (WA decision 26).
export async function uploadSizedPicture(file) {
  const { blob, width, height } = await shrinkImage(file);
  const copies = await pictureCopies(file).catch(() => []);
  const sizes = [];
  for (const c of copies) sizes.push({ data: await toDataUrl(c.blob), width: c.width, height: c.height });
  const res = await action('site.picture', { data: await toDataUrl(blob), name: file.name.slice(0, 200), width, height, ...(sizes.length ? { sizes } : {}) });
  return res.media;
}
// The picture's value as the catalogue keeps it, from an upload or the list.
const pictureValue = (m, alt = '') => ({
  url: m.url || `/media/${m.id}`, alt,
  ...(m.width && m.height ? { width: m.width, height: m.height } : {}),
  ...(m.sizes?.length ? { sizes: m.sizes } : {}),
});
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
  // Near the limit: "212 of 240" under the box (read with it, not on every key).
  const near = max && v.length > max * 0.8;
  const countId = near ? `${id}-count` : null;
  const Tag = multiline ? 'textarea' : 'input';
  return (
    <div className="field wb-field">
      <label htmlFor={id}>{label}{required && <span className="wb-req"> (needed to publish)</span>}</label>
      <Tag id={id} className="input" value={v} maxLength={max || undefined} rows={multiline ? rows : undefined}
        type={multiline ? undefined : 'text'} placeholder={placeholder} aria-invalid={error ? 'true' : undefined}
        aria-describedby={describe(hintId, countId, errId)} onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="wb-field__hint" id={hintId}>{hint}</p>}
      {near && <p className="wb-field__count" id={countId}>{v.length} of {max}</p>}
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

// ── A picture: upload or pick one, the spot to keep in view, and what it shows ──
// plain: a logo or a share picture — one file as it is, no spot to keep in
// view, never decorative.
export function ImageField({ id, label, value, onChange, error, altError, required, hint, plain = false }) {
  const v = value && typeof value === 'object' ? value : { url: '', alt: '' };
  const file = useRef(null);
  const [busy, setBusy] = useState(false);
  const [upErr, setUpErr] = useState(null);
  const [picking, setPicking] = useState(false);
  // An upload takes a while (seconds, on a phone): when it lands, the
  // picture goes in with the description and the handler as they are then,
  // not as they were when the file was chosen.
  const latest = useRef({ v, onChange });
  latest.current = { v, onChange };
  const pick = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setBusy(true);
    setUpErr(null);
    try {
      const media = plain ? await uploadSitePicture(f) : await uploadSizedPicture(f);
      const now = latest.current;
      now.onChange(plain ? { url: media.url || `/media/${media.id}`, alt: now.v.alt || '' } : pictureValue(media, now.v.alt || ''));
    } catch (err) {
      setUpErr(err.message);
    } finally {
      setBusy(false);
    }
  };
  const errText = error || upErr;
  const errId = errText ? `${id}-err` : null;
  const noAlt = v.url && !v.decorative && !String(v.alt || '').trim();
  return (
    <fieldset className="wb-group wb-image" aria-describedby={describe(errId)}>
      <legend>{label}{required && <span className="wb-req"> (needed to publish)</span>}</legend>
      {hint && <p className="wb-field__hint">{hint}</p>}
      <div className="wb-image__row">
        {v.url && !plain ? <FocusSpot id={id} v={v} onChange={onChange} /> : (
          <div className="wb-image__thumb" data-empty={v.url ? undefined : ''}>
            {v.url ? <img src={at(v.url)} alt={v.alt ? `Chosen: ${v.alt}` : 'The chosen picture'} loading="lazy" /> : <span aria-hidden="true">No picture</span>}
          </div>
        )}
        <div className="wb-image__tools">
          <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={pick} />
          <button type="button" id={`${id}-upload`} className="btn wb-tap" disabled={busy} onClick={() => file.current?.click()}>
            {busy ? 'Uploading…' : v.url ? 'Upload another' : 'Upload a picture'}
          </button>
          <button type="button" className="btn btn-quiet wb-tap" onClick={() => setPicking(true)}>Choose one uploaded</button>
          {v.url && <button type="button" className="btn btn-quiet wb-tap" onClick={() => onChange({ url: '', alt: '' })}>Remove</button>}
        </div>
      </div>
      <Problem id={errId} text={errText} />
      {v.url && !v.decorative && (
        <TextField id={`${id}-alt`} label="Describe the picture for people who can’t see it" max={300} value={v.alt}
          error={altError} hint={noAlt ? 'Say it in a few words, like “Volunteers knocking on doors on a sunny afternoon”.' : null}
          onChange={(alt) => onChange({ ...v, alt })} />
      )}
      {v.url && !plain && (
        <ToggleField id={`${id}-deco`} label="Decorative (says nothing new)" value={v.decorative === true}
          onChange={(on) => { const { decorative, ...rest } = v; onChange(on ? { ...rest, decorative: true } : rest); }} />
      )}
      {picking && <PicturePicker onClose={() => setPicking(false)} onPick={(p) => { setPicking(false); onChange(plain ? { url: p.url, alt: v.alt || '' } : pictureValue(p, v.alt || '')); }} />}
    </fieldset>
  );
}

// The spot that must stay in view when the picture is cropped (a phone's
// narrow hero, a square card): tap it on the picture, or move it with the
// arrow keys. A dot marks it; the middle until someone chooses.
function FocusSpot({ id, v, onChange }) {
  const f = v.focus || { x: 50, y: 50 };
  const set = (x, y) => {
    const c = (n) => Math.max(0, Math.min(100, Math.round(n)));
    const next = { x: c(x), y: c(y) };
    const { focus, ...rest } = v;
    onChange(next.x === 50 && next.y === 50 ? rest : { ...rest, focus: next });
  };
  const tap = (e) => {
    const box = e.currentTarget.getBoundingClientRect();
    if (!box.width || !box.height || e.detail === 0) return; // a keyboard "click"
    set(((e.clientX - box.left) / box.width) * 100, ((e.clientY - box.top) / box.height) * 100);
  };
  const keys = { ArrowLeft: [-5, 0], ArrowRight: [5, 0], ArrowUp: [0, -5], ArrowDown: [0, 5] };
  return (
    <button type="button" id={`${id}-focus`} className="wb-image__thumb wb-focus" onClick={tap}
      onKeyDown={(e) => { const k = keys[e.key]; if (k) { e.preventDefault(); set(f.x + k[0], f.y + k[1]); } }}
      aria-label={`The spot to keep in view: ${f.x}% across, ${f.y}% down. Tap the picture, or use the arrow keys.`}>
      <img src={at(v.url)} alt="" loading="lazy" />
      <span className="wb-focus__dot" style={{ left: `${f.x}%`, top: `${f.y}%` }} aria-hidden="true" />
    </button>
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

// The columns' icon: the drawn icons, each a radio with its name.
function IconField({ id, label, value, options, onChange }) {
  const cur = value || options[0]?.value;
  const at = Math.max(0, options.findIndex((o) => o.value === cur));
  const move = (e) => {
    const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!d) return;
    e.preventDefault();
    const next = options[(at + d + options.length) % options.length];
    onChange(next.value);
    setTimeout(() => document.getElementById(`${id}-${next.value}`)?.focus(), 0);
  };
  return (
    <fieldset className="wb-group">
      <legend>{label}</legend>
      <div className="wb-icons" role="radiogroup" aria-label={label} onKeyDown={move}>
        {options.map((o) => (
          <button key={o.value} type="button" id={`${id}-${o.value}`} role="radio" aria-checked={o.value === cur}
            tabIndex={o.value === cur ? 0 : -1} className="wb-icons__btn" title={o.label} aria-label={o.label}
            onClick={() => onChange(o.value)}>
            <Icon name={o.value} size={24} />
          </button>
        ))}
      </div>
    </fieldset>
  );
}

// A background: swatches in the theme's colours, with their names.
const TONE_COLOUR = { paper: 'paper', surface: 'surface', brand: 'brand', accent: 'accent', ink: 'ink' };
function ToneField({ id, label, value, options, onChange, colors }) {
  const cur = value || options[0]?.value;
  return (
    <fieldset className="wb-group">
      <legend>{label}</legend>
      <div className="wb-tones" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <label key={o.value} className="wb-tones__one" htmlFor={`${id}-${o.value}`}>
            <input type="radio" id={`${id}-${o.value}`} name={id} value={o.value} checked={o.value === cur} onChange={() => onChange(o.value)} />
            <span className="wb-tones__sw" style={colors?.[TONE_COLOUR[o.value]] ? { background: colors[TONE_COLOUR[o.value]] } : undefined} data-tone={o.value} aria-hidden="true" />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
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
  // Which item is which, across edits and moves (an edited item is a new
  // object; it keeps its key): a change that lands later (a photo upload)
  // goes to its own item in the list as it is then — nothing typed or
  // moved meanwhile is undone.
  const keys = useRef(new WeakMap());
  const nextKey = useRef(0);
  const keyOf = (x) => {
    if (!x || typeof x !== 'object') return null;
    if (!keys.current.has(x)) { nextKey.current += 1; keys.current.set(x, nextKey.current); }
    return keys.current.get(x);
  };
  const setSub = (item, i, subKey, v) => {
    const k = keyOf(item);
    onChange((cur) => {
      const list = Array.isArray(cur) ? cur : items;
      let at = k == null ? -1 : list.findIndex((x) => keyOf(x) === k);
      if (at < 0) at = list[i] === item || k == null ? i : -1; // gone since: nothing to change
      if (at < 0 || at >= list.length) return list;
      return list.map((x, j) => {
        if (j !== at) return x;
        const next = { ...x, [subKey]: typeof v === 'function' ? v(x?.[subKey]) : v };
        if (k != null) keys.current.set(next, k);
        return next;
      });
    });
  };
  const one = ONE[f.label] || 'item';
  const full = f.max && items.length >= f.max;
  // An item with a problem opens by itself.
  const badKey = Object.keys(errors || {}).filter((k) => k.startsWith(`${path}[`)).sort().join('|');
  useEffect(() => {
    if (!badKey) return;
    const bad = badKey.split('|').map((k) => Number(k.slice(path.length + 1).split(']')[0])).filter(Number.isInteger);
    setOpen((s) => (bad.every((i) => s.has(i)) ? s : new Set([...s, ...bad])));
  }, [badKey, path]);
  // A box to put the cursor in (a tap in the preview): its item opens.
  const want = ctx?.focus && String(ctx.focus).startsWith(`${path}[`) ? Number(String(ctx.focus).slice(path.length + 1).split(']')[0]) : null;
  useEffect(() => {
    if (Number.isInteger(want)) setOpen((s) => (s.has(want) ? s : new Set([...s, want])));
  }, [want]);
  const toggle = (i) => setOpen((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  // From one place to another (dragged, or ⋯ Move up / Move down).
  const moveTo = (i, j) => {
    if (j < 0 || j >= items.length || i === j) return;
    const next = [...items];
    const [x] = next.splice(i, 1);
    next.splice(j, 0, x);
    onChange(next);
    setOpen(new Set());
    ctx?.announce?.(`Moved to ${j + 1} of ${items.length}`);
  };
  const move = (i, d) => moveTo(i, i + d);
  const dnd = useDragDrop({
    onDrop: (item, key) => {
      const to = Number(String(key).split(':').pop());
      if (Number.isInteger(to)) moveTo(item.i, to);
    },
  });
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
            const name = itemSummary(f, item, i);
            const dropKey = `${id}:${i}`;
            const isPicked = dnd.picked?.i === i;
            return (
              <li key={i} className="wb-list__item" data-open={isOpen ? '' : undefined} data-bad={bad ? '' : undefined}
                data-drop-key={dropKey} data-over={dnd.over(dropKey)} data-picked={isPicked ? '' : undefined}>
                <div className="wb-list__head">
                  <button type="button" className="wb-handle" {...dnd.itemProps({ id: `${id}:${i}`, i, label: name })}
                    aria-label={isPicked ? `${name}: picked up — choose where it goes` : `Move ${name}`}>
                    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></svg>
                  </button>
                  <button type="button" className="wb-list__toggle" aria-expanded={isOpen} aria-controls={bodyId} onClick={() => toggle(i)}>
                    <span className="wb-list__sum">{name}</span>
                    {bad && <span className="chip chip-danger">Needs a look</span>}
                  </button>
                  {dnd.picked && !isPicked ? (
                    <button type="button" className="btn wb-here" onClick={() => dnd.dropPicked(dropKey)}>Move here</button>
                  ) : (
                    <MoreMenu label={`More for ${name}`} items={[
                      i > 0 && { label: 'Move up', onClick: () => move(i, -1) },
                      i < items.length - 1 && { label: 'Move down', onClick: () => move(i, 1) },
                      { label: 'Remove', onClick: () => remove(i), danger: true },
                    ]} />
                  )}
                </div>
                {isOpen && (
                  <div className="wb-list__body" id={bodyId}>
                    {f.of.map((sub) => (
                      <Field key={sub.key} f={sub} id={`${id}-${i}-${sub.key}`} path={`${path}[${i}].${sub.key}`}
                        value={item?.[sub.key]} errors={errors} ctx={ctx}
                        onChange={(v) => setSub(item, i, sub.key, v)} />
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <div className="wb-ghost" ref={dnd.ghostRef} hidden={!dnd.dragging} aria-hidden="true">{dnd.dragging?.label}</div>
      <button type="button" className="btn wb-tap wb-list__add" disabled={full} onClick={add}>
        {full ? `That’s the most (${f.max})` : `Add ${/^[aeiou]/i.test(one) ? 'an' : 'a'} ${one}`}
      </button>
    </fieldset>
  );
}

// ── A petition or pledge ──
// campaigns: null while they load (nothing is said to be gone till then).
function CampaignField({ id, label, value, kinds, onChange, error, required, campaigns = null, refresh }) {
  const errId = error ? `${id}-err` : null;
  const list = (campaigns || []).filter((c) => !kinds || kinds.includes(c.kind));
  const missing = value && !(campaigns || []).some((c) => c.id === value);
  return (
    <div className="field wb-field">
      <label htmlFor={id}>{label}{required && <span className="wb-req"> (needed to publish)</span>}</label>
      {/* One made in another tab since: read again when the box is opened. */}
      <select id={id} className="input" value={value || ''} aria-invalid={error ? 'true' : undefined} aria-describedby={describe(errId)}
        onChange={(e) => onChange(e.target.value)} onFocus={() => refresh?.()}>
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
    case 'select':
      if (f.key === 'icon') return <IconField {...common} options={f.options || []} />;
      if (f.key === 'tone') return <ToneField {...common} options={f.options || []} colors={ctx?.colors} />;
      return <SelectField {...common} options={f.options || []} error={err} />;
    case 'toggle': return <ToggleField {...common} />;
    case 'number': return <NumberField {...common} min={f.min} max={f.max} error={err} />;
    case 'words': return <WordsField {...common} max={f.max} itemMax={f.itemMax} error={err || Object.entries(errors || {}).find(([k]) => k.startsWith(`${path}.`))?.[1]} />;
    case 'list': return <ListField id={id} f={f} value={value} onChange={onChange} errors={errors} path={path} ctx={ctx} />;
    case 'campaign': return <CampaignField {...common} kinds={f.kinds} error={err} campaigns={ctx?.campaigns} refresh={ctx?.refreshCampaigns} />;
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
