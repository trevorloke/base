// Shifts → Week (desk only): the one place to schedule.
//
// Seven days across (one day at a time on a phone, with a day strip), each
// a LIST of its shifts in start order from 6 am — any number of them — with
// a quiet divider where each part of the day begins: Early · Morning ·
// Afternoon · Evening (shared/dayparts.js WEEK_PARTS, on the campaign's
// clock). A card shows what the shift is (its kind's mark and colour,
// shared/shiftkinds.js), where, when, and who is on it.
//
// Making and changing shifts never leaves this screen:
//   "+" on a day (or "New shift")  the add sheet (ScheduleAdd.jsx): what,
//                                  where, which days, when — all by tap.
//                                  ?add=<day> in the address opens it.
//   tap a card                     its sheet (ScheduleShift.jsx): another
//                                  day, time or place, tell them, call off.
//   drag a card to another day     moves that one shift (shift.update);
//                                  the toast offers Undo — or "Tell them"
//                                  when people are on it.
//   "More"                         the whole week (ScheduleWeek.jsx): tell
//                                  everyone, reminders, copy to next week.
//   an empty week                  "Copy last week", when last week had any.
//
// Volunteers sit in a tray beside the week (search, role filter). Put
// someone on a shift by dragging a name onto a card (mouse, pen, or touch:
// press and hold, then drag), or by tapping (or Enter on) a name and then a
// card. Dragging a chip to another card moves them (on there, then off the
// old one); dragging it back to the tray, or its ×, takes them off. Someone
// already on an overlapping shift this week gets "Sam is already on … Add
// anyway? Yes · No".
//
// Honest states: a week that hasn't loaded says "Loading…" and one that
// can't says "Unavailable — Try again" — never a week of empty days.
// Needs signal: offline the list shows instead (Shifts.jsx).
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { VOLUNTEER_ROLES } from '@starbase/shared/canvass';
import {
  WEEK_PARTS, addDays, clockOf, dayOf, instantOf, isDay, safeZone, weekBounds, weekPartOf, weekStart,
} from '@starbase/shared/dayparts';
import { apiGet, action } from '../api.js';
import { NeedsSignalLine, useOnline } from '../components/NoSignal.jsx';
import { KindIcon, cardWords, kindVars } from '../components/ShiftKind.jsx';
import { TurfChips, useShiftTurfs } from '../components/ShiftTurfs.jsx';
import ScheduleAdd from './ScheduleAdd.jsx';
import ScheduleShift from './ScheduleShift.jsx';
import { Unavailable } from './ScheduleSheet.jsx';
import WeekMore, { CopyLastWeek, noticeGoing, weekKey, weekWords } from './ScheduleWeek.jsx';
import { countWords, dayWords, peopleWords, plural, shiftSpan } from './ScheduleWords.js';
import './shifts-board.css';
import './schedule.css';

const roleLabel = (code) => VOLUNTEER_ROLES.find((r) => r.code === code)?.label ?? code;
const firstName = (name) => String(name || '').split(' ')[0];
// "Sam O." — chips are small; the full name is in the label.
const shortName = (name) => {
  const parts = String(name || '').trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
};

// For "already on a shift then": a shift with no end counts as an hour.
const span = (s) => {
  const a = new Date(s.starts_at).getTime();
  const b = s.ends_at ? new Date(s.ends_at).getTime() : a + 3600e3;
  return [a, Math.max(b, a + 1)];
};
const overlaps = (x, y) => { const [a1, b1] = span(x); const [a2, b2] = span(y); return a1 < b2 && a2 < b1; };
const hasRoom = (s) => !s.capacity || (Number(s.filled) || 0) < s.capacity;
const daysApart = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
// The same shift on another day: its own clock times, both ends (as the
// server moves it — shift.update's `day`).
const onDay = (s, day, tz) => {
  const from = dayOf(s.starts_at, tz);
  return {
    starts_at: instantOf(day, clockOf(s.starts_at, tz), tz),
    ends_at: s.ends_at ? instantOf(addDays(day, daysApart(from, dayOf(s.ends_at, tz))), clockOf(s.ends_at, tz), tz) : null,
  };
};

function useNarrow(query = '(max-width: 720px)') {
  const get = () => typeof window !== 'undefined' && window.matchMedia?.(query).matches;
  const [narrow, setNarrow] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return undefined;
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return narrow;
}

