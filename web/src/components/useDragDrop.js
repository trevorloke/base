// Drag and drop for boards, with the same feel as the week board
// (pages/ShiftsBoard.jsx): pointer events, so a mouse, a pen and a finger
// all work. A mouse or pen picks up after a few pixels; a finger after a
// short press-and-hold, so a swipe still scrolls the page. Near the top or
// bottom of the screen the page scrolls while dragging.
//
// Without dragging: tap (or Enter on) a card to pick it up, then tap where
// it goes — the board renders a "Move here" target per drop zone while
// something is picked. Escape puts it down.
//
// Drop zones are any elements with data-drop-key="…"; the key is what
// onDrop gets.
//
//   const dnd = useDragDrop({ onDrop: (item, key) => …, enabled });
//   <button {...dnd.itemProps(item, sameItem)} …>      a draggable card
//   <div data-drop-key="turf:…" data-over={dnd.over('turf:…')}>
//   <div ref={dnd.ghostRef} hidden={!dnd.dragging}>   follows the pointer
//   dnd.picked, dnd.setPicked, dnd.dropPicked(key)    the tap path
import { useCallback, useEffect, useRef, useState } from 'react';

const keyAt = (x, y) => document.elementFromPoint(x, y)?.closest?.('[data-drop-key]')?.dataset.dropKey ?? null;

export function useDragDrop({ onDrop, enabled = true, same = (a, b) => a?.id === b?.id }) {
  const [dragging, setDragging] = useState(null);
  const [overKey, setOverKey] = useState(null);
  const [picked, setPicked] = useState(null);
  const drag = useRef(null);
  const ghostRef = useRef(null);
  const swallow = useRef(false);
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;

  const moveGhost = (x, y) => {
    if (ghostRef.current) ghostRef.current.style.transform = `translate(${x + 14}px, ${y + 14}px)`;
  };
  const begin = useCallback((d) => {
    d.active = true;
    setDragging(d.item);
    setPicked(null);
    moveGhost(d.x, d.y);
    d.scroll = setInterval(() => {
      if (d.y < 56) window.scrollBy(0, -14);
      else if (d.y > window.innerHeight - 56) window.scrollBy(0, 14);
    }, 16);
    navigator.vibrate?.(10);
  }, []);
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
      d.x = e.clientX;
      d.y = e.clientY;
      if (!d.active) {
        if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 6) return;
        if (d.touch) { end(); return; } // moved before the press finished: a scroll
        beginRef.current(d);
      }
      moveGhost(e.clientX, e.clientY);
      setOverKey(keyAt(e.clientX, e.clientY));
    };
    const onUp = (e) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      if (!d.active) { end(); return; }
      swallow.current = true; // the click that follows a drop is not a tap
      setTimeout(() => { swallow.current = false; }, 0);
      const key = keyAt(e.clientX, e.clientY);
      const { item } = d;
      end();
      if (key) dropRef.current(item, key);
    };
    const onCancel = (e) => { if (drag.current && e.pointerId === drag.current.pointerId) end(); };
    // While a finger drags, the page must not scroll under it.
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
    if (!enabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const d = {
      item, pointerId: e.pointerId, touch: e.pointerType === 'touch',
      x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, active: false,
    };
    clearTimeout(drag.current?.timer);
    drag.current = d;
    if (d.touch) d.timer = setTimeout(() => { if (drag.current === d) beginRef.current(d); }, 280);
  };

  const itemProps = (item) => ({
    onPointerDown: grab(item),
    onContextMenu: (e) => { if (drag.current) e.preventDefault(); },
    onClick: () => {
      if (swallow.current || !enabled) return;
      setPicked((cur) => (cur && same(cur, item) ? null : item));
    },
    'aria-pressed': Boolean(picked && same(picked, item)),
    'data-dragging': dragging && same(dragging, item) ? '' : undefined,
  });

  // The tap path's second tap: put what's picked where it goes.
  const dropPicked = (key) => {
    if (swallow.current || !picked) return false;
    const item = picked;
    setPicked(null);
    dropRef.current(item, key);
    return true;
  };

  return {
    dragging, picked, setPicked, ghostRef, itemProps, dropPicked,
    over: (key) => (dragging && overKey === key ? '' : undefined),
  };
}
