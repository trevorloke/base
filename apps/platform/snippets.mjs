// What the New campaign wizard hands the owner to paste (spec §6.5): the
// .env block for Render's "Add from .env" and (for us) a render.yaml block. Built from the campaign's own
// values only: never staging's sample, demo, frame or opponent settings,
// and never a secret (the two random values are made in the browser).
// The campaign server's own rules (server/lib/org.js JURISDICTIONS; a test
// keeps the two lists the same).
export const JURISDICTIONS = ['bc-municipal', 'bc-provincial', 'federal'];
export const RULE_WORDS = { 'bc-municipal': 'B.C. municipal', 'bc-provincial': 'B.C. provincial', federal: 'Federal' };
export const PROVINCES = [
  ['BC', 'British Columbia', 'America/Vancouver'], ['AB', 'Alberta', 'America/Edmonton'], ['SK', 'Saskatchewan', 'America/Regina'],
  ['MB', 'Manitoba', 'America/Winnipeg'], ['ON', 'Ontario', 'America/Toronto'], ['QC', 'Quebec', 'America/Toronto'],
  ['NB', 'New Brunswick', 'America/Halifax'], ['NS', 'Nova Scotia', 'America/Halifax'], ['PE', 'Prince Edward Island', 'America/Halifax'],
  ['NL', 'Newfoundland and Labrador', 'America/St_Johns'], ['YT', 'Yukon', 'America/Whitehorse'],
  ['NT', 'Northwest Territories', 'America/Yellowknife'], ['NU', 'Nunavut', 'America/Iqaluit'],
];
export const TIME_ZONES = [...new Set(PROVINCES.map((p) => p[2]))];
export const tzFor = (province) => PROVINCES.find((p) => p[0] === province)?.[2] || 'America/Vancouver';
export const RACES = [['council', 'City council'], ['school_board', 'School board']];
// The only keys a campaign's saved values may have (no secrets, no people).
export const VALUE_KEYS = ['city', 'province', 'rules', 'tz', 'races'];
export const pickValues = (v) => Object.fromEntries(VALUE_KEYS.filter((k) => v[k] != null).map((k) => [k, v[k]]));

// A value inside double quotes on one line: no quotes, backslashes or breaks.
const flat = (s) => String(s ?? '').replace(/["\\\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
const slates = (races = []) => RACES.filter(([code]) => races.includes(code)).map(([code, words]) => `${code}:${words}`).join(',');

// The .env block. The two random lines are left empty here: the page's
// script fills them in the browser (the server never sees them).
// → [{ key, value, random? }]
export const envLines = ({ name, display, values, publicKey = '' }) => [
  { key: 'NODE_ENV', value: 'production' },
  { key: 'STARBASE_ENV', value: 'production' },
  { key: 'STARBASE_PUBLIC_URL', value: `https://${name}.base.win` },
  { key: 'STARBASE_BRAND', value: 'base' },
  { key: 'STARBASE_ORG_NAME', value: `"${flat(display)}"` },
  { key: 'STARBASE_JURISDICTION', value: values.rules },
  { key: 'STARBASE_PROVINCE', value: values.province },
  { key: 'STARBASE_TZ', value: values.tz },
  { key: 'STARBASE_CITY', value: `"${flat(values.city)}"` },
  { key: 'STARBASE_SLATES', value: `"${slates(values.races)}"` },
  { key: 'BASE_PLATFORM_PUBKEY', value: publicKey },
  { key: 'STARBASE_TWO_STEP_KEY', value: '', random: true },
  { key: 'GOOGLE_TOKEN_KEY', value: '', random: true },
];
export const envText = (opts) => envLines(opts).map((l) => `${l.key}=${l.value}`).join('\n');

// Never in a block made here: staging's sample, demo and frame settings,
// and the sample's made-up opponents and map box.
export const DENY = ['STARBASE_SAMPLE', 'STARBASE_SAMPLE_RESET', 'STARBASE_DEMO_EMAIL', 'STARBASE_FRAME_HOSTS', 'STARBASE_CANDIDATES', 'STARBASE_GEO_BOUNDS'];
// Pasted or made by Render, never written here with a value.
const SECRET = { BASE_PLATFORM_PUBKEY: 'sync', STARBASE_TWO_STEP_KEY: 'generate', GOOGLE_TOKEN_KEY: 'generate' };
// The production block's services, asked for later in the app's Settings.
const LATER = ['RESEND_API_KEY', 'MAIL_FROM', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'GOOGLE_MAPS_SERVER_KEY', 'GOOGLE_TRANSLATE_KEY',
  'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_PICKER_KEY', 'GOOGLE_CLOUD_PROJECT_NUMBER'];

// For us: the same campaign as a render.yaml service and database, made
// from the production block's shape.
export const renderSnippet = ({ name, display, values }) => {
  const q = (s) => JSON.stringify(String(s));
  const env = [];
  const add = (key, body) => env.push(`      - key: ${key}`, ...body.map((l) => `        ${l}`));
  add('NODE_ENV', ['value: production']);
  add('STARBASE_ENV', ['value: production']);
  add('DATABASE_URL', ['fromDatabase:', `  name: base-win-${name}-db`, '  property: connectionString']);
  for (const l of envLines({ name, display, values })) {
    if (['NODE_ENV', 'STARBASE_ENV'].includes(l.key) || DENY.includes(l.key)) continue;
    if (SECRET[l.key]) continue;
    add(l.key, [`value: ${q(l.value.replace(/^"|"$/g, ''))}`]);
  }
  for (const [key, how] of Object.entries(SECRET)) add(key, [how === 'sync' ? 'sync: false' : 'generateValue: true']);
  for (const key of LATER) add(key, ['sync: false']);
  return [
    '  # services:',
    '  - type: web',
    `    name: base-win-${name}`,
    '    runtime: docker',
    '    plan: starter',
    '    region: oregon',
    '    branch: production',
    '    dockerfilePath: ./Dockerfile',
    '    dockerContext: .',
    '    healthCheckPath: /api/health',
    '    autoDeploy: true',
    '    envVars:',
    ...env,
    '  # databases:',
    `  - name: base-win-${name}-db`,
    '    plan: 0.5c-1g',
    '    region: oregon',
    '    postgresMajorVersion: "16"',
  ].join('\n');
};
