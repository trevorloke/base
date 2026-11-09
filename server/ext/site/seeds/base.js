// A new campaign's website: clean, generic, and honest — neutral words that
// say what goes where, to be replaced with the campaign's own. No facts
// about anyone: the campaign's name is the one it was set up with, and
// every other line is an instruction or a placeholder.
import { SKINS } from '@starbase/shared/site/theme';

export default (ws) => {
  const name = String(ws?.name || '').trim() || 'Our campaign';
  return {
    theme: SKINS.base,
    settings: {
      nav: {
        menu: [
          { label: 'Volunteer', href: '/volunteer' },
          { label: 'News', href: '/news' },
          { label: 'Donate', href: '/donate' },
        ],
        links: [],
        cta: { label: 'Donate', href: '/donate' },
      },
      footer: {
        acknowledgement: '',
        links: [
          { label: 'News', href: '/news' },
          { label: 'Volunteer', href: '/volunteer' },
          { label: 'Donate', href: '/donate' },
          { label: 'Privacy', href: '/privacy' },
        ],
        logo: { url: '', alt: '' },
      },
      announcement: { enabled: false, text: '', linkLabel: '', linkHref: '' },
      seo: { title: name, description: '', shareImage: { url: '', alt: '' } },
      org: {
        name, shortName: name.slice(0, 40), email: '', phone: '', address: '',
        platformUrl: '', platformLabel: '', privacyUrl: '/privacy', authorizationLine: '',
      },
      social: { accounts: [] },
    },
    campaigns: [],
    pages: [
      {
        slug: 'home',
        title: name,
        description: '',
        modules: [
          {
            id: 'hero', kind: 'hero', props: {
              titlePrefix: 'Your campaign headline',
              words: [],
              text: 'One or two sentences on what you stand for and what you want visitors to do next.',
              primaryCta: { label: 'Volunteer', href: '/volunteer' },
              secondaryCtas: [{ label: 'Donate', href: '/donate' }],
              image: { url: '', alt: '' },
            },
          },
          {
            id: 'stand', kind: 'columns', props: {
              title: 'What we stand for',
              intro: 'Three to five short points. Edit them under Website → Home.',
              items: [
                { icon: 'home', title: 'First point', body: 'A sentence or two on what you will do and why it matters.' },
                { icon: 'people', title: 'Second point', body: 'A sentence or two on what you will do and why it matters.' },
                { icon: 'leaf', title: 'Third point', body: 'A sentence or two on what you will do and why it matters.' },
              ],
              ctaText: '',
              cta: { label: '', href: '' },
            },
          },
          { id: 'newsletter', kind: 'newsletter', props: { title: 'Get the newsletter', intro: 'News and events. Unsubscribe anytime.', askPhone: false, buttonLabel: 'Sign up', tone: 'surface' } },
          {
            id: 'donate', kind: 'donate', props: {
              title: 'Donate', intro: 'A sentence on what a gift pays for.', text: '',
              amounts: ['25', '50', '100', '250'], allowMonthly: true, monthlyNote: '', clubNote: '',
            },
          },
          {
            id: 'volunteer', kind: 'volunteer', props: {
              title: 'Volunteer', intro: 'Tell us how you would like to help. An organizer will be in touch within a day.',
              roles: [], askAvailability: true, tone: 'paper',
            },
          },
        ],
      },
      {
        slug: 'donate',
        title: 'Donate',
        description: 'Give once or monthly.',
        show_in_nav: true,
        modules: [
          {
            id: 'donate', kind: 'donate', props: {
              title: 'Donate', intro: 'A sentence on what a gift pays for.', text: '',
              amounts: ['25', '50', '100', '250'], allowMonthly: true, monthlyNote: '', clubNote: '',
            },
          },
          {
            id: 'who-can-give', kind: 'text', props: {
              title: 'Who can give',
              body: 'Say who may give under the rules your campaign follows, and the yearly limit. Every gift is checked against the limit before it is taken.',
              cta: { label: '', href: '' }, tone: 'paper',
            },
          },
        ],
      },
      {
        slug: 'volunteer',
        title: 'Volunteer',
        description: 'Pick a shift, or tell us how you would like to help.',
        show_in_nav: true,
        modules: [
          { id: 'openings', kind: 'shifts', props: { title: 'Volunteer openings', intro: '', limit: 12, showMap: false } },
          {
            id: 'volunteer', kind: 'volunteer', props: {
              title: 'Volunteer', intro: 'Tell us how you would like to help. An organizer will be in touch within a day.',
              roles: [], askAvailability: true, tone: 'surface',
            },
          },
        ],
      },
      {
        slug: 'news',
        title: 'News',
        description: '',
        show_in_nav: true,
        modules: [{ id: 'news', kind: 'news', props: { title: 'News', limit: 24 } }],
      },
      {
        slug: 'privacy',
        title: 'Privacy',
        description: '',
        modules: [{
          id: 'privacy', kind: 'text', props: {
            title: 'Privacy',
            body: 'Write your privacy policy here: what you collect, why, who sees it, how long you keep it, and how people can ask to see, correct or remove what you hold about them.',
            cta: { label: '', href: '' }, tone: 'paper',
          },
        }],
      },
    ],
  };
};
