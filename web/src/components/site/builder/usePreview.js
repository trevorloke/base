// The builder's preview link and the screen's width.
//   usePreviewLink(pageId, enabled) → { url, open(event, draft) }: a link to
//   the draft that lasts half an hour, renewed before it runs out; open()
//   saves first when there's something unsaved, then opens it in a new tab.
//   useWidth() → the window's width, kept up to date.
import { useCallback, useEffect, useState } from 'react';
import { apiPost } from '../../../api.js';

const TOKEN_FOR_MS = 20 * 60_000; // a link lasts 30 minutes; a new one after 20

export function usePreviewLink(pageId, enabled) {
  const [link, setLink] = useState(null); // { url, at }
  const fresh = useCallback(async () => {
    if (link && Date.now() - link.at < TOKEN_FOR_MS) return link.url;
    const r = await apiPost('/site/preview-token', { pageId });
    setLink({ url: r.url, at: Date.now() });
    return r.url;
  }, [pageId, link]);
  useEffect(() => {
    if (!enabled) return undefined;
    fresh().catch(() => {});
    const t = setInterval(() => { fresh().catch(() => {}); }, TOKEN_FOR_MS);
    return () => clearInterval(t);
  }, [enabled, fresh]);
  const open = async (e, draft) => {
    if (!draft.dirty() && !draft.busy() && link && Date.now() - link.at < TOKEN_FOR_MS) return;
    e.preventDefault();
    const w = window.open('about:blank', '_blank');
    await draft.flush();
    try {
      const url = await fresh();
      if (w) w.location.replace(url); else window.open(url, '_blank', 'noopener');
    } catch { w?.close(); }
  };
  return { url: link?.url || null, open };
}

export function useWidth() {
  const [w, setW] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth));
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
}
