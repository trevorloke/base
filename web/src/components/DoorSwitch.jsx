// The doors of one house (a main door and its suites: a basement suite, a
// coach house…), side by side at the top of the door card, so a canvasser
// picks the door they are standing at. One button per door, big enough for
// a thumb in a glove (56 px): the door's words, then its state. The card
// opens on the first door not done (Main first), or on the door a link
// names; a tap swaps the people and the knock buttons below, nothing else.
// Two doors sit side by side, three or four in a 2 × 2 grid, five or more
// in one column. (UNITS.md §5.2; words: §6.)

// A door's state, in the words every screen uses.
export const DOOR_STATE_WORDS = {
  open: 'Not knocked',
  again: 'Try again',
  done: 'Done ✓',
  voted: 'Voted ✓',
  off: 'Not on this round',
};
// States a canvasser still has to knock.
export const stillToKnock = (state) => state === 'open' || state === 'again' || !state;

// The next door to knock at this house after `from` (a door key), round
// the house in its order: not knocked first, then try again. null: none.
export const nextAtHouse = (doors, from) => {
  const n = doors.length;
  const at = doors.findIndex((d) => d.key === from);
  for (const want of ['open', 'again']) {
    for (let k = 1; k <= n; k += 1) {
      const d = doors[(at + k + n) % n];
      if (d.key !== from && (d.state || 'open') === want) return d;
    }
  }
  return null;
};

// doors: [{ key, words, state }] in house order; value: the selected door's key.
export default function DoorSwitch({ doors, value, onPick }) {
  if (!doors || doors.length < 2) return null;
  const n = doors.length;
  const shape = n === 2 ? 'pair' : n <= 4 ? 'grid' : 'column';
  return (
    <section className="door-switch" aria-labelledby="door-switch-label">
      <h3 className="door-switch__label" id="door-switch-label">Doors at this house</h3>
      <div className={`door-switch__doors door-switch__doors--${shape}`} role="group" aria-labelledby="door-switch-label">
        {doors.map((d) => {
          const on = d.key === value;
          const state = d.state ? DOOR_STATE_WORDS[d.state] || '' : '';
          return (
            <button
              key={d.key}
              type="button"
              className={`door-switch__btn${on ? ' is-on' : ''} door-switch__btn--${d.state || 'open'}`}
              aria-pressed={on}
              aria-label={[d.words, state.replace(' ✓', '').toLowerCase()].filter(Boolean).join(', ')}
              data-door={d.key}
              onClick={() => { if (!on) onPick(d.key); }}
            >
              <span className="door-switch__words">{d.words}</span>
              {state && <span className="door-switch__state">{state}</span>}
            </button>
          );
        })}
      </div>
    </section>
  );
}
