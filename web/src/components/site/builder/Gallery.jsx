// Add a section (WA decision 22): a gallery of small drawings with plain
// names and a search box. Most used first, then the catalogue's groups. A
// kind a page may hold once (the voter guide) is greyed when it's there.
import { useMemo, useState } from 'react';
import { MODULE_BY_KIND } from '@starbase/shared/site/catalogue';
import { Dialog } from '../Bits.jsx';
import { Thumb } from '../thumbs.jsx';
import { groups } from '../builder.js';

export const MOST_USED = ['hero', 'text', 'petition', 'newsletter', 'donate', 'volunteer'];
export const ONCE = new Set(['voterguide']);
const norm = (s) => String(s || '').toLowerCase();

function Card({ kind, onPick, taken, paymentsReady }) {
  const m = MODULE_BY_KIND[kind];
  if (!m) return null;
  return (
    <li>
      <button type="button" className="wb-gal__card" onClick={() => onPick(kind)} disabled={taken} data-kind={kind}
        aria-describedby={`wb-gal-${kind}-what`}>
        <span className="wb-gal__pic"><Thumb kind={kind} /></span>
        <span className="wb-gal__name">{m.label}</span>
        <span className="wb-gal__what" id={`wb-gal-${kind}-what`}>
          {taken ? 'Already on this page' : m.description}
          {!taken && ['donate', 'join'].includes(kind) && !paymentsReady && ' Online giving isn’t set up yet — until it is, the form says so.'}
        </span>
      </button>
    </li>
  );
}

export function Gallery({ open, onClose, onPick, modules = [], paymentsReady }) {
  const [q, setQ] = useState('');
  const has = useMemo(() => new Set(modules.map((m) => m.kind)), [modules]);
  const taken = (kind) => ONCE.has(kind) && has.has(kind);
  const words = norm(q).trim();
  const found = words ? Object.values(MODULE_BY_KIND).filter((m) => norm(`${m.label} ${m.description}`).includes(words)) : null;
  const close = () => { setQ(''); onClose(); };
  const pick = (kind) => { setQ(''); onPick(kind); };
  const card = (kind) => <Card key={kind} kind={kind} onPick={pick} taken={taken(kind)} paymentsReady={paymentsReady} />;
  return (
    <Dialog open={open} title="Add a section" onClose={close} wide>
      <div className="wb-gal">
        <label className="ws-sr" htmlFor="wb-gal-q">Search sections</label>
        <input id="wb-gal-q" className="input wb-gal__q" type="search" placeholder="Search sections" autoComplete="off"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <p className="ws-sr" aria-live="polite">{found ? `${found.length} found` : ''}</p>
        {found ? (
          found.length ? <ul className="wb-gal__grid">{found.map((m) => card(m.kind))}</ul>
            : <p className="ops-empty">No section matches “{q}”.</p>
        ) : (
          <>
            <section aria-labelledby="wb-gal-most">
              <h3 id="wb-gal-most" className="wb-gal__h">Most used</h3>
              <ul className="wb-gal__grid">{MOST_USED.map(card)}</ul>
            </section>
            {groups().map((g) => (
              <section key={g.key} aria-labelledby={`wb-gal-${g.key}`}>
                <h3 id={`wb-gal-${g.key}`} className="wb-gal__h">{g.label}</h3>
                <ul className="wb-gal__grid">{g.modules.filter((m) => !MOST_USED.includes(m.kind)).map((m) => card(m.kind))}</ul>
              </section>
            ))}
          </>
        )}
      </div>
    </Dialog>
  );
}
