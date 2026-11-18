// A page's draft in the builder: what's typed, saved by itself a moment
// after the last change ("Saving…" · "Saved 2:14 pm"), one write to the page
// at a time, and Undo / Redo over this visit's changes (history.js).
//
//   const d = useDraft(id, page)   page: the page as read once (useSitePage)
//   d.draft · d.base (the page as the server last answered) · d.save
//   d.change(fn, key?)   fn(draft) → the next draft; key: the box typed in
//   d.flush() → saved?   d.inTurn(send) → send's answer, after any save
//   d.undo() · d.redo() · d.canUndo · d.canRedo · d.dirty() · d.stopped()
//   d.looseProblems
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { action } from '../../../api.js';
import { problemWords, problemsOf } from '../builder.js';
import { createHistory } from './history.js';

const SAVE_AFTER_MS = 800;

export function draftOf(p) {
  const d = p.draft || {};
  return {
    title: d.title || p.title || '', description: d.description ?? p.description ?? '',
    image: d.image || { url: '', alt: '' }, show_in_nav: Boolean(p.show_in_nav), modules: Array.isArray(d.modules) ? d.modules : [],
    check_first: d.checkFirst === true,
  };
}

export function useDraft(id, page, { onSaved } = {}) {
  const qc = useQueryClient();
  const [draft, setDraftState] = useState(null);
  const [base, setBase] = useState(null);
  const [save, setSave] = useState({ state: 'saved' });
  const [looseProblems, setLooseProblems] = useState([]);
  const [, setTick] = useState(0);
  const draftRef = useRef(null);
  const baseRef = useRef(null);
  const dirty = useRef(false);
  const timer = useRef(null);
  const inflight = useRef(null);
  const stopped = useRef(false); // someone else saved: no more autosaves until a reload
  const history = useRef(createHistory());
  const saved = useRef(onSaved);
  saved.current = onSaved;

  // The page as opened: once (later reads never overwrite what's typed).
  useEffect(() => {
    if (!page || baseRef.current?.id === page.id) return;
    const next = draftOf(page);
    draftRef.current = next;
    baseRef.current = page;
    setDraftState(next);
    setBase(page);
  }, [page]);

  const took = useCallback((p) => {
    baseRef.current = p;
    setBase(p);
    qc.setQueryData(['site-page', id], { page: p });
  }, [id, qc]);

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    while (inflight.current) await inflight.current;
    if (!dirty.current || stopped.current || !draftRef.current) return !stopped.current;
    const d = draftRef.current;
    if (!d.title.trim()) { setSave({ state: 'blocked', text: 'give the page a title' }); return false; }
    const loose = problemsOf(d.modules);
    setLooseProblems(loose);
    if (loose.length) { setSave({ state: 'blocked', text: problemWords(loose[0]) }); return false; }
    dirty.current = false;
    setSave({ state: 'saving' });
    const run = (async () => {
      try {
        const res = await action('site.page.save', {
          id, title: d.title.trim(), description: d.description || '', image: d.image?.url ? d.image : null,
          show_in_nav: d.show_in_nav, modules: d.modules, check_first: d.check_first, updated_at: baseRef.current?.updated_at,
        });
        took(res.page);
        setSave(dirty.current ? { state: 'waiting' } : { state: 'saved', at: Date.now() });
        saved.current?.(res.page);
        return true;
      } catch (e) {
        if (e.status === 409) {
          stopped.current = true;
          setSave({ state: 'conflict', text: 'Someone else saved this page since you opened it. Reload to see their changes (yours since then aren’t saved).' });
          return false;
        }
        dirty.current = true;
        setSave({ state: 'error', text: e.message });
        return false;
      }
    })();
    inflight.current = run;
    const ok = await run;
    if (inflight.current === run) inflight.current = null;
    if (ok && dirty.current) return flush();
    return ok;
  }, [id, took]);

  // Publish, take off the site, a new address: in turn with the autosave.
  const inTurn = useCallback(async (send) => {
    while (inflight.current) await inflight.current;
    const run = send().then((res) => { if (res?.page) took(res.page); return res; });
    const done = run.then(() => true, () => true);
    inflight.current = done;
    try { return await run; } finally { if (inflight.current === done) inflight.current = null; }
  }, [took]);

  const put = useCallback((next) => {
    draftRef.current = next;
    setDraftState(next);
    if (stopped.current) return;
    dirty.current = true;
    setSave({ state: 'waiting' });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { flush(); }, SAVE_AFTER_MS);
  }, [flush]);

  const change = useCallback((fn, key = null) => {
    const cur = draftRef.current;
    if (!cur) return;
    const next = fn(cur);
    if (next === cur) return;
    history.current.record(cur, key);
    put(next);
  }, [put]);

  const undo = useCallback(() => {
    const back = draftRef.current && history.current.undo(draftRef.current);
    if (back) put(back);
    setTick((n) => n + 1);
    return Boolean(back);
  }, [put]);
  const redo = useCallback(() => {
    const next = draftRef.current && history.current.redo(draftRef.current);
    if (next) put(next);
    setTick((n) => n + 1);
    return Boolean(next);
  }, [put]);

  // Leaving marks the copy old, so the next visit reads it again.
  useEffect(() => () => { qc.invalidateQueries({ queryKey: ['site-page', id] }); }, [qc, id]);
  // Leaving: what's typed still saves. Closing the tab mid-save: asked first.
  useEffect(() => () => { if (dirty.current) flush(); }, [flush]);
  useEffect(() => {
    const warn = (e) => { if (dirty.current || inflight.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  // Loose problems are fixed as they're typed: check again on every change.
  useEffect(() => {
    if (!draft || !looseProblems.length) return;
    const now = problemsOf(draft.modules);
    if (now.map(problemWords).join('|') !== looseProblems.map(problemWords).join('|')) setLooseProblems(now);
  }, [draft, looseProblems]);

  return {
    draft, base, save, looseProblems, change, flush, inTurn, undo, redo,
    canUndo: history.current.canUndo(), canRedo: history.current.canRedo(),
    current: () => draftRef.current, dirty: () => dirty.current, busy: () => Boolean(inflight.current), stopped: () => stopped.current,
    retry: () => { dirty.current = true; flush(); },
  };
}
