// The product's name, in one place: base.win — one product for the
// campaign's people, map, field, money, outreach and website (the website is
// one of the desk's areas, like People or Donations). The campaign's own
// name is the workspace's, and leads. Internal names (STARBASE_*
// settings, package names, the database) are unchanged, so nothing deployed
// moves.
export const APP_NAME = 'base.win';

// The two built-in looks, as data. Each is a brand a campaign starts from:
// one colour (and maybe a second), a sidebar, corners, a heading face, a logo
// — and every shade on screen is worked out from the colour by one rule
// (brand-look.js), the same for both. STARBASE_BRAND picks which one a
// deployment starts from (server/lib/brand.js); the server marks the app's
// page <html data-brand="…"> and writes the shades into it; web/src/brand.js
// reads the mark.
//   imagine-surrey  Imagine Surrey's own: Surrey Navy, marigold as the
//                   second colour, its wordmark. Training is "ImagineU".
//   base            base.win's own, for staging and any other campaign:
//                   indigo, no logo (the campaign's initials stand in).
//                   Training is "Training". Nothing in it names Imagine Surrey.
// logo sits on light grounds, logoDark on dark ones; icon / touchIcon / icons
// are the tab's and the installed app's.
export const BRANDS = {
  'imagine-surrey': {
    key: 'imagine-surrey',
    color: '#003979',
    second: '#ffc72c',
    sidebar: 'light',
    corners: 'soft',
    heading: 'inter',
    logo: '/site-assets/imagine-surrey/logo.webp',
    logoDark: '/site-assets/imagine-surrey/logo-light.png',
    learn: 'ImagineU',
    icon: { href: '/star.png', type: 'image/png' },
    touchIcon: '/apple-touch-icon.png',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    sitePlaceholder: 'https://imaginesurrey.ca',
    sampleLede: 'Try it with 52 made-up Surrey voters.',
  },
  base: {
    key: 'base',
    color: '#4f46e5',
    second: null,
    sidebar: 'light',
    corners: 'soft',
    heading: 'inter',
    logo: null,
    logoDark: null,
    learn: 'Training',
    icon: { href: '/base-mark.svg', type: 'image/svg+xml' },
    touchIcon: '/base-touch-icon.png',
    icons: [
      { src: '/base-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/base-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/base-icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    sitePlaceholder: 'https://yourcampaign.ca',
    sampleLede: 'Try it with 52 made-up voters.',
  },
};
export const BRAND_KEYS = Object.keys(BRANDS);
// No mark on the page (a dev server): base.win's own, which is what app.css
// holds when nothing is written into the page.
export const DEFAULT_BRAND = 'base';
