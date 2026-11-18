// ⋯ → Page settings (WA decision 19): the page's address, its words for
// search engines and shares, its share picture and "In the menu" — what
// used to open first as Page details, now out of the way.
import { useState } from 'react';
import { Dialog } from '../Bits.jsx';
import { ImageField, TextField, ToggleField } from '../Fields.jsx';
import { slugInput } from '../builder.js';

const SYSTEM = { home: 'The home page is always at /.', news: 'The news page is always at /news.' };

export function PageSettings({ open, onClose, draft, base, change, onSlug, languagesOn }) {
  const [slug, setSlug] = useState(base.slug);
  const [err, setErr] = useState(null);
  const live = base.status === 'published';
  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    if (!slug || slug === base.slug) return;
    const r = await onSlug(slug);
    if (r?.error) setErr(r.error); else if (r?.slug) setSlug(r.slug);
  };
  return (
    <Dialog open={open} title="Page settings" onClose={onClose}>
      <div className="wb-details__body">
        <form className="field wb-field" onSubmit={submit}>
          <label htmlFor="wb-slug">Address</label>
          {SYSTEM[base.slug] ? <p className="wb-fixed">{SYSTEM[base.slug]}</p> : (
            <>
              <div className="wb-slug">
                <span className="wb-slug__root" aria-hidden="true">/</span>
                <input id="wb-slug" className="input" maxLength={60} autoComplete="off" spellCheck={false} value={slug}
                  aria-invalid={err ? 'true' : undefined} aria-describedby="wb-slug-hint"
                  onChange={(e) => { setSlug(slugInput(e.target.value)); setErr(null); }} />
                <button type="submit" className="btn wb-tap" disabled={!slug || slug === base.slug}>Change address</button>
              </div>
              <p className="wb-field__hint" id="wb-slug-hint">
                {live ? 'Changes at once, on the live page too: links to the old address stop working.' : 'Lowercase letters, numbers and dashes.'}
              </p>
              {err && <p className="wb-field__err">{err}</p>}
            </>
          )}
        </form>
        <TextField id="wb-desc" label="Description (for search engines and shares)" max={300} multiline value={draft.description}
          onChange={(v) => change((d) => ({ ...d, description: v }), 'description')} />
        <ImageField id="wb-share" label="Share picture" value={draft.image}
          hint="Shown when the page is shared. Without one, the site’s own (Settings → Search and sharing)."
          onChange={(v) => change((d) => ({ ...d, image: v }))} />
        <ToggleField id="wb-nav" label="Show this page in the site’s menu" value={draft.show_in_nav}
          hint={live ? null : 'Once it’s published.'} onChange={(v) => change((d) => ({ ...d, show_in_nav: v }))} />
        {languagesOn && (
          <ToggleField id="wb-check-first" label="Show translated only after a person checks it" value={draft.check_first}
            hint="Until then this page shows in English in the other languages." onChange={(v) => change((d) => ({ ...d, check_first: v }))} />
        )}
        <div className="ops-actions"><button type="button" className="btn wb-tap" onClick={onClose}>Done</button></div>
      </div>
    </Dialog>
  );
}
