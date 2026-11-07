// Open requests from the doors, for Today's "Needs you" (desk only). Kept
// apart from the Requests screen so Today loads none of it.
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api.js';

export function useRequestsCount(enabled = true) {
  const q = useQuery({
    queryKey: ['requests', 'count'],
    queryFn: () => apiGet('/requests/count'),
    enabled,
  });
  return { n: Number(q.data?.open) || 0, pending: enabled && q.isPending };
}
