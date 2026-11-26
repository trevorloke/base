// Every setting the control centre reads, in one place (a structural test
// keeps process.env reads to this list). Read on each call, so a test can
// change one between requests.
//   OPS_HOST              the console's own host (ops.base.win); every other host gets a 404
//   OPS_SETUP_CODE        Render makes it; typed once to set up (32+ base64 characters)
//   OPS_SECRET            Render makes it; seals the authenticator key, keys the setup code's HMAC
//   PLATFORM_SIGNING_KEY  Render makes it; the Ed25519 seed source (old,new while changing; the first signs)
//   OPS_CLIENT_ORIGIN     tests only: where a client's own address is, {name} standing for its short name (https://{name}.base.win)
//   OPS_INSECURE_COOKIES  tests only: 1 drops Secure and __Host-, and expects an http Origin
//   OPS_ALLOW_LOCAL       tests only: 1 allows 127.0.0.1 in fetches, aud and form-action
const env = process.env;

export const cfg = () => ({
  databaseUrl: env.DATABASE_URL || '',
  port: Number(env.PORT) || 3300,
  production: env.NODE_ENV === 'production',
  host: String(env.OPS_HOST || 'ops.base.win').trim().toLowerCase(),
  setupCode: String(env.OPS_SETUP_CODE || '').trim(),
  secret: String(env.OPS_SECRET || '').trim(),
  signingKey: String(env.PLATFORM_SIGNING_KEY || ''),
  clientOrigin: String(env.OPS_CLIENT_ORIGIN || 'https://{name}.base.win').replace(/\/+$/, ''),
  insecureCookies: env.OPS_INSECURE_COOKIES === '1',
  allowLocal: env.OPS_ALLOW_LOCAL === '1',
});

// A client's own address: https://<name>.base.win (built here, never taken from an answer).
export const addressOf = (name) => cfg().clientOrigin.replace('{name}', name);
