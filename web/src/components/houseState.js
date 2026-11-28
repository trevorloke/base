// A house's doors on the map's door switch: what state each one is in.
// No browser code here (server/test/house-state.test.js reads it).
//
//   serverStates(answer)        the server's answer (GET /buildings/house/:id:
//                               { pass, doors: [{ key, state, in_round }] }) as
//                               a Map by door key, or null when there is none
//   keptFor(lists, passId)      the walk lists kept on this phone (newest
//                               first, each { data }) → { byPerson, off }, read
//                               only for one round: the one the server named,
//                               else the newest kept list's. A list kept on an
//                               earlier round never says a door is done now.
//   houseDoorState(d, from)     'voted' | 'done' | 'again' | 'off' | 'open'
//   firstToKnock(doors, stateOf) the door a tap on the house opens: the first
//                               not knocked, else the first to try again, else Main
//
// The order: voted; the server's state for the open round (else, offline,
// the kept list's) when it is done; a knock made on this phone (sent from
// the card, or still in the outbox), which is newer; the round's state; not
// on this round; else not knocked.
import { TERMINAL } from '@base-win/shared/passes';

export const serverStates = (answer) => (Array.isArray(answer?.doors)
  ? new Map(answer.doors.map((d) => [d.key, d]))
  : null);

const roundOf = (list) => list?.data?.pass?.id ?? null;

export const keptFor = (lists, passId) => {
  const byPerson = new Map();
  const off = new Set();
  const all = (lists || []).filter(Boolean);
  const want = passId !== undefined ? passId : (all.length ? roundOf(all[0]) : null);
  for (const list of all) {
    if (roundOf(list) !== want) continue;
    for (const d of list.data?.doors || []) {
      for (const p of d.persons || []) if (!byPerson.has(p.id)) byPerson.set(p.id, d.state || 'open');
      if (d.civic) for (const h of d.house_doors || []) if (h.in_round === false) off.add(`${d.civic}|${h.unit}`);
    }
  }
  return { byPerson, off };
};

export const houseDoorState = (d, { server = null, kept = null, knocks = null, voted = false } = {}) => {
  if (voted) return 'voted';
  const srv = server ? server.get(d.key) : undefined;
  const listed = server ? srv?.state : d.persons.map((p) => kept?.byPerson.get(p.id)).find(Boolean);
  if (listed === 'done') return 'done';
  const mine = d.persons.map((p) => knocks?.[p.id]).filter(Boolean);
  if (mine.length) return mine.some((k) => TERMINAL.includes(k.outcome)) ? 'done' : 'again';
  if (listed && listed !== 'open') return listed;
  if (server ? srv?.in_round === false : kept?.off.has(d.key)) return 'off';
  return 'open';
};

export const firstToKnock = (doors, stateOf) => {
  const list = doors || [];
  return list.find((d) => stateOf(d) === 'open') || list.find((d) => stateOf(d) === 'again') || list[0] || null;
};
