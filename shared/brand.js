// The product's name, in one place: base.win — one product for the
// campaign's people, map, field, money, outreach and website (the website is
// one of the desk's areas, like People or Donations). The campaign's own
// name is the workspace's, shown beside it. Internal names (STARBASE_*
// settings, package names, the database) are unchanged, so nothing deployed
// moves.
export const APP_NAME = 'base.win';

// The look one deployment wears (STARBASE_BRAND — server/lib/brand.js picks;
// the server marks the app's page <html data-brand="…">; web/src/brand.js
// reads it; web/src/brand-base.css re-colours the tokens).
//   imagine-surrey  Imagine Surrey's own: Surrey Navy and Marigold, the
//                   star, Barlow Condensed headlines. Training is "ImagineU".
//   base            base.win's own, for staging and any other campaign: slate
//                   and indigo, Inter throughout, the base.win mark. Training
//                   is "Training". Nothing in it names Imagine Surrey.
// theme / themeDark colour the browser's bar; link is a link in an email;
// mapInk draws a turf with no colour of its own.
export const BRANDS = {
  'imagine-surrey': {
    key: 'imagine-surrey',
    learn: 'ImagineU',
    mark: '/star.png',
    icon: { href: '/star.png', type: 'image/png' },
    touchIcon: '/apple-touch-icon.png',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    theme: '#003979',
    themeDark: '#00224d',
    link: '#003979',
    mapInk: '#003979',
    sitePlaceholder: 'https://imaginesurrey.ca',
    sampleLede: 'Try it with 52 made-up Surrey voters.',
  },
  base: {
    key: 'base',
    learn: 'Training',
    mark: '/base-mark.svg',
    icon: { href: '/base-mark.svg', type: 'image/svg+xml' },
    touchIcon: '/base-touch-icon.png',
    icons: [
      { src: '/base-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/base-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/base-icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    theme: '#1e293b',
    themeDark: '#0f172a',
    link: '#4338ca',
    mapInk: '#4f46e5',
    sitePlaceholder: 'https://yourcampaign.ca',
    sampleLede: 'Try it with 52 made-up voters.',
  },
};
export const BRAND_KEYS = Object.keys(BRANDS);
// No mark on the page (a dev server, a page from before brands): Imagine
// Surrey's, as everything looked before there was a choice.
export const DEFAULT_BRAND = 'imagine-surrey';
