// The Website area's reads (server/ext/site/api.js; SITE.md "Admin API"),
// one query key each, and what refreshes them after a write.
//   ['site']                 GET /api/site — settings, pages, counts, where it lives, payments
//   ['site-page', id]        GET /api/site/pages/:id — one page with its draft and what's live
//   ['site-posts'] · ['site-post', id]
//   ['site-campaigns'] · ['site-campaign', id]
//   ['site-pictures']        GET /api/site/pictures — what's been uploaded
//   ['microsites'] · ['microsite', id]   the campaign's other websites: rows,
//                            sign-up counts and sources (never people)
// Writes are actions (api.js action()); useSiteRefresh() invalidates what
// a write changed.
import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet } from '../../api.js';

export const useSite = (enabled = true) => useQuery({ queryKey: ['site'], queryFn: () => apiGet('/site'), enabled });
export const useSitePage = (id) => useQuery({ queryKey: ['site-page', id], queryFn: () => apiGet(`/site/pages/${id}`), enabled: Boolean(id) });
export const useSitePosts = () => useQuery({ queryKey: ['site-posts'], queryFn: () => apiGet('/site/posts') });
export const useSitePost = (id) => useQuery({ queryKey: ['site-post', id], queryFn: () => apiGet(`/site/posts/${id}`), enabled: Boolean(id) });
// Petitions change in another tab (New petition… from a section): read
// again when this window comes back.
export const useSiteCampaigns = ({ fresh = false } = {}) => useQuery({
  queryKey: ['site-campaigns'], queryFn: () => apiGet('/site/campaigns'), refetchOnWindowFocus: fresh,
});
export const useSiteCampaign = (id) => useQuery({ queryKey: ['site-campaign', id], queryFn: () => apiGet(`/site/campaigns/${id}`), enabled: Boolean(id) });
export const useMicrosites = () => useQuery({ queryKey: ['microsites'], queryFn: () => apiGet('/site/microsites') });
export const useMicrosite = (id) => useQuery({ queryKey: ['microsite', id], queryFn: () => apiGet(`/site/microsites/${id}`), enabled: Boolean(id) });
export const useSitePictures = (enabled = true) => useQuery({ queryKey: ['site-pictures'], queryFn: () => apiGet('/site/pictures'), enabled });

export function useSiteRefresh() {
  const qc = useQueryClient();
  return useCallback((...keys) => Promise.all((keys.length ? keys : [['site']]).map((queryKey) => qc.invalidateQueries({ queryKey }))), [qc]);
}

// "Saved 2:14 pm"
export const clock = (d) => new Date(d).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
export const day = (d) => (d ? new Date(d).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
