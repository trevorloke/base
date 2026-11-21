// The voter guide's desk read (GET /api/site/guide; VG decision 23):
// Website → Voter guide and the Overview's "Voter guide · Live" row.
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api.js';

export const GUIDE_STATE = { not_out: 'Not out yet', draft: 'Draft', live: 'Live', over: 'Over' };
// Read again when the window comes back: a tab left open overnight would
// otherwise show yesterday's "Closed today".
export const useSiteGuide = (enabled = true) => useQuery({ queryKey: ['site-guide'], queryFn: () => apiGet('/site/guide'), enabled, refetchOnWindowFocus: true });

// A place's save sends "Closed today" only when the switch was changed in
// this editor (`was`: the switch as the editor opened; null for a new
// place): the server stamps closed: true with the day of the save, so an
// untouched switch read yesterday would close the place again today.
export const closedPatch = (was, closed) => (was === closed ? {} : { closed });
