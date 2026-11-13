// Letters waiting for the desk (ext/letters): new ones, and ones the writer
// moved since the desk looked — Today's "N letters" and Media's Letters tab.
// Kept apart from the Letters screens so Today loads none of them.
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api.js';

export function useLettersCount(enabled = true) {
  const q = useQuery({ queryKey: ['letters', 'count'], queryFn: () => apiGet('/media/letters/count'), enabled });
  const n = (Number(q.data?.new) || 0) + (Number(q.data?.waiting) || 0);
  return { n, pending: enabled && q.isPending };
}
