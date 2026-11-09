// Open follow-ups, for Today's "Needs you" (desk only): every one — a
// ladder's, and speed to lead's new volunteers, messages and RSVPs — and how
// many are past their day. Kept apart from the ladder screens so Today
// loads none of them.
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api.js';

export function useFollowupCount(enabled = true) {
  const q = useQuery({
    queryKey: ['ladders', 'followups', 'count'],
    queryFn: () => apiGet('/ladders/followups/count'),
    enabled,
  });
  return { n: Number(q.data?.open) || 0, overdue: Number(q.data?.overdue) || 0, pending: enabled && q.isPending };
}
