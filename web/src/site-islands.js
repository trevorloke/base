// The public website's islands — the browser half of the site renderer
// (server/ext/site/render, shared/site/components). The server sends each
// interactive part (forms, the donate amounts, the share sheet, the hero's
// rotating words, the Menu, volunteer sign-ups) as HTML plus its props; this
// hydrates the same component with the same props, so nothing is drawn
// twice. Built by Vite as its own file, dist/site-islands.js (vite.config.js),
// which the server serves at {site root}site-assets/site-islands.js.
import { createElement } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { hydrateIslands } from '../../shared/site/components/islands.js';

// Parts that only work with JavaScript (copy a link, type another amount)
// show from here on.
document.documentElement.classList.add('js');
const hydrated = hydrateIslands(document, { createElement, hydrateRoot });
window.__siteIslands = { hydrated };
