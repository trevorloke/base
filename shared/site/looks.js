// The ready looks every campaign's website can pick in Website → Theme,
// beside Base and the campaign's own (WA stage 3, rebuilt as WEB). Each is
// a new look: the modern heading sizes (scale 'modern': the hero is the
// biggest thing on the page), its own colours and a pairing from fonts.js.
// Nothing here is any campaign's: the names, colours and fonts are generic.
// Every pair theme.js checks reads at 4.5:1 (server/test/site-looks.test.js).
export const LOOKS = [
  {
    key: 'civic-blue',
    label: 'Civic blue',
    colors: { brand: '#1f4fa3', brandInk: '#ffffff', accent: '#8fd0f0', accentInk: '#0b1f3a', ink: '#13233a', paper: '#ffffff', surface: '#f1f5fb', line: '#d6e0ee', link: '#1f4fa3', action: '#1f4fa3', actionInk: '#ffffff' },
    fonts: { heading: 'dm-serif-display', body: 'dm-sans' },
    radius: 'soft',
    logo: { url: '', alt: '' },
    pop: false,
    scale: 'modern',
  },
  {
    key: 'evergreen',
    label: 'Evergreen',
    colors: { brand: '#1e5a3c', brandInk: '#ffffff', accent: '#f4c95d', accentInk: '#1a2a20', ink: '#1a2a20', paper: '#ffffff', surface: '#f2f6f1', line: '#d5e1d6', link: '#1e5a3c', action: '#b4441c', actionInk: '#ffffff' },
    fonts: { heading: 'merriweather', body: 'lato' },
    radius: 'soft',
    logo: { url: '', alt: '' },
    pop: false,
    scale: 'modern',
  },
];
