// Finding a person by name, phone or email: GET /search/people (ext/search),
// in A–Z order by last name, a page at a time.
//
//   usePersonSearch(term, { limit, role, not, list, enabled })
//     → { rows, total, many, cap, hint, more, loadMore, loadingMore, status,
//         fresh, waiting, error, retry, term, query }
//
// It asks once typing has paused (200 ms), never under 2 characters, and a
// newer term cancels the ask still on its way (the browser stops waiting).
// Always asked afresh (no kept answer), so someone added a moment ago, by an
// import or on another tab, is found the next time the term is typed or the
// box opens. While a new term's answer is on its way the last answer stays
// on screen with fresh: false; it must never be picked from (PersonResults).
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { foldTerm } from '@starbase/shared/names';
import { apiGet } from '../api.js';
import { useSettled } from './useSettled.js';

export const SETTLE_MS = 200;
// At most this many pages held (1,000 rows at 25): past it, type more.
export const MAX_PAGES = 40;

export function usePersonSearch(term, { limit = 25, role, not, list, enabled = true } = {}) {
  const typed = String(term ?? '').trim();
  const settled = useSettled(typed, SETTLE_MS);
  const on = enabled && settled.length >= 2;
  const ask = (after) => {
    const qs = new URLSearchParams({ q: settled, limit: String(limit) });
    if (role) qs.set('role', role);
    if (not) qs.set('not', not);
    if (list) qs.set('list', list);
    if (after) qs.set('after', after);
    return `/search/people?${qs}`;
  };
  const q = useInfiniteQuery({
    queryKey: ['persons', 'find', foldTerm(settled), role || null, not || null, list || null, limit],
    queryFn: ({ pageParam, signal }) => apiGet(ask(pageParam), { signal }),
    initialPageParam: null,
    getNextPageParam: (last, pages) => (last.more && last.persons?.length && pages.length < MAX_PAGES ? last.persons.at(-1).id : undefined),
    enabled: on,
    staleTime: 0,
    // Dropped once no box shows it: coming back to a term starts again
    // from its first page (one ask), not a refetch of every page held.
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const pages = on ? (q.data?.pages || []) : [];
  const seen = new Set();
  const rows = [];
  for (const page of pages) {
    for (const p of page.persons || []) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      rows.push(p);
    }
  }
  const first = pages[0] || null;
  const last = pages.at(-1) || null;
  const atMax = pages.length >= MAX_PAGES;
  // The rows on screen are for what's in the box now (not the last term's).
  const fresh = on && settled === typed && !q.isPlaceholderData && q.isSuccess;
  return {
    term: settled,
    rows,
    total: first?.total ?? null,
    many: Boolean(first?.many),
    cap: first?.cap ?? null,
    hint: first?.hint ?? null,
    more: Boolean(last?.more) && !atMax,
    full: Boolean(last?.more) && atMax,
    loadMore: () => { if (q.hasNextPage && !q.isFetchingNextPage && fresh) q.fetchNextPage(); },
    loadingMore: q.isFetchingNextPage,
    status: !on ? 'idle' : q.isPending ? 'pending' : q.isError && !q.data ? 'error' : 'success',
    fresh,
    waiting: on ? (settled !== typed || q.isFetching) : typed.length >= 2,
    error: q.error,
    retry: () => q.refetch(),
    query: q,
  };
}

export default usePersonSearch;
