// Put the cursor back right after a fill-in button ("+ First name") writes
// its words — as soon as React has written the new text, in the same step as
// the click. A requestAnimationFrame came a frame later, so a key pressed
// straight away (a fast typist, a slow phone) landed where the cursor had
// been before the words went in.
//
//   const putCaret = useCaret();
//   … setText(next); putCaret(textarea, at + word.length);
import { useCallback, useLayoutEffect, useRef } from 'react';

export function useCaret() {
  const pending = useRef(null);
  useLayoutEffect(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    p.el?.focus();
    p.el?.setSelectionRange?.(p.at, p.at);
  });
  return useCallback((el, at) => { pending.current = { el, at }; }, []);
}
