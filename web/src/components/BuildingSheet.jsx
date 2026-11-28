// The building sheet (HR-1): a tower, a walk-up, a townhouse complex or a
// triplex — an address with 3 or more numbered or lettered units
// (shared/units.js placeOf) — opened from its square on the map. Its floors, then its units, each with who lives there
// and whether they're done; "Next unit" opens the next one's door card
// (today's DoorCard, with a bar back here), unit by unit.
//
// It sits in the door card's slot (the bottom sheet on a phone, the side
// panel on the desk). The URL carries ?building=<person id> (the anchor:
// never an address), and &person=<id> while a unit is open.
//
// What it shows, in order of trust:
//   - the server's building (GET /api/buildings/of/:id, under ['turf', …]
//     so a refresh after a knock reads it again), with the phone's own
//     knocks still in the outbox laid over it as the walk list does;
//   - with no signal and no answer: the building out of a walk list kept on
//     this phone ("Offline — from your walk list"), with its pass state;
//   - failing that, the doors the map holds ("Offline — showing what's on
//     the phone"): no done counts, nothing "left".
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, ApiError } from '../api.js';
import { pendingKnocks, useOutbox } from '../offline.js';
import { doorState, inPass } from '@base-win/shared/passes';
import { bandOf } from '@base-win/shared/scale';
import {
  buildingOf, floorLabel, floorsShown, nextDoor, unitOf, unitRows, unitStops,
} from '@base-win/shared/buildings';
import { doorKey, doorParts, unitKind, unitWords } from '../../../shared/units.js';
import { overlayPass, waitingTries } from './PassBits.jsx';
import { pendingVoted } from './Voted.jsx';
import { usePracticeOverlay } from './GotvLive.js';
import { Directions } from './DoorCard.jsx';
import { More } from './RatingButtons.jsx';
import { cachedWalkLists, keptWalkList } from '../pages/Turfs.jsx';
import './buildings.css';

export const buildingKey = (anchorId) => ['turf', 'building', anchorId];
export const GONE_LINE = 'This building isn’t here any more';
const NOT_MINE = 'Not on your turfs';

const num = (n) => Number(n || 0).toLocaleString('en-CA');
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
// The states in the words every screen uses (UNITS.md §6).
const STATE_WORD = { open: 'Not knocked', again: 'Try again', done: 'Done ✓' };

// A person row of the walk list or the map, with the door's place on it
// (the map's door model reads each person's address, unit and pin).
const placed = (d) => d.persons.map((p) => ({
  address: d.address, unit: d.unit, city: d.city ?? null, lat: d.lat, lng: d.lng, ...p,
}));

// A building as the walk list's server worked it out: its doors on the
// list (those its round wants) and its whole count of units.
const keptBuilding = (list, door) => {
  const doors = list.filter((d) => d.group === door.group);
  return {
    key: door.group, address: doorParts(door).shown || door.address, city: door.city ?? null,
    lat: door.lat, lng: door.lng, units: door.units ?? doors.length, doors,
    people: doors.reduce((n, d) => n + (d.persons?.length || 0), 0),
  };
};

// The building out of a walk list kept on this phone: the one holding the
// anchor, its doors as the list had them (every one on the round).
const fromKeptWalkLists = (me, anchorId) => {
  for (const { id } of cachedWalkLists(me)) {
    const kept = keptWalkList(me, id);
    const list = kept?.data?.doors || [];
    const door = list.find((d) => d.persons?.some((p) => p.id === anchorId));
    if (!door) continue;
    // The server said which building each door is in, before its round left
    // any unit out (a tower the round thinned to two units is still one);
    // a list kept by an older version is grouped here.
    const b = door.place === 'building' && door.group != null ? keptBuilding(list, door) : buildingOf(list, door);
    if (!b) return null;
    return { b, pass: kept.data.pass || null, at: kept.at };
  }
  return null;
};

