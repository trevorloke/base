// Passes on the field screens (ext/passes; the rule is shared/passes.js).
//   <PassChip pass desk />    the turf list's line (pass: the list's, null for
//                             none; undefined before it loads → nothing). The
//                             desk: "Pass: Persuasion · October ›" (→ /passes)
//                             or "Pass: none ›". A volunteer: the pass's name
//                             as a quiet chip, or nothing.
//   <TryAgainChip tries max />  a door's "Try again · 1 of 2" (amber)
//   <WalkShow value onChange counts />  the walk list's pill row: Show ·
//                             All · Not knocked (N) · Try again (N)
//   waitingTries(items, pass) person id → { n, outcome }: the door knocks
//                             still in this phone's outbox that count in the
//                             pass (tapped once it was open, as the server
//                             stamps them) — every one is a try.
//   overlayPass(door, local, pass, serverAt, waiting)  the door's people with
//                             this phone's knocks laid over, so doorState
//                             reads what the server doesn't have yet: every
//                             knock still waiting (waiting), and one sent
//                             since the list loaded (local: person id →
//                             { outcome, at }, newer than serverAt, ms). One
//                             the list already carries is never counted twice.
import { Link } from 'react-router-dom';
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

// The server counts a tap up to five minutes before the pass began (a slow
// phone clock): so does the phone.
const SKEW_MS = 5 * 60_000;
export const waitingTries = (items = [], pass = null) => {
  const out = {};
  if (!pass) return out;
  const from = Date.parse(pass.started_at) - SKEW_MS;
  for (const it of items) {
    if (it.state !== 'pending' || it.name !== 'contact.log' || it.input?.channel !== 'door' || !it.input.person_id) continue;
    if (it.at && Date.parse(it.at) < from) continue;
    const pid = it.input.person_id;
    // The same visit, finished (visit_of): its outcome, not another try.
    out[pid] = { n: (out[pid]?.n || 0) + (it.input.visit_of ? 0 : 1), outcome: it.input.outcome };
  }
  return out;
};

export const overlayPass = (door, local, pass, serverAt = 0, waiting = {}) => door.persons.map((p) => {
  if (!pass) return p;
  const queued = waiting[p.id];
  if (queued) {
    return { ...p, pass_last_outcome: queued.outcome, pass_tries: (p.pass_tries || 0) + queued.n, door_knocked: true };
  }
  // Sent from here since the list loaded (not in the outbox any more): the
  // list will carry it on its next load; until then it counts once.
  const mine = local[p.id];
  if (!mine || mine.queued || !mine.at || (serverAt && Date.parse(mine.at) <= serverAt)) return p;
  return { ...p, pass_last_outcome: mine.outcome, pass_tries: (p.pass_tries || 0) + 1, door_knocked: true };
});
