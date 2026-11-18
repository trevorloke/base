// One section's form in the builder's column (WA decision 19): "← All
// sections" at the top (bare: in a phone's sheet, which has its own title), the section's boxes (Fields.jsx, from the catalogue),
// and Done. focus: { path, n } — the box to put the cursor in (a tap in the
// preview, a problem Publish found): the catalogue's path ('titlePrefix',
// 'items[2].title') or the preview's ('items.2.title').
import { useEffect, useRef } from 'react';
import { MODULE_BY_KIND } from '@starbase/shared/site/catalogue';
import { ModuleForm } from '../Fields.jsx';

const domId = (s) => String(s).replace(/[^A-Za-z0-9_-]+/g, '-');
// 'items.2.title' → 'items[2].title' (the catalogue's way).
export const catalogPath = (p) => String(p || '').replace(/\.(\d+)(?=\.|$)/g, '[$1]');
// The box's element for a path, in a section's form.
export function boxFor(root, moduleId, path) {
  if (!root || !path) return null;
  const tail = `-${domId(moduleId)}-${catalogPath(path).replace(/\[(\d+)\]/g, '.$1').split('.').map(domId).join('-')}`;
  for (const end of ['', '-label', '-upload', '-alt', '-href']) {
    const el = root.querySelector(`[id$="${tail}${end}"]`);
    if (el) return el;
  }
  return null;
}

export function SectionForm({ module, index, errors, general, ctx, focus, onChange, onBack, bare = false }) {
  const def = MODULE_BY_KIND[module.kind];
  const ref = useRef(null);
  const path = focus?.path ? catalogPath(focus.path) : '';
  useEffect(() => {
    const t = setTimeout(() => {
      const root = ref.current;
      if (!root) return;
      const el = (path && boxFor(root, module.id, path)) || root.querySelector('[aria-invalid="true"]') || root.querySelector('input, textarea, select');
      el?.focus({ preventScroll: true });
      el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    }, 60);
    return () => clearTimeout(t);
  }, [module.id, path, focus?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="wb-form-col" ref={ref} aria-labelledby={`wb-form-h-${module.id}`}>
      {!bare && <button type="button" className="btn btn-quiet wb-tap wb-back" onClick={onBack}>← All sections</button>}
      <h2 className={bare ? 'ws-sr' : 'wb-form-col__h'} id={`wb-form-h-${module.id}`}>
        <span className="ws-sr">Section {index + 1}: </span>{def?.label || module.kind}
      </h2>
      {def?.description && <p className="wb-help">{def.description}</p>}
      {module.hidden && <p className="wb-note">Hidden: it stays in the draft but isn’t shown on the page.</p>}
      {general && <p className="wb-field__err">{general}</p>}
      <ModuleForm module={module} errors={errors} ctx={{ ...ctx, focus: path }} onChange={onChange} />
      <div className="wb-sec__foot">
        <button type="button" className="btn btn-quiet wb-tap" onClick={onBack}>Done</button>
      </div>
    </section>
  );
}