// Everything the sheet and the door card inside it need, worked out once:
// Map.jsx calls this and hands it to both.
//   anchorId   the person the building was opened from
//   mapDoors   the map's own doors (the last fallback, and to find the anchor)
//   showsDoor  the map's filter, on a door of the building (true: shown)
//   sent       knocks sent from the card since the building loaded, by person
export function useBuilding({ anchorId, me, online, mapDoors, showsDoor, filterOn, sent }) {
  const queryClient = useQueryClient();
  const outbox = useOutbox();
  // GOTV practice marks live only in this overlay, never in the query copy
  // (GotvLive): laid over voted_at as the walk list and the map do.
  const practiced = usePracticeOverlay();
  const q = useQuery({
    queryKey: buildingKey(anchorId),
    // The pin the sheet showed rides along: a person who has moved away
    // from it no longer opens it (the server says it isn't here any more).
    queryFn: () => {
      const was = queryClient.getQueryData(buildingKey(anchorId))?.building;
      return apiGet(`/buildings/of/${encodeURIComponent(anchorId)}${was?.lat != null ? `?was=${was.lat},${was.lng}` : ''}`);
    },
    enabled: Boolean(anchorId),
    retry: (n, err) => !(err?.status >= 400 && err.status < 500) && n < 1,
    staleTime: 15_000,
  });
  const refusal = q.error instanceof ApiError && q.error.status === 404
    ? (q.error.body?.gone ? 'gone' : 'notMine') : null;

  return useMemo(() => {
    if (!anchorId) return null;
    const data = q.data;
    if (refusal) return { status: refusal, refetch: q.refetch };
    if (data?.truncated) return { status: 'big', address: data.building?.address || '', refetch: q.refetch };
    if (data && !data.building) return { status: 'none', refetch: q.refetch };

    let source = null;
    if (data?.building) {
      source = { kind: 'server', b: data.building, doors: data.doors, pass: data.pass, at: q.dataUpdatedAt };
    } else if (!online || (q.isError && !(q.error instanceof ApiError))) {
      const kept = fromKeptWalkLists(me, anchorId);
      if (kept) {
        source = {
          kind: 'walk',
          b: { ...kept.b, floors: floorsShown(kept.b.doors.map(unitOf)) },
          doors: kept.b.doors.map((d) => ({ ...d, persons: placed(d) })),
          pass: kept.pass,
          at: kept.at,
        };
      } else {
        const door = mapDoors.find((d) => d.persons.some((p) => p.id === anchorId));
        const b = door ? buildingOf(mapDoors, door) : null;
        if (b) {
          source = {
            kind: 'phone',
            b: { ...b, floors: floorsShown(b.doors.map(unitOf)) },
            doors: b.doors.map((d) => ({ address: d.address, unit: d.unit, lat: d.lat, lng: d.lng, persons: d.persons, signs: d.signs })),
            pass: null,
            at: 0,
          };
        }
      }
    }
    if (!source) {
      if (q.isError || (!online && !data)) return { status: 'failed', refetch: q.refetch };
      return { status: 'loading', refetch: q.refetch };
    }

    // The phone's own knocks first: still in the outbox, or sent from the
    // card since this building loaded — laid over each door exactly as the
    // walk list does, so "left" and Next unit move at once, signal or not.
    const { pass, at } = source;
    const local = { ...sent, ...pendingKnocks(outbox.items) };
    const waiting = waitingTries(outbox.items, pass);
    const votes = pendingVoted(outbox.items);
    const counted = source.kind !== 'phone';
    const doors = source.doors.map((d) => {
      const persons = d.persons.map((p) => (votes[p.id]
        ? { ...p, voted_at: votes[p.id].voted ? votes[p.id].at || p.voted_at || new Date().toISOString() : null }
        : practiced.has(p.id) ? { ...p, voted_at: practiced.get(p.id) || null } : p));
      const laid = pass ? overlayPass({ ...d, persons }, local, pass, at, waiting) : persons;
      const state = !counted ? 'open'
        : pass ? (inPass({ persons: laid }, pass) ? doorState({ ...d, persons: laid }, pass) : 'done')
          : (d.done || persons.some((p) => local[p.id]) ? 'done' : 'open');
      return { ...d, persons: laid, state, in_round: d.in_round !== false };
    });
    const rows = unitRows({ doors });
    // The map's filter, on the building's own doors: the rows it shows.
    const shownRows = filterOn ? rows.filter((r) => r.doors.some(showsDoor)) : rows;
    // What Next unit walks: each door on this round (a unit written two
    // ways is two doors, so its second door's people are reached too).
    const walk = unitStops(shownRows).filter((s) => !filterOn || showsDoor(s.door));
    const left = counted ? rows.filter((r) => r.in_round && r.state !== 'done').length : null;
    const b = source.b;
    return {
      status: 'ready',
      source: source.kind,
      counted,
      address: b.address,
      city: b.city,
      lat: b.lat,
      lng: b.lng,
      units: b.units,
      floors: Boolean(b.floors),
      rows,
      shownRows,
      walk,
      left,
      pass,
      refetch: q.refetch,
    };
  }, [anchorId, q.data, q.dataUpdatedAt, q.isError, q.error, q.refetch, refusal, online, me, mapDoors, showsDoor, filterOn, sent, outbox.items, practiced]);
}

