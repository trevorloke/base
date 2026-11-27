// Every setting the control centre reads, in one place (a structural test
// keeps process.env reads to this list). Read on each call, so a test can
// change one between requests.
//   OPS_HOST              the console's own host (ops.base.win); every other host gets a 404
//   OPS_SETUP_CODE        Render makes it; typed once to set up (32+ base64 characters)
//   OPS_SECRET            Render makes it; seals the authenticator key, keys the setup code's HMAC
//   PLATFORM_SIGNING_KEY  Render makes it; the Ed25519 seed source (old,new while changing; the first signs)
//   RENDER                Render sets it on every service: there, an empty DATABASE_URL stops the start
//   OPS_PUBLIC_TEMPLATE   tests only: where a client's public address is looked for; {name} is its
//                         short name (https://{name}.base.win)
//   OPS_INSECURE_COOKIES  tests only: 1 drops Secure and __Host-, and expects an http Origin
//   OPS_ALLOW_LOCAL       tests only: 1 allows 127.0.0.1 in fetches, aud and form-action
//   RENDER_API_KEY        optional: a Render key, pasted in Render on base-platform and nowhere
//                         else. With it the control centre reads what Render says about each
//                         campaign's service and database and makes a short list of named
//                         changes there. cfg() never returns it: only render-api.mjs reads it.
//   RENDER_SERVICE_ID     Render sets it on every service: this service's own id there
//   OPS_RENDER_API        tests only: a stand-in for Render's API on 127.0.0.1 (needs
//                         OPS_ALLOW_LOCAL=1; ignored on Render, where RENDER is set)
const env = process.env;

// A client's public address, with {name} where its short name goes. A
// value without {name} can't tell clients apart, so it is not used.
export const PUBLIC_TEMPLATE = 'https://{name}.base.win';
const publicTemplate = (raw) => {
  const t = String(raw || '').trim().replace(/\/+$/, '');
  return t.includes('{name}') ? t : PUBLIC_TEMPLATE;
};

// A Render key as Render makes them: no space, 20 to 200 characters.
// Anything else counts as no key at all.
const keyValue = () => {
  const k = String(env.RENDER_API_KEY || '');
  return k.length >= 20 && k.length <= 200 && !/\s/.test(k) ? k : '';
};
// The Render key. Only render-api.mjs may call this (a structural test
// checks): the key goes to Render's API in one header and nowhere else.
export const renderKey = () => keyValue();
// Render's ids: a short prefix, a dash, letters and numbers (srv-…, dpg-…).
export const RENDER_ID_RE = /^[a-z]{2,4}-[a-z0-9]{6,40}$/;
const ownService = () => {
  const id = String(env.RENDER_SERVICE_ID || '').trim();
  return RENDER_ID_RE.test(id) ? id : '';
};
// Tests only: http://127.0.0.1:<port>[/path], and never on Render itself.
const renderApi = () => {
  if (env.OPS_ALLOW_LOCAL !== '1' || env.RENDER) return '';
  let u;
  try { u = new URL(String(env.OPS_RENDER_API || '')); } catch { return ''; }
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.username || u.password || u.search || u.hash) return '';
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
};

export const cfg = () => ({
  databaseUrl: env.DATABASE_URL || '',
  port: Number(env.PORT) || 3300,
  onRender: Boolean(env.RENDER),
  production: env.NODE_ENV === 'production',
  host: String(env.OPS_HOST || 'ops.base.win').trim().toLowerCase(),
  setupCode: String(env.OPS_SETUP_CODE || '').trim(),
  secret: String(env.OPS_SECRET || '').trim(),
  signingKey: String(env.PLATFORM_SIGNING_KEY || ''),
  publicTemplate: publicTemplate(env.OPS_PUBLIC_TEMPLATE),
  insecureCookies: env.OPS_INSECURE_COOKIES === '1',
  allowLocal: env.OPS_ALLOW_LOCAL === '1',
  render: Boolean(keyValue()),   // a Render key is set (never the key itself)
  ownService: ownService(),
  renderApi: renderApi(),        // '' means Render's own API
});
