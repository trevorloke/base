// The builder's top bar (WA decision 19): ← Pages, the page's title (edited
// in place), its status, "Saved 2:14 pm", Undo and Redo, Phone / Computer,
// Preview, ⋯ and the one primary Publish.
import { Link } from 'react-router-dom';
import { MoreMenu, SaveState } from '../Bits.jsx';

export function statusOf(base, dirty) {
  if (base.status !== 'published') return { words: 'Draft', cls: 'ops-chip-muted' };
  if (base.changed || dirty) return { words: 'Published, with changes', cls: 'chip-warn' };
  return { words: 'Published', cls: 'chip-ok' };
}

export function TopBar({
  pagesPath, title, onTitle, onTitleDone, base, dirty, save, onRetry, onSite,
  undo, redo, canUndo, canRedo, size, onSize, preview, onPreview, showSide, onSide, onFull,
  publishing, canPublish, nothingNew, onPublish, more,
}) {
  const st = statusOf(base, dirty);
  const live = base.status === 'published';
  const undoHint = canUndo ? 'Undo the last change' : 'Undo goes back over this visit’s changes';
  return (
    <header className="wb-top">
      <div className="wb-top__row">
        <Link className="ops-back wb-top__back" to={pagesPath}>← Pages</Link>
        <div className="wb-top__title">
          <label className="ws-sr" htmlFor="wb-title-in">Page title</label>
          <input id="wb-title-in" className="wb-top__in" value={title} maxLength={120} autoComplete="off"
            aria-invalid={!title.trim() ? 'true' : undefined} placeholder="Give the page a title"
            onChange={(e) => onTitle(e.target.value)} onBlur={onTitleDone} />
          {onSite && <p className="wb-build__on">On {onSite}</p>}
        </div>
      </div>
      <div className="wb-top__row wb-top__row--tools">
        <span className="wb-top__meta">
          <span className={`chip ${st.cls}`}>{st.words}</span>
          <SaveState state={save} onRetry={onRetry} />
        </span>
        <span className="wb-top__tools">
          <button type="button" className="btn btn-quiet wb-tap wb-undo" onClick={undo} aria-disabled={!canUndo} title={undoHint}
            aria-keyshortcuts="Control+Z Meta+Z">Undo</button>
          <button type="button" className="btn btn-quiet wb-tap wb-redo" onClick={redo} aria-disabled={!canRedo}
            title={canRedo ? 'Redo what was undone' : 'Nothing to redo'} aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y">Redo</button>
          <span className="ops-seg wb-top__size" role="group" aria-label="Show the preview as">
            <button type="button" aria-pressed={size === 'phone'} onClick={() => onSize('phone')}>Phone</button>
            <button type="button" aria-pressed={size === 'wide'} onClick={() => onSize('wide')}>Computer</button>
          </span>
          <button type="button" className="btn wb-tap wb-top__side" aria-pressed={showSide} onClick={onSide}>{showSide ? 'Hide preview' : 'Show preview'}</button>
          <button type="button" className="btn wb-tap wb-top__full" onClick={onFull}>Preview</button>
          {preview ? (
            <a className="btn wb-tap wb-top__tab" href={preview} target="_blank" rel="noopener" onClick={onPreview}>
              Preview<span aria-hidden="true"> ↗</span><span className="ws-sr"> (opens a new tab)</span>
            </a>
          ) : <button type="button" className="btn wb-tap wb-top__tab" disabled>Preview</button>}
          <MoreMenu label="More for this page" items={more} />
          <button type="button" className="btn btn-primary wb-tap wb-publish" onClick={onPublish} disabled={!canPublish || nothingNew || publishing}>
            {publishing ? 'Publishing…' : nothingNew ? 'Published' : live ? 'Publish changes' : 'Publish'}
          </button>
        </span>
      </div>
    </header>
  );
}