// The next door to knock, after the door `doorKeyNow` (or from the top):
// the walk list's own rule (nextDoor), over the doors on this round that
// the map's filter shows — a stop { row, door, unit, floor }. null: every
// unit is done.
export const nextUnit = (bld, doorKeyNow = null) => {
  if (!bld?.walk?.length) return null;
  const from = doorKeyNow ? bld.walk.findIndex((s) => mapDoorKey(s.door) === doorKeyNow) : -1;
  const i = nextDoor(bld.walk, from);
  return i >= 0 ? bld.walk[i] : null;
};
// A door's key, the one way the map, the building sheet and the "Mine"
// filter all write it (shared/units.js doorKey: "Main" and blank are one
// door, "1203-13450 104 Ave" and 13450 104 Ave unit 1203 are one); a pin
// with no address is its spot.
export const spotKey = (d) => `@${Number(d.lat).toFixed(5)},${Number(d.lng).toFixed(5)}`;
export const mapDoorKey = (d) => doorKey(d, { none: spotKey });
// A unit row's words: "Unit 1203", "No unit number", "Basement suite".
export const rowWords = (row) => (row ? unitWords(row.unit, 'building') : '');
// What the unit column (and "Next unit · 202") shows: the number itself
// (bold mono) for a numbered or lettered unit, else the words.
export const rowMark = (row) => (['unit', 'letter'].includes(unitKind(row.unit)) ? row.unit : unitWords(row.unit, 'building'));

function Bar({ done, total }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return <span className="bldg-bar" aria-hidden="true"><span className="bldg-bar__fill" style={{ width: `${pct}%` }} /></span>;
}

const rowBand = (row) => {
  const bands = row.persons.map((p) => bandOf(p.rating));
  return bands.includes('opposed') ? 'opposed' : bands.includes('support') ? 'support' : bands.includes('undecided') ? 'undecided' : 'unrated';
};
const allVoted = (row) => row.persons.length > 0 && row.persons.every((p) => p.voted_at);
const stateOf = (row, counted) => {
  if (!row.in_round) return { word: 'Not on this round', cls: 'bldg-chip--off' };
  if (allVoted(row)) return { word: 'Voted ✓', cls: 'chip-ok' };
  if (!counted) return null;
  return { word: STATE_WORD[row.state] || STATE_WORD.open, cls: row.state === 'done' ? 'chip-ok' : row.state === 'again' ? 'fk-wait' : '' };
};

function UnitRow({ row, counted, onOpen }) {
  const first = row.persons[0];
  const who = first ? `${firstName(first.name)}${row.persons.length > 1 ? ` +${row.persons.length - 1}` : ''}` : 'Nobody on file';
  const st = stateOf(row, counted);
  const label = `${rowWords(row)}, ${who.replace(/\+(\d+)$/, 'and $1 more')}${st ? `, ${st.word.replace(' ✓', '')}` : ''}`;
  const mark = rowMark(row);
  const numbered = mark === row.unit;
  return (
    <li>
      <button type="button" className="bldg-unit" onClick={() => onOpen(row)} aria-label={label}>
        <span className={`bldg-unit__no${numbered ? ' mono' : ' bldg-unit__no--words'}`}>{mark}</span>
        <span className="bldg-unit__who">{who}</span>
        <span className={`bldg-dot bldg-dot--${rowBand(row)}`} aria-hidden="true" />
        {st && <span className={`chip bldg-chip ${st.cls}`}>{st.word}</span>}
      </button>
    </li>
  );
}

