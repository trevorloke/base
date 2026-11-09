// Imagine Surrey's website, as base.win's first site for it: the home page
// in the order the website shows it (apps/web/src/lib/home-modules.ts
// DEFAULT_MODULES, each mapped to a catalogue module — the newsletter bar
// that sits inside the website's join section is its own module after it;
// the shop is left out), its donate, volunteer, events, news, tracker,
// privacy and accessibility pages, the pledge and the SkyTrain petition,
// and the menu, footer, search and organization details. The words are in
// imagine-surrey-content.js, copied from the website's own files.
import { SKINS } from '@starbase/shared/site/theme';
import content from './imagine-surrey-content.js';

export default () => ({
  theme: { ...SKINS['imagine-surrey'], logo: { url: '/site-assets/imagine-surrey/logo.webp', alt: 'Imagine Surrey' } },
  ...JSON.parse(JSON.stringify(content)),
});
