// The voter guide's desk read (GET /api/site/guide; VG decision 23):
// Website → Voter guide and the Overview's "Voter guide · Live" row.
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api.js';

export const GUIDE_STATE = { not_out: 'Not out yet', draft: 'Draft', live: 'Live', over: 'Over' };
export const useSiteGuide = (enabled = true) => useQuery({ queryKey: ['site-guide'], queryFn: () => apiGet('/site/guide'), enabled });