// The sheet. hidden: a unit's door card is open over it (it stays mounted,
// so its floors and scroll are as they were when the card's ‹ comes back).
export default function BuildingSheet({ bld, hidden, filterLabel, onOpen, onClose }) {
  const scrollRef = useRef(null);
  const scrollAt = useRef(0);
  const [openFloors, setOpenFloors] = useState(null); // null: only the next unit's floor
  const [more, setMore] = useState(false);
  useLayoutEffect(() => {
    if (!hidden && scrollRef.current) scrollRef.current.scrollTop = scrollAt.current;
  }, [hidden]);
  const next = bld?.status === 'ready' ? nextUnit(bld) : null;
  const floors = useMemo(() => {
    if (bld?.status !== 'ready' || !bld.floors) return null;
    const out = [];
    for (const r of bld.shownRows) {
      const last = out[out.length - 1];
      if (last && last.floor === r.floor) last.rows.push(r);
      else out.push({ floor: r.floor, rows: [r] });
    }
    return out;
  }, [bld]);
  // A floor heading's own "3 left" (with no counts: how many units).
  const floorLine = (f) => {
    if (!bld.counted) return `${floorLabel(f.floor)} · ${num(f.rows.length)} ${f.rows.length === 1 ? 'unit' : 'units'}`;
    // (A floor nobody on it is wanted by this round isn't "done": nobody knocked.)
    if (!f.rows.some((r) => r.in_round)) return `${floorLabel(f.floor)} · not on this round`;
    const left = f.rows.filter((r) => r.in_round && r.state !== 'done').length;
    return `${floorLabel(f.floor)} · ${left ? `${num(left)} left` : 'done'}`;
  };
  const isOpen = (f) => (openFloors ? openFloors.has(f.floor) : next ? next.floor === f.floor : f === floors[0]);
  const toggle = (f) => {
    const now = new Set(floors.filter(isOpen).map((x) => x.floor));
    if (now.has(f.floor)) now.delete(f.floor); else now.add(f.floor);
    setOpenFloors(now);
  };

  let body;
  if (!bld || bld.status === 'loading') body = <p className="bldg-line muted" role="status">Loading…</p>;
  else if (bld.status === 'failed') {
    body = (
      <p className="bldg-line" role="status">
        Unavailable — <button type="button" className="fk-link" onClick={() => bld.refetch()}>Try again</button>
      </p>
    );
  } else if (bld.status === 'notMine') body = <p className="bldg-line" role="status">{NOT_MINE}</p>;
  else if (bld.status === 'gone') body = <p className="bldg-line" role="status">{GONE_LINE}</p>;
  else if (bld.status === 'big') body = <p className="bldg-line" role="status">Too big to list here — use the walk list</p>;
  else if (bld.status === 'ready') {
    const rows = bld.shownRows;
    body = (
      <>
        <div className="bldg-count">
          {/* The units are said once, in the subtitle; here what is left. */}
          {bld.counted && <p className="bldg-count__line" aria-live="polite">{num(bld.left)} left</p>}
          {bld.counted && <Bar done={bld.rows.filter((r) => r.in_round).length - bld.left} total={bld.rows.filter((r) => r.in_round).length} />}
          {bld.source === 'walk' && <span className="chip fk-wait bldg-offline">Offline — from your walk list</span>}
          {bld.source === 'phone' && <span className="chip fk-wait bldg-offline">Offline — showing what’s on the phone</span>}
        </div>
        {filterLabel && rows.length !== bld.rows.length && (
          <p className="bldg-filter muted">Showing: {filterLabel} · {num(rows.length)} of {num(bld.units)}</p>
        )}
        {floors ? (
          <div className="bldg-floors">
            {floors.map((f) => {
              const open = isOpen(f);
              const id = `bldg-floor-${String(f.floor)}`;
              return (
                <section key={String(f.floor)} className="bldg-floor">
                  <button type="button" className="bldg-floor__head" aria-expanded={open} aria-controls={id} onClick={() => toggle(f)}>
                    <span>{floorLine(f)}</span>
                    <span className="bldg-floor__chev" aria-hidden="true">{open ? '▾' : '▸'}</span>
                  </button>
                  {open && (
                    <ul className="bldg-units" id={id}>
                      {f.rows.map((r) => <UnitRow key={r.unit} row={r} counted={bld.counted} onOpen={onOpen} />)}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        ) : (
          <ul className="bldg-units bldg-units--flat">
            {rows.map((r) => <UnitRow key={r.unit} row={r} counted={bld.counted} onOpen={onOpen} />)}
          </ul>
        )}
        <More id="bldg-more" open={more} onToggle={() => setMore((m) => !m)}>
          <div className="door-more__row">
            <Directions to={{ lat: bld.lat, lng: bld.lng, address: bld.address, city: bld.city }} words={bld.address} mode="walking" className="btn door-act" />
          </div>
        </More>
        <div className="bldg-dock">
          {next ? (
            <button type="button" className="btn btn-primary bldg-next" onClick={() => onOpen(next)}>
              Next unit · {rowMark(next.row)}
            </button>
          ) : bld.counted ? <p className="bldg-line" role="status">Every unit is done</p> : null}
        </div>
      </>
    );
  }

  const title = bld?.status === 'ready' ? bld.address : bld?.status === 'big' ? bld.address || 'Building' : 'Building';
  return (
    <div className="map-sheet bldg-sheet" hidden={hidden} ref={scrollRef}
      onScroll={(e) => { if (!hidden) scrollAt.current = e.currentTarget.scrollTop; }}>
      <aside className="door-card" aria-label={`Building: ${title}`}>
        <header className="mapsheet-head">
          <div className="door-head">
            <h2 className="mapsheet-title door-head__name">{title}</h2>
            <span className="door-head__addr door-head__place">{bld?.status === 'ready' ? `Building · ${num(bld.units)} ${bld.units === 1 ? 'unit' : 'units'}` : 'Building'}</span>
          </div>
          <button type="button" className="btn btn-quiet mapsheet-close" onClick={onClose} aria-label="Close building">✕</button>
        </header>
        <div className="bldg-body">{body}</div>
      </aside>
    </div>
  );
}

// The thin bar over a unit's door card: back to the building, at the same place.
export function BuildingBar({ label, onBack }) {
  return (
    <button type="button" className="bldg-back" onClick={onBack} aria-label={`Back to the building: ${label}`}>
      <span aria-hidden="true">‹</span> <span className="bldg-back__text">{label}</span>
    </button>
  );
}

// "13450 104 Ave · Floor 12 · Unit 1203"
export const unitLine = (bld, row) => [bld?.address, bld?.floors && row ? floorLabel(row.floor) : null, row ? rowWords(row) : null].filter(Boolean).join(' · ');

// The door a unit row's tap opens: its first door on this round that isn't
// done (a unit written two ways: the one still to knock), else its first.
const doorToOpen = (row) => row.doors.find((d) => d.in_round !== false && d.state !== 'done')
  || row.doors.find((d) => d.in_round !== false) || row.doors[0];

// Before a unit's card opens, its door is put where the map looks for a
// person's door (as a tapped dot does), so it opens at once, signal or not.
// target: a unit row (a tap on it) or a stop of Next unit (its own door).
export const seedDoor = (queryClient, target) => {
  const d = target.door || doorToOpen(target);
  const first = d?.persons?.[0];
  if (!first) return null;
  queryClient.setQueryData(['doors', 'door', first.id], (was) => was || { persons: placed(d), signs: d.signs || [], scope: 'door' });
  return first.id;
};
