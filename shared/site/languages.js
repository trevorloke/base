// The languages a campaign's websites can be read in (TR). The list is code,
// not data: adding one later is a row here, a font check and the legal words
// approved in it. English is the site's own language and the official
// version; the others are made from it ahead of time (server/ext/site
// translate.js) and shown at their own addresses under a prefix.
//
//   code     the language's code everywhere (settings, tables, lang="")
//   name     its English name, for the desk
//   label    its name in its own script, for the switch
//   og       Open Graph's locale
//   path     the prefix of its addresses ('' for English)
//   google   what Google Cloud Translation calls it (null: not sent; zh-Hant
//            is converted from zh-Hans on the server)
//   stripe   Stripe Checkout's locale ('auto': the payer's browser; Stripe
//            has no Punjabi, so a Punjabi donor's payment page follows
//            their browser and the form says so)
//   locale   how dates read (Intl)
export const LANGUAGES = [
  { code: 'en', name: 'English', label: 'English', og: 'en_CA', path: '', google: null, stripe: 'auto', locale: 'en-CA' },
  { code: 'pa', name: 'Punjabi', label: 'ਪੰਜਾਬੀ', og: 'pa_IN', path: '/pa', google: 'pa', stripe: 'auto', locale: 'pa' },
  { code: 'zh-Hans', name: 'Chinese (Simplified)', label: '简体', og: 'zh_CN', path: '/zh', google: 'zh-CN', stripe: 'zh', locale: 'zh-Hans' },
  { code: 'zh-Hant', name: 'Chinese (Traditional)', label: '繁體', og: 'zh_TW', path: '/zh-hant', google: null, from: 'zh-Hans', stripe: 'zh-TW', locale: 'zh-Hant' },
];
export const LANG_BY_CODE = Object.fromEntries(LANGUAGES.map((l) => [l.code, l]));
// The languages besides English, in the switch's order.
export const OTHER_CODES = LANGUAGES.filter((l) => l.code !== 'en').map((l) => l.code);
export const isOther = (code) => OTHER_CODES.includes(code);
// The first segment of an address → its language ('pa' for /pa/about).
export const LANG_BY_PREFIX = Object.fromEntries(LANGUAGES.filter((l) => l.path).map((l) => [l.path.slice(1), l.code]));
// Addresses a page may never take: each language's prefix, and 'en'.
export const LANG_SLUGS = ['en', ...Object.keys(LANG_BY_PREFIX)];

// The switch's labels: with only one Chinese script offered, it reads 中文.
export const labelFor = (code, offered = []) => {
  const both = offered.includes('zh-Hans') && offered.includes('zh-Hant');
  if ((code === 'zh-Hans' || code === 'zh-Hant') && !both) return '中文';
  return LANG_BY_CODE[code]?.label || code;
};
// "in ਪੰਜਾਬੀ" for the desk's History and the gift's declaration.
export const langWord = (code) => LANG_BY_CODE[code]?.label || code;
