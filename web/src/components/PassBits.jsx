// Passes on the field screens (ext/passes; the rule is shared/passes.js).
//   <PassChip pass desk />    the turf list's line (pass: the list's, null for
//                             none; undefined before it loads → nothing). The
//                             desk: "Pass: Persuasion · October ›" (→ /passes)
//                             or "Pass: none ›". A volunteer: the pass's name
//                             as a quiet chip, or nothing.
//   <TryAgainChip tries max />  a door's "Try again · 1 of 2" (amber)
//   <WalkShow value onChange counts />  the walk list's pill row: Show ·
//                             All · Not knocked (N) · Try again (N)
//   overlayPass(door, local, pass, serverAt)  the door's people with this
//                             phone's knocks laid over (local: person id →
//                             { outcome, at, queued }), so doorState reads a
//                             knock the server doesn't have yet: a knock
//                             still in the outbox, or newer than the list
//                             (serverAt, ms). One the list already carries
//                             is never counted twice.
import { Link } from 'react-router-dom';
import { NOT_A_TRY } from '@starbase/shared/passes';
import '../pages/passes.css';

export function PassChip({ pass, desk }) {
  if (pass === undefined) return null; // the list hasn't loaded (or is an older copy)
  if (desk) {
    return (
      <p className="pass-line">
        <Link to="/passes" className="chip pass-chip">Pass: {pass ? pass.name : 'none'} <span aria-hidden="true">›</span></Link>
      </p>
    );
  }
  if (!pass) return null;
  return <p className="pass-line"><span className="chip pass-chip pass-chip--quiet">{pass.name}</span></p>;
}

export function TryAgainChip({ tries, max }) {
  return <span className="chip pass-again">Try again · {tries} of {max}</span>;
}

const SHOW = [['all', 'All'], ['open', 'Not knocked'], ['again', 'Try again']];
export function WalkShow({ value, onChange, counts }) {
  return (
    <div className="pass-show" role="group" aria-label="Show">
      <span className="pass-show__label" aria-hidden="true">Show</span>
      {SHOW.map(([code, label]) => (
        <button key={code} type="button" className="pass-show__pill" aria-pressed={value === code} onClick={() => onChange(code)}>
          {label}{code !== 'all' && ` (${counts[code] || 0})`}
        </button>
      ))}
    </div>
  );
}

export const overlayPass = (door, local, pass, serverAt = 0) => door.persons.map((p) => {
  const mine = local[p.id];
  if (!mine || !pass) return p;
  const fresh = mine.queued || !serverAt || !mine.at || Date.parse(mine.at) > serverAt;
  if (!fresh) return p;
  return {
    ...p,
    pass_last_outcome: mine.outcome,
    pass_tries: (p.pass_tries || 0) + (NOT_A_TRY.includes(mine.outcome) ? 0 : 1),
    door_knocked: true,
  };
});
