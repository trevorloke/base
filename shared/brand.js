// The product's name, in one place: base.win — one product for the
// campaign's people, map, field, money, outreach and website (the website is
// one of the desk's areas, like People or Donations). The campaign's own
// name is the workspace's, and leads. Internal names (STARBASE_*
// settings, package names, the database) are unchanged, so nothing deployed
// moves.
export const APP_NAME = 'base.win';

// base.win's own look, as data: the brand every campaign starts from until
// a manager saves one (Settings → Brand). One colour (and maybe a second), a
// sidebar, corners, a heading face, a logo — and every shade on screen is
// worked out from the colour by one rule (brand-look.js). Indigo, no logo
// (the campaign's initials stand in); training is "Training".
// A client with a look of its own before anything is saved has it as a
// preset on its own server (server/lib/preset.js), never in this file: this
// one is the same on every campaign's phones. The server marks the app's
// page <html data-brand="…"> and writes the shades into it; web/src/brand.js
// reads what the server wrote.
// logo sits on light grounds, logoDark on dark ones; icon / touchIcon / icons
// are the tab's and the installed app's.
export const BRANDS = {
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
  },
};
// No mark on the page (a dev server): base.win's own, which is what app.css
// holds when nothing is written into the page.
export const DEFAULT_BRAND = 'base';