// What a drop landed on, read off the element under the pointer: a person
// goes on a shift's card (or back to the tray); a card goes to a day — its
// column, or on a phone its button in the day strip.
const targetAt = (x, y, item) => {
  const under = document.elementFromPoint(x, y);
  if (item?.shift) {
    const el = under?.closest?.('[data-day]');
    return el ? { kind: 'day', day: el.dataset.day, key: `day:${el.dataset.day}` } : null;
  }
  const el = under?.closest?.('[data-drop]');
  if (!el) return null;
  const kind = el.dataset.drop;
  if (kind === 'shift') return { kind, shiftId: el.dataset.shift, key: `shift:${el.dataset.shift}` };
  if (kind === 'tray') return { kind, key: 'tray' };
  return null;
};

export default function ShiftsBoard({ me, onSheet }) {
  const queryClient = useQueryClient();
  const online = useOnline();
  const narrow = useNarrow();
  const moreId = useId();
  const [params, setParams] = useSearchParams();
  const tz = safeZone(me?.workspace?.settings?.tz);
  const today = dayOf(new Date(), tz);
  const thisWeek = weekStart(today);
  const monday = isDay(params.get('week')) ? weekStart(params.get('week')) : thisWeek;
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(monday, i)), [monday]);
  const { from, to } = weekBounds(monday, tz);
  const boardKey = ['shifts', 'board', monday, tz];
  const readBoard = (m) => {
    const b = weekBounds(m, tz);
    return apiGet(`/shifts/board?from=${encodeURIComponent(b.from)}&to=${encodeURIComponent(b.to)}`);
  };
  const board = useQuery({
    queryKey: boardKey,
    queryFn: () => apiGet(`/shifts/board?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    placeholderData: keepPreviousData,
  });
  const { byShift: turfsByShift, ready: turfsReady, failed: turfsFailed } = useShiftTurfs(me, { side: true });
  // The week's notice, reminders and what is connected (ScheduleWeek.jsx).
  const week = useQuery({
    queryKey: weekKey(monday),
    queryFn: () => apiGet(`/schedule/week?week=${monday}`),
    meta: { side: true },
    // A notice going out: watched until everyone has their answer.
    refetchInterval: (q) => (noticeGoing(q.state.data?.last) ? 2000 : false),
  });

  const setParam = (name, value) => setParams((cur) => {
    const next = new URLSearchParams(cur);
    if (value == null) next.delete(name); else next.set(name, value);
    return next;
  }, { replace: true });
  const goWeek = (m) => setParam('week', m === thisWeek ? null : m);

  // Phone: one day at a time — today when it's in this week, else Monday.
  const [phoneDay, setPhoneDay] = useState(null);
  const shownDay = phoneDay && days.includes(phoneDay) ? phoneDay : (days.includes(today) ? today : monday);
  const shownDays = narrow ? [shownDay] : days;

  // ── What's on the week ──
  // board.data may still be the week just left (kept so the tray stays put
  // while the next one loads): its shifts are never drawn as this week's.
  const have = board.data !== undefined && !board.isPlaceholderData;
  const shifts = have ? board.data.shifts : [];
  const assignments = have ? board.data.assignments : [];
  const peopleAll = board.data?.people ?? [];
  const { byDay, byId, onShift, weekCount } = useMemo(() => {
    const perDay = new Map();
    const ids = new Map();
    for (const s of shifts) {
      ids.set(s.id, s);
      const d = dayOf(s.starts_at, tz);
      if (!perDay.has(d)) perDay.set(d, []);
      perDay.get(d).push(s);
    }
    for (const list of perDay.values()) list.sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at) || a.title.localeCompare(b.title));
    const on = new Map();
    const count = new Map();
    for (const a of assignments) {
      if (!on.has(a.shift_id)) on.set(a.shift_id, []);
      on.get(a.shift_id).push(a);
      count.set(a.person_id, (count.get(a.person_id) || 0) + 1);
    }
    return { byDay: perDay, byId: ids, onShift: on, weekCount: count };
  }, [shifts, assignments, tz]);
  const emptyWeek = have && shifts.length === 0;
  const pastWeek = days[6] < today;
  // An empty week offers last week's shifts — when last week had any.
  const lastWeek = useQuery({
    queryKey: ['shifts', 'board', addDays(monday, -7), tz],
    queryFn: () => readBoard(addDays(monday, -7)),
    enabled: emptyWeek && !pastWeek,
  });

  // ── Tray: search + role ──
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const rolesHere = useMemo(() => {
    const set = new Set(peopleAll.flatMap((p) => p.roles || []));
    return VOLUNTEER_ROLES.filter((r) => set.has(r.code));
  }, [peopleAll]);
  const needle = q.trim().toLowerCase();
  const tray = peopleAll.filter((p) => (!role || (p.roles || []).includes(role))
    && (!needle || p.name.toLowerCase().includes(needle)));
  // Typing a name that isn't a volunteer yet: anyone on the list, like the
  // shift screen's "+ Add volunteer".
  const others = useQuery({
    queryKey: ['persons', 'search', needle],
    queryFn: () => apiGet(`/persons?q=${encodeURIComponent(needle)}&limit=8`),
    enabled: needle.length >= 2,
    placeholderData: keepPreviousData,
  });
  const trayIds = new Set(peopleAll.map((p) => p.id));
  const extra = needle.length >= 2 ? (others.data?.persons ?? []).filter((p) => !trayIds.has(p.id)).slice(0, 8) : [];

  // ── In hand: a person ({ person, from? }) or a card ({ shift }) being
  // dragged; a person may also be picked up by a tap / Enter ──
  const [picked, setPicked] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [overKey, setOverKey] = useState(null);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState(null);   // { item, shift, clash }: already on a shift then
  const [note, setNote] = useState(null); // { text, act?: { label, run } }
  const [error, setError] = useState(null);
  const [more, setMore] = useState(false);
  // The card whose sheet is open: { id, tell } (tell: straight to "Tell them").
  const [open, setOpen] = useState(null);
  const noteTimer = useRef(null);
  const say = (n) => {
    clearTimeout(noteTimer.current);
    setNote(n);
    if (n) noteTimer.current = setTimeout(() => setNote(null), n.act ? 9000 : 6000);
  };
  useEffect(() => () => clearTimeout(noteTimer.current), []);

  // The add sheet is in the address (?add=<day>, or ?add=1 from "New
  // shift"), so the page's own button and a link can open it.
  const addParam = params.get('add');
  const adding = addParam != null && online;
  const addDay = isDay(addParam) && days.includes(addParam) ? addParam : (narrow ? shownDay : days.includes(today) ? today : null);
  // A card's sheet waits for its turfs: it changes them from what they are
  // (and leaves them alone when they can't be read).
  const openShift = open && (turfsReady || turfsFailed) && byId.get(open.id);
  // While a sheet is open its button is the one main button (Shifts.jsx).
  const sheetOpen = adding || Boolean(openShift);
  // (And the last toast goes: it would sit over that button.)
  useEffect(() => { onSheet?.(sheetOpen); if (sheetOpen) say(null); }, [sheetOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  // Nothing can be added to a week that is over: "New shift" there is this week's.
  useEffect(() => { if (adding && days[6] < today) setParam('week', null); }, [adding, monday]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onSheet?.(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = (shiftIds = []) => {
    queryClient.invalidateQueries({ queryKey: ['shifts'] });
    for (const id of shiftIds) queryClient.invalidateQueries({ queryKey: ['shift', id] });
    queryClient.invalidateQueries({ queryKey: ['brief'] });
    queryClient.invalidateQueries({ queryKey: ['person'] });
    queryClient.invalidateQueries({ queryKey: ['schedule'] });
  };
  // Shifts made, moved or called off: their turfs, places and the roster too.
  const refreshAll = () => {
    refresh();
    queryClient.invalidateQueries({ queryKey: ['shiftturfs'] });
    queryClient.invalidateQueries({ queryKey: ['places'] });
    queryClient.invalidateQueries({ queryKey: ['volunteers'] });
  };

  // Optimistic: the chip or card moves now; on a "no" the week goes back.
  const patch = (fn) => {
    const prev = queryClient.getQueryData(boardKey);
    queryClient.setQueryData(boardKey, (cur) => (cur ? fn(cur) : cur));
    return () => queryClient.setQueryData(boardKey, prev);
  };
  const withChip = (cur, shiftId, person, id) => ({
    ...cur,
    shifts: cur.shifts.map((s) => (s.id === shiftId ? { ...s, filled: (Number(s.filled) || 0) + 1 } : s)),
    assignments: [...cur.assignments, { id, shift_id: shiftId, person_id: person.id, name: person.name, status: 'assigned' }],
  });
  const withoutChip = (cur, assignmentId) => {
    const a = cur.assignments.find((x) => x.id === assignmentId);
    if (!a) return cur;
    return {
      ...cur,
      shifts: cur.shifts.map((s) => (s.id === a.shift_id ? { ...s, filled: Math.max(0, (Number(s.filled) || 0) - 1) } : s)),
      assignments: cur.assignments.filter((x) => x.id !== assignmentId),
    };
  };

  const assign = async (item, shift) => {
    const { person, from: src } = item;
    setError(null);
    setAsk(null);
    setPicked(null);
    setBusy(true);
    await queryClient.cancelQueries({ queryKey: boardKey });
    const undo = patch((cur) => {
      const next = withChip(cur, shift.id, person, `tmp-${Date.now()}`);
      return src ? withoutChip(next, src.assignmentId) : next;
    });
    const touched = [shift.id, src?.shiftId].filter(Boolean);
    try {
      // A move is "on the new one, then off the old one": a full or
      // refused new shift leaves them where they were.
      await action('shift.assign', { shift_id: shift.id, person_id: person.id });
      if (src) {
        try {
          await action('shift.unassign', { id: src.assignmentId });
        } catch (e) {
          setError(`${person.name} is on ${shift.title} — and still on ${byId.get(src.shiftId)?.title ?? 'the other shift'}: ${e.message}`);
          return;
        }
      }
      say({ text: src ? `${firstName(person.name)} moved to ${shift.title}` : `${firstName(person.name)} added to ${shift.title}` });
    } catch (e) {
      undo();
      setError(e.status === 409 ? `${person.name}: ${e.message}` : e.message);
    } finally {
      setBusy(false);
      refresh(touched);
    }
  };

  const remove = async (item, { undoable = true } = {}) => {
    const { person, from: src } = item;
    if (!src) return;
    setError(null);
    setAsk(null);
    setPicked(null);
    setBusy(true);
    await queryClient.cancelQueries({ queryKey: boardKey });
    const shift = byId.get(src.shiftId);
    const undo = patch((cur) => withoutChip(cur, src.assignmentId));
    try {
      await action('shift.unassign', { id: src.assignmentId });
      say({
        text: `${firstName(person.name)} off ${shift?.title ?? 'the shift'}`,
        act: undoable && shift ? { label: 'Undo', run: () => assign({ person }, shift) } : null,
      });
    } catch (e) {
      undo();
      setError(`${person.name}: ${e.message}`);
    } finally {
      setBusy(false);
      refresh([src.shiftId]);
    }
  };

  // Someone already on a shift that overlaps this one (not the one they're
  // moving off) — asked about before it's saved.
  const clashFor = (personId, shift, skipShiftId) => assignments
    .filter((a) => a.person_id === personId && a.shift_id !== shift.id && a.shift_id !== skipShiftId)
    .map((a) => byId.get(a.shift_id))
    .find((s) => s && overlaps(s, shift)) || null;

  const putOn = (item, shift) => {
    const name = firstName(item.person.name);
    if (item.from?.shiftId === shift.id) { setPicked(null); return; }
    if ((onShift.get(shift.id) ?? []).some((a) => a.person_id === item.person.id)) {
      setPicked(null);
      say({ text: `${name} is already on ${shift.title}` });
      return;
    }
    if (!hasRoom(shift)) { setPicked(null); say({ text: `${shift.title} is full` }); return; }
    const clash = clashFor(item.person.id, shift, item.from?.shiftId);
    if (clash) { setPicked(null); setAsk({ item, shift, clash }); return; }
    assign(item, shift);
  };

  // A card to another day: this one shift, the same hours. `back`: an Undo.
  const moveShift = async (shift, day, { back = false } = {}) => {
    const was = dayOf(shift.starts_at, tz);
    if (day === was) return;
    if (day < today) { say({ text: 'That day is over — pick today or later' }); return; }
    setError(null);
    setBusy(true);
    await queryClient.cancelQueries({ queryKey: boardKey });
    const undo = patch((cur) => ({ ...cur, shifts: cur.shifts.map((s) => (s.id === shift.id ? { ...s, ...onDay(s, day, tz) } : s)) }));
    const w = dayWords(day);
    const n = (onShift.get(shift.id) ?? []).length;
    try {
      await action('shift.update', { id: shift.id, day });
      const moved = { ...shift, ...onDay(shift, day, tz) };
      say({
        text: `${cardWords(shift).title} moved to ${w.wd}, ${w.md}${n ? ` — ${peopleWords(n)} ${n === 1 ? 'has' : 'have'} the old day` : ''}`,
        act: back ? null : n ? { label: 'Tell them', run: () => setOpen({ id: shift.id, tell: true }) }
          : { label: 'Undo', run: () => moveShift(moved, was, { back: true }) },
      });
    } catch (e) {
      undo();
      setError(e.message);
    } finally {
      setBusy(false);
      refresh([shift.id]);
    }
  };

  const dropOn = (item, target) => {
    if (!item || !target || busy) return;
    if (!online) { say({ text: 'Needs signal — nothing changed' }); return; }
    if (item.shift) { if (target.kind === 'day') moveShift(item.shift, target.day); return; }
    if (target.kind === 'tray') { if (item.from) remove(item); else setPicked(null); return; }
    const s = target.kind === 'shift' ? byId.get(target.shiftId) : null;
    if (s) putOn(item, s);
  };

  // ── Drag: pointer events (mouse, pen, touch). Mouse and pen pick up after
  // a few pixels; touch after a short press, so a swipe still scrolls. ──
  const drag = useRef(null);
  const ghost = useRef(null);
  const swallowClick = useRef(false);
  const dropRef = useRef(dropOn);
  dropRef.current = dropOn;
  const place = (x, y) => {
    if (ghost.current) ghost.current.style.transform = `translate(${x + 12}px, ${y + 12}px)`;
  };
  // Picked up: the ghost follows the pointer; near the top or bottom of the
  // screen the page scrolls so a card further down can be reached.
  const begin = (d) => {
    d.active = true;
    setDragging(d.item);
    setPicked(null);
    place(d.x, d.y);
    d.scroll = setInterval(() => {
      if (d.y < 56) window.scrollBy(0, -12);
      else if (d.y > window.innerHeight - 56) window.scrollBy(0, 12);
    }, 16);
    navigator.vibrate?.(10);
  };
  const beginRef = useRef(begin);
  beginRef.current = begin;

  useEffect(() => {
    const end = () => {
      const d = drag.current;
      if (!d) return;
      clearTimeout(d.timer);
      clearInterval(d.scroll);
      drag.current = null;
      setDragging(null);
      setOverKey(null);
    };
    const onMove = (e) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      const moved = Math.hypot(e.clientX - d.x0, e.clientY - d.y0);
      d.x = e.clientX;
      d.y = e.clientY;
      if (!d.active) {
        if (moved < 6) return;
        if (d.touch) { end(); return; } // moved before the press finished: a scroll
        beginRef.current(d);
      }
      if (ghost.current) ghost.current.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
      const t = targetAt(e.clientX, e.clientY, d.item);
      setOverKey(t?.key ?? null);
    };
    const onUp = (e) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      if (d.active) {
        swallowClick.current = true;
        setTimeout(() => { swallowClick.current = false; }, 0);
        const t = targetAt(e.clientX, e.clientY, d.item);
        const { item } = d;
        end();
        dropRef.current(item, t);
      } else end();
    };
    const onCancel = (e) => { if (drag.current && e.pointerId === drag.current.pointerId) end(); };
    // While a touch drag is on, the page must not scroll under the finger.
    const onTouchMove = (e) => { if (drag.current?.active) e.preventDefault(); };
    const onKey = (e) => { if (e.key === 'Escape') { end(); setPicked(null); } };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('keydown', onKey);
    return () => {
      end();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      document.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const grab = (item) => (e) => {
    if (!online || busy || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const d = {
      item, pointerId: e.pointerId, touch: e.pointerType === 'touch',
      x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, active: false,
    };
    clearTimeout(drag.current?.timer);
    drag.current = d;
    if (d.touch) {
      d.timer = setTimeout(() => { if (drag.current === d) begin(d); }, 280);
    }
  };
  // Tap / Enter: pick up, or put down if it's already in hand.
  const tapPerson = (item) => {
    if (swallowClick.current) return;
    setError(null);
    setPicked((cur) => (cur && cur.person.id === item.person.id && cur.from?.assignmentId === item.from?.assignmentId ? null : item));
  };
  // A card: with someone in hand it takes them; otherwise its sheet opens.
  const tapShift = (s) => {
    if (swallowClick.current) return;
    if (picked) dropOn(picked, { kind: 'shift', shiftId: s.id });
    else { setError(null); setOpen({ id: s.id, tell: false }); }
  };
  const dragProps = (item) => ({
    onPointerDown: grab(item),
    onContextMenu: (e) => e.preventDefault(),
    onClick: () => tapPerson(item),
    'aria-pressed': !!picked && picked.person.id === item.person.id && picked.from?.assignmentId === item.from?.assignmentId,
    disabled: !online,
  });
  const hot = (key) => (dragging && overKey === key ? '' : undefined);

  // ── What the sheets and the week's "More" hand back ──
  const closeAdd = () => setParam('add', null);
  const added = (res) => {
    closeAdd();
    const n = res.shifts.length;
    const here = res.shifts.filter((s) => days.includes(s.day)).length;
    const skipped = res.skipped.length;
    say({
      text: [
        n ? `${plural(n, 'shift')} added${here < n ? ` — ${here} this week` : ''}` : 'Nothing new to add',
        skipped ? `${skipped} already there` : null,
      ].filter(Boolean).join(' · '),
    });
    refreshAll();
  };
  const changed = (r) => {
    refreshAll();
    if (r.quiet) return;
    const id = open?.id;
    setOpen(null);
    say({ text: r.text, act: r.tell && id ? { label: 'Tell them', run: () => setOpen({ id, tell: true }) } : null });
  };
  const gone = (r) => { setOpen(null); say({ text: r.text }); refreshAll(); };
  const copied = (r) => {
    refreshAll();
    setMore(false);
    say({ text: r.text, act: r.to !== monday ? { label: 'Go there', run: () => goWeek(r.to) } : null });
  };

  // ── Render ──
  const personBtn = (p, isExtra = false) => {
    const item = { person: { id: p.id, name: p.name } };
    const n = weekCount.get(p.id) || 0;
    return (
      <li key={p.id}>
        <button type="button" className="sb-person" data-extra={isExtra ? '' : undefined} {...dragProps(item)}
          title={(p.roles || []).map(roleLabel).join(', ') || undefined}>
          <span className="sb-person__name">{p.name}</span>
          {n > 0 && <span className="sb-person__n" aria-label={`${n} this week`}>{n}</span>}
        </button>
      </li>
    );
  };

  const card = (s) => {
    const chips = onShift.get(s.id) ?? [];
    const filled = Number(s.filled) || 0;
    const full = !!s.capacity && filled >= s.capacity;
    const short = !full && !!s.need && filled < s.need;
    const words = cardWords(s);
    const over = new Date(s.ends_at || s.starts_at) < new Date();
    const label = `${s.title}, ${shiftSpan(s, tz)}, ${countWords(s)}`;
    return (
      <li key={s.id} className="sb-shift sch-card" style={kindVars(words.kind)} data-drop="shift" data-shift={s.id} data-kind={words.kind.code}
        data-hot={hot(`shift:${s.id}`)} data-full={full ? '' : undefined} data-over={over ? '' : undefined}
        data-lifted={dragging?.shift?.id === s.id ? '' : undefined}>
        <button type="button" className="sb-shift__head sch-card__head" aria-label={picked ? `Put ${picked.person.name} on ${label}` : `${label} — change it`}
          title={picked || over ? undefined : 'Change it — or drag it to another day'}
          onPointerDown={over ? undefined : grab({ shift: s })} onContextMenu={(e) => e.preventDefault()} onClick={() => tapShift(s)}>
          <span className="sch-card__kind"><KindIcon kind={words.kind} /></span>
          <span className="sb-shift__title sch-card__title">{words.title}</span>
          {words.place && <span className="sch-card__place">{words.place}</span>}
          <span className="sb-shift__meta sch-card__meta">
            <span className="sch-card__time">{shiftSpan(s, tz)}</span>
            <span className="sb-cap" data-full={full ? '' : undefined} data-short={short ? '' : undefined}>{countWords(s)}</span>
          </span>
        </button>
        <TurfChips turfs={turfsByShift[s.id]} label={`Turfs for ${s.title}`} card />
        {chips.length > 0 && (
          <ul className="sb-chips" aria-label={`On ${s.title}`}>
            {chips.map((a) => {
              const item = { person: { id: a.person_id, name: a.name }, from: { assignmentId: a.id, shiftId: s.id } };
              const temp = String(a.id).startsWith('tmp-');
              return (
                <li key={a.id} className="sb-chip" data-temp={temp ? '' : undefined}>
                  <button type="button" className="sb-chip__name" {...dragProps(item)} disabled={!online || temp}
                    aria-label={`${a.name} — move`} title={a.name}>
                    {shortName(a.name)}
                  </button>
                  <button type="button" className="sb-chip__x" aria-label={`Take ${a.name} off ${s.title}`}
                    disabled={!online || busy || temp} onClick={() => remove(item)}>×</button>
                </li>
              );
            })}
          </ul>
        )}
      </li>
    );
  };

  // A day: its heading with "+", then its shifts in start order, a quiet
  // divider where each part of the day begins.
  const dayColumn = (d) => {
    const w = dayWords(d);
    const list = byDay.get(d) ?? [];
    const past = d < today;
    return (
      <section key={d} className="sch-day" data-day={d} data-hot={hot(`day:${d}`)} data-past={past ? '' : undefined}
        data-today={d === today ? '' : undefined} aria-label={`${w.long}${list.length ? `, ${plural(list.length, 'shift')}` : ', no shifts'}`}>
        <header className="sch-day__head">
          <span className="sch-day__name">{narrow ? <><b>{w.long.split(',')[0]}</b> {w.md}</> : <><b>{w.wd}</b> {w.num}</>}</span>
          {!past && (
            <button type="button" className="sch-plus" aria-label={`Add a shift on ${w.long}`} title="Add a shift" disabled={!online}
              onClick={() => { setError(null); setParam('add', d); }}>
              +
            </button>
          )}
        </header>
        {WEEK_PARTS.map((p) => {
          const here = list.filter((s) => weekPartOf(s.starts_at, tz) === p.code);
          return here.length ? [
            <span key={`${p.code}:label`} className="sch-part" aria-hidden="true">{p.label}</span>,
            <ol key={p.code} className="sch-list" aria-label={`${p.label}, ${w.long}`}>{here.map(card)}</ol>,
          ] : null;
        })}
      </section>
    );
  };

  const ghostWords = dragging?.person?.name ?? (dragging?.shift ? cardWords(dragging.shift).title : '');
  const paused = board.fetchStatus === 'paused';

  return (
    <div className="sb sch" data-dragging={dragging ? '' : undefined}>
      <div className="sb-week sch-week" role="group" aria-label="Week">
        <button type="button" className="btn btn-quiet sb-nav" aria-label="Last week" onClick={() => goWeek(addDays(monday, -7))}>‹</button>
        <span className="sb-week__label">{weekWords(monday)}</span>
        <button type="button" className="btn btn-quiet sb-nav" aria-label="Next week" onClick={() => goWeek(addDays(monday, 7))}>›</button>
        {monday !== thisWeek && (
          <button type="button" className="btn btn-quiet sb-today" onClick={() => { setPhoneDay(null); goWeek(thisWeek); }}>This week</button>
        )}
        <button type="button" className="btn btn-quiet sb-today sch-week__more" aria-expanded={more} aria-controls={moreId}
          onClick={() => setMore((v) => !v)}>
          More
        </button>
      </div>

      {more && (
        <WeekMore id={moreId} monday={monday} tz={tz} week={week} count={have ? shifts.length : null}
          online={online} onCopied={copied} />
      )}

      {!online && <NeedsSignalLine>Scheduling needs signal</NeedsSignalLine>}

      {ask && (
        <div className="ops-confirm sb-ask" role="group" aria-label="Already on a shift then">
          <span>{firstName(ask.item.person.name)} is already on {ask.clash.title} ({shiftSpan(ask.clash, tz)}). Add anyway?</span>
          <button type="button" className="btn ops-solid ops-tap" disabled={busy} onClick={() => assign(ask.item, ask.shift)}>Yes</button>
          <button type="button" className="btn btn-quiet ops-tap" onClick={() => setAsk(null)}>No</button>
        </div>
      )}

      {error && <p className="error" role="alert">{error}</p>}

      <div className="sb-layout">
        <aside className="sb-tray" data-drop="tray" data-hot={hot('tray')} aria-label="Volunteers">
          <div className="sb-tray__find">
            <input className="input sb-search" type="search" placeholder="Find a volunteer" aria-label="Find a volunteer"
              value={q} onChange={(e) => setQ(e.target.value)} />
            {rolesHere.length > 0 && (
              <select className="input sb-role" aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="">Any role</option>
                {rolesHere.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
              </select>
            )}
          </div>
          {dragging?.from && <p className="sb-tray__drop">Drop here to take off the shift</p>}
          {board.data && tray.length === 0 && extra.length === 0 && (
            <p className="ops-meta sb-tray__none">
              {peopleAll.length === 0 && !needle ? <>No volunteers yet. <Link to="/people">Add roles in People</Link></> : 'No one matches.'}
            </p>
          )}
          <ul className="sb-people">
            {tray.map((p) => personBtn(p))}
            {extra.map((p) => personBtn(p, true))}
          </ul>
        </aside>

        <div className="sb-board">
          {picked && (
            <div className="sb-hand" role="status">
              <span><b>{picked.person.name}</b> — tap a shift</span>
              {picked.from && (
                <button type="button" className="btn btn-quiet sb-hand__btn" disabled={busy}
                  onClick={() => remove(picked)}>Take off</button>
              )}
              <button type="button" className="btn btn-quiet sb-hand__btn" onClick={() => setPicked(null)}>Cancel</button>
            </div>
          )}

          {narrow && (
            <div className="sb-days" role="group" aria-label="Day">
              {days.map((d) => {
                const w = dayWords(d);
                const n = (byDay.get(d) ?? []).length;
                return (
                  <button key={d} type="button" className="sb-day" aria-pressed={d === shownDay} data-today={d === today ? '' : undefined}
                    data-day={d} data-hot={hot(`day:${d}`)}
                    aria-label={`${w.long}${n ? `, ${plural(n, 'shift')}` : ''}`} onClick={() => setPhoneDay(d)}>
                    <span className="sb-day__wd">{w.wd}</span>
                    <span className="sb-day__n">{w.num}</span>
                    {n > 0 && <span className="sb-day__dot" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          )}

          {!have && !board.isError && <p className="muted sch-state" role="status">{paused ? 'Offline — loads with signal' : 'Loading…'}</p>}
          {board.isError && !have && <Unavailable onRetry={() => board.refetch()} />}
          {board.isError && have && <Unavailable what="The latest" onRetry={() => board.refetch()} />}

          {emptyWeek && (
            <div className="ops-empty-block sch-empty">
              <p className="ops-empty">{pastWeek ? 'No shifts that week.' : 'No shifts this week yet.'}</p>
              {!pastWeek && <CopyLastWeek monday={monday} last={lastWeek} online={online} onCopied={copied} />}
            </div>
          )}

          {have && (
            <div className="sch-days" data-narrow={narrow ? '' : undefined} style={{ '--sch-cols': shownDays.length }}>
              {shownDays.map(dayColumn)}
            </div>
          )}
        </div>
      </div>

      {/* Always in the page (hidden when idle) so it can be placed the moment a drag starts. */}
      <div className="sb-ghost" ref={ghost} aria-hidden="true" hidden={!dragging}>{ghostWords}</div>

      {note && (
        <div className="toast ops-toast sb-toast" data-plain={note.act ? undefined : ''} role="status">
          <span>{note.text}</span>
          {note.act && <button type="button" className="btn" disabled={busy} onClick={() => { const a = note.act; say(null); a.run(); }}>{note.act.label}</button>}
        </div>
      )}

      {adding && <ScheduleAdd me={me} days={days} today={today} day={addDay} onClose={closeAdd} onAdded={added} />}
      {openShift && (
        <ScheduleShift key={`${open.id}:${open.tell}`} me={me} shift={openShift} on={onShift.get(open.id) ?? []}
          turfs={turfsReady ? (turfsByShift[open.id] ?? []) : null}
          days={days} today={today} tz={tz} tell={open.tell} providers={week.data?.providers ?? null}
          onClose={() => setOpen(null)} onChanged={changed} onGone={gone} />
      )}
    </div>
  );
}
