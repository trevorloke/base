// Imagine Surrey's website, as base.win's first site for it: the home page
// in the order the website shows it (apps/web/src/lib/home-modules.ts
// DEFAULT_MODULES, each mapped to a catalogue module — the newsletter bar
// that sits inside the website's join section is its own module after it;
// the shop is left out), its donate, volunteer, events, news, tracker,
// privacy and accessibility pages, the pledge and the SkyTrain petition,
// and the menu, footer, search and organization details. The words are in
// site-content.js, copied from the website's own files. Loaded only through
// index.js (site.seed), and only on Imagine Surrey's own server.
import preset from './index.js';
import content from './site-content.js';

export default () => ({
  theme: { ...preset.site.skin, logo: { url: '/site-assets/imagine-surrey/logo.webp', alt: 'Imagine Surrey' } },
  ...JSON.parse(JSON.stringify(content)),
});
