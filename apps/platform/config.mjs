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
const env = process.env;

// A client's public address, with {name} where its short name goes. A
// value without {name} can't tell clients apart, so it is not used.
export const PUBLIC_TEMPLATE = 'https://{name}.base.win';
const publicTemplate = (raw) => {
  const t = String(raw || '').trim().replace(/\/+$/, '');
  return t.includes('{name}') ? t : PUBLIC_TEMPLATE;
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
});
