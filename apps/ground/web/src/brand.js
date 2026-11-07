// The campaign's brand in the browser (Settings → Brand; shared/brand.js).
//
// The server writes the brand into index.html's <head> as
// <style id="base-brand" data-name data-logo data-theme>html:root{…}</style>
// (server/lib/brand.js), so the first paint is already in it. Here:
//
//   bootBrand()          { name, logo } from that <style> — the sign-in page
//                        has it before anyone signs in
//   applyBrand(brand, name)  puts a brand on the open app at once: the
//                        <style>'s tokens, its name and logo, the phone's
//                        bar colour (after a save, or a workspace other than
//                        the one index.html was made for)
//   useBrand(enabled)    the signed-in campaign's brand (GET /api/brand),
//                        applied as it arrives; { name, logo, brand }
//   assetUrl(path)       '/media/…' under the app's prefix (SUITE.md,
//                        BASE_PATH: window.__BASE_PATH__)
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { brandCss, themeColor } from '@base-ground/shared/brand';
import { apiGet } from './api.js';

export const BRAND_KEY = ['brand'];

const styleEl = () => {
  if (typeof document === 'undefined') return null;
  let el = document.getElementById('base-brand');
  if (!el) {
    el = document.createElement('style');
    el.id = 'base-brand';
    document.head.appendChild(el);
  }
  return el;
};

export const assetUrl = (p) => {
  if (!p) return null;
  if (!p.startsWith('/')) return p;
  const base = typeof window !== 'undefined' && typeof window.__BASE_PATH__ === 'string' ? window.__BASE_PATH__.replace(/\/+$/, '') : '';
  return `${base}${p}`;
};

export const bootBrand = () => {
  const el = typeof document === 'undefined' ? null : document.getElementById('base-brand');
  return { name: el?.dataset.name || null, logo: el?.dataset.logo || null };
};

export const applyBrand = (brand, name) => {
  const el = styleEl();
  if (!el || !brand) return;
  const css = brandCss(brand, 'html:root');
  if (el.textContent !== css) el.textContent = css;
  el.dataset.name = name || '';
  el.dataset.logo = assetUrl(brand.logo) || '';
  const theme = themeColor(brand);
  el.dataset.theme = theme;
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.setAttribute('content', theme);
};

// On first load, the bar colour the server chose (index.html's own meta
// tags carry the default look's).
if (typeof document !== 'undefined') {
  const theme = document.getElementById('base-brand')?.dataset.theme;
  if (theme) for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.setAttribute('content', theme);
}

export function useBrand(enabled = true) {
  const q = useQuery({ queryKey: BRAND_KEY, queryFn: () => apiGet('/brand'), enabled, staleTime: 5 * 60_000 });
  const data = q.data;
  useEffect(() => { if (data?.brand) applyBrand(data.brand, data.name); }, [data]);
  const boot = bootBrand();
  return {
    brand: data?.brand || null,
    name: data?.name || boot.name,
    logo: data ? assetUrl(data.brand?.logo) : boot.logo,
  };
}
