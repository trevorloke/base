// The page's sections in order (WA decision 19): one card each — a drag
// handle, its drawing, its name and first words, ⋯ (Hide, Duplicate, Move
// up, Move down, Delete) — a thin + between every two and "Add a section"
// at the end. Tapping a card opens its form. An empty page: one big
// "Add your first section". The same order as the page, for keyboards and
// screen readers.
import { MODULE_BY_KIND } from '@starbase/shared/site/catalogue';
import { MoreMenu } from '../Bits.jsx';
import { Thumb } from '../thumbs.jsx';
import { summaryOf } from '../builder.js';

const GRIP = <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></svg>;

function Plus({ at, onAdd, disabled }) {
  return (
    <li className="wb-plus" role="none">
      <button type="button" className="wb-plus__btn" onClick={() => onAdd(at)} disabled={disabled} aria-label={`Add a section here (as section ${at + 1})`}>
        <span aria-hidden="true">+</span>
      </button>
    </li>
  );
}

export function SectionList({ modules, problems, campaigns, dnd, locked, onOpen, onAdd, onMove, onHide, onDuplicate, onRemove }) {
  const picked = dnd.picked;
  const full = modules.length >= 60;
  if (!modules.length) {
    return (
      <div className="wb-first">
        <button type="button" className="btn btn-primary wb-first__btn" onClick={() => onAdd(0)} disabled={locked}>Add your first section</button>
        <p className="wb-help">Pick one from the gallery — a headline, some words, a sign-up.</p>
      </div>
    );
  }
  return (
    <>
      {modules.length > 1 && <p className="wb-help">Drag a section by its handle to move it — or tap the handle, then “Move here”.</p>}
      <ol className="wb-cards" aria-label="Sections, top to bottom">
        {modules.map((m, i) => {
          const def = MODULE_BY_KIND[m.kind];
          const label = def?.label || m.kind;
          const isPicked = picked?.id === m.id;
          const bad = problems.some((p) => p.id === m.id);
          const sum0 = summaryOf(m, { campaigns });
          const sum = sum0 && sum0.toLowerCase() !== label.toLowerCase() ? sum0 : '';
          return [
            i > 0 && <Plus key={`plus-${m.id}`} at={i} onAdd={onAdd} disabled={locked || full} />,
            <li key={m.id} id={`wb-sec-${m.id}`} className="wb-card" data-drop-key={`sec:${m.id}`} data-over={dnd.over(`sec:${m.id}`)}
              data-hidden={m.hidden ? '' : undefined} data-bad={bad ? '' : undefined} data-picked={isPicked ? '' : undefined} data-kind={m.kind}>
              <button type="button" className="wb-handle" {...dnd.itemProps({ id: m.id, label })} disabled={locked}
                aria-label={isPicked ? `${label}: picked up — choose where it goes` : `Move section ${i + 1}, ${label}`}>
                {GRIP}
              </button>
              <button type="button" className="wb-card__open" onClick={() => onOpen(m.id)}>
                <span className="wb-card__pic"><Thumb kind={m.kind} /></span>
                <span className="wb-card__words">
                  <span className="wb-card__name"><span className="ws-sr">Section {i + 1}: </span>{label}</span>
                  {sum && <span className="wb-card__sum">{sum}</span>}
                </span>
                {m.hidden && <span className="chip ops-chip-muted">Hidden</span>}
                {bad && <span className="chip chip-danger">Needs a look</span>}
              </button>
              {picked && !isPicked ? (
                <button type="button" className="btn wb-here" onClick={() => dnd.dropPicked(`sec:${m.id}`)}>Move here</button>
              ) : (
                <MoreMenu label={`More for section ${i + 1}, ${label}`} items={[
                  { label: m.hidden ? 'Show on the page' : 'Hide from the page', onClick: () => onHide(i, !m.hidden) },
                  { label: 'Duplicate', onClick: () => onDuplicate(i), disabled: full },
                  i > 0 && { label: 'Move up', onClick: () => onMove(i, i - 1) },
                  i < modules.length - 1 && { label: 'Move down', onClick: () => onMove(i, i + 1) },
                  { label: 'Delete', onClick: () => onRemove(i), danger: true },
                ]} />
              )}
            </li>,
          ];
        })}
      </ol>
      {picked && (
        <div className="wb-hand" role="status">
          <span>Moving <b>{picked.label}</b> — tap “Move here” on the section it should take the place of.</span>
          <button type="button" className="btn btn-quiet" onClick={() => dnd.setPicked(null)}>Cancel</button>
        </div>
      )}
      <div className="wb-ghost" ref={dnd.ghostRef} hidden={!dnd.dragging} aria-hidden="true">{dnd.dragging?.label}</div>
      <button type="button" className="btn wb-add ops-tap" onClick={() => onAdd(modules.length)} disabled={locked || full}>+ Add a section</button>
    </>
  );
}
