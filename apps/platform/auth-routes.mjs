// Setup, sign-in and sign-out, the session every other page needs, and the
// ten-minute code window every state-changing form goes through.
import { clientIp, makeLimiter } from '../../server/lib/guard.js';
import { newTotpSecret, setupFor, verifyTotp, base32Decode } from '../../server/lib/twostep.js';
import {
  setupState, setupCodeMatches, setupTries, countSetupTry, newSetupTicket, getSetupTicket, SETUP_TICKET_SECONDS,
  SETUP_TRIES_MAX, finishSetup, hashPassword, seal, unseal, signIn, loadSession, endSession, SESSION_SECONDS,
  codeFresh, stepUp, sha256, getOperator, deviceToken, knownDevice, DEVICE_SECONDS,
} from './ops-auth.mjs';
import { form, readCookie, writeCookie, clearCookie, SESSION, SETUP, DEVICE } from './web.mjs';
import {
  setupProblemPage, setupCodePage, setupYouPage, setupAppPage, setupCodesPage, signinPage,
} from './pages/auth.mjs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const TOO_MANY = 'Too many tries — wait 15 minutes.';
const NO_MATCH = 'That doesn’t match. Check all three.';
const minutes = (n) => n * 60_000;

export const makeLimits = () => ({
  setupIp: makeLimiter({ windowMs: minutes(15), max: 10 }),
  setupAll: makeLimiter({ windowMs: minutes(60), max: 30 }),
  signinIp: makeLimiter({ windowMs: minutes(15), max: 20 }),
  signinEmail: makeLimiter({ windowMs: minutes(15), max: 5 }),
  stepUp: makeLimiter({ windowMs: minutes(15), max: 10 }),
});

// The recovery codes, between setup's last step and the page that shows
// them once: kept only in this process, a few minutes, never in a table.
const shownOnce = new Map();
const keepCodes = (tokenHash, codes) => {
  const now = Date.now();
  for (const [k, v] of shownOnce) if (now - v.at > minutes(10)) shownOnce.delete(k);
  shownOnce.set(tokenHash, { codes, at: now });
};

export const authRoutes = (app, { db, limits }) => {
  // The steps after the code hold a setup ticket (only the right code makes
  // one): limited per address only, so a stranger spending the hourly limit
  // across addresses can't stop the owner half-way.
  const setupLimited = (c) => limits.setupIp(clientIp(c));
  // Every setup page: open, or the line saying why not, or off to sign in.
  const gate = async (c) => {
    const state = await setupState(db);
    if (state.problem) return { stop: c.html(String(setupProblemPage(state.problem)), 503) };
    if (!state.open) return { stop: c.redirect('/signin', 303) };
    return { state };
  };
  const ticketOf = async (c) => getSetupTicket(db, readCookie(c, SETUP));
  // After a setup or sign-in: this browser's mark (none while OPS_SECRET is unusable).
  const rememberDevice = async (c) => {
    const mark = deviceToken(await getOperator(db));
    if (mark) writeCookie(c, DEVICE, mark, DEVICE_SECONDS);
  };

  app.get('/setup', async (c) => {
    const g = await gate(c);
    return g.stop || c.html(String(setupCodePage()));
  });
  app.post('/setup', async (c) => {
    const g = await gate(c);
    if (g.stop) return g.stop;
    const f = await form(c);
    // The per-address limit holds for every try. Past it, the right code
    // goes through even when this code's 30 tries or the hourly limit
    // across addresses are spent, so a stranger spending them can't keep
    // the owner out. Those caps only slow guessing: from many addresses a
    // guess still gets right or wrong. The bound is the code itself — the
    // gate turns away short or typed codes (32+ characters of the base64
    // alphabets) and Render's generated value is 256 random bits, compared
    // in constant time.
    const byIp = limits.setupIp(clientIp(c));
    const byAll = limits.setupAll('all');
    if (byIp) return c.html(String(setupCodePage({ message: TOO_MANY })), 429);
    if (!setupCodeMatches(f.code)) {
      if (await setupTries(db) >= SETUP_TRIES_MAX) {
        return c.html(String(setupCodePage({ message: 'Too many tries with this code. Press Generate next to OPS_SETUP_CODE in Render for a new one.' })), 429);
      }
      if (byAll) return c.html(String(setupCodePage({ message: TOO_MANY })), 429);
      await countSetupTry(db);
      return c.html(String(setupCodePage({ message: 'That isn’t the setup code.' })), 401);
    }
    writeCookie(c, SETUP, await newSetupTicket(db), SETUP_TICKET_SECONDS);
    return c.redirect('/setup/you', 303);
  });

  const youDefaults = (state, ticket) => ({ name: ticket.name || state.operator?.name || '', email: ticket.email || state.operator?.email || '' });
  app.get('/setup/you', async (c) => {
    const g = await gate(c);
    if (g.stop) return g.stop;
    const ticket = await ticketOf(c);
    if (!ticket) return c.redirect('/setup', 303);
    return c.html(String(setupYouPage(youDefaults(g.state, ticket))));
  });
  app.post('/setup/you', async (c) => {
    const g = await gate(c);
    if (g.stop) return g.stop;
    const ticket = await ticketOf(c);
    if (!ticket) return c.redirect('/setup', 303);
    const f = await form(c);
    const name = String(f.name || '').trim().slice(0, 100);
    const email = String(f.email || '').trim().toLowerCase();
    const password = String(f.password || '');
    const again = (message, code = 400) => c.html(String(setupYouPage({ name, email, message })), code);
    if (setupLimited(c)) return again(TOO_MANY, 429);
    if (!name) return again('Type your name.');
    if (!EMAIL_RE.test(email) || email.length > 320) return again('Type an email address.');
    if (password.length < 12 || password.length > 200) return again('The password needs 12 or more characters.');
    await db.query('update operator_setup set name = $2, email = $3, password_hash = $4, totp_sealed = $5 where token_hash = $1',
      [ticket.token_hash, name, email, await hashPassword(password), seal(newTotpSecret())]);
    return c.redirect('/setup/app', 303);
  });

  const appPage = (ticket, message = '', code = 200) => {
    const secret = unseal(ticket.totp_sealed);
    return { secret, res: (c) => c.html(String(setupAppPage({ setup: setupFor(secret, { account: ticket.email, issuer: 'base.win control centre' }), message })), code) };
  };
  app.get('/setup/app', async (c) => {
    const g = await gate(c);
    if (g.stop) return g.stop;
    const ticket = await ticketOf(c);
    if (!ticket?.totp_sealed || !unseal(ticket.totp_sealed)) return c.redirect(ticket ? '/setup/you' : '/setup', 303);
    return appPage(ticket).res(c);
  });
  app.post('/setup/app', async (c) => {
    const g = await gate(c);
    if (g.stop) return g.stop;
    const ticket = await ticketOf(c);
    const secret = ticket?.totp_sealed ? unseal(ticket.totp_sealed) : null;
    if (!secret) return c.redirect(ticket ? '/setup/you' : '/setup', 303);
    const f = await form(c);
    if (setupLimited(c)) return appPage(ticket, TOO_MANY, 429).res(c);
    const step = verifyTotp(base32Decode(secret), f.code);
    if (step == null) return appPage(ticket, 'That code didn’t work. Type the one your app shows now.', 401).res(c);
    const done = await finishSetup(db, ticket, { step });
    if (!done.ok) {
      clearCookie(c, SETUP);
      return c.html(String(setupCodePage({ message: 'Setup was finished elsewhere, or the setup code changed. Start again.' })), 409);
    }
    clearCookie(c, SETUP);
    writeCookie(c, SESSION, done.token, SESSION_SECONDS);
    await rememberDevice(c);
    keepCodes(sha256(done.token), done.codes);
    return c.redirect('/setup/codes', 303);
  });
  app.get('/setup/codes', async (c) => {
    const session = await loadSession(db, readCookie(c, SESSION));
    const kept = session && shownOnce.get(session.tokenHash);
    if (!kept) return c.redirect('/', 303);
    shownOnce.delete(session.tokenHash);
    return c.html(String(setupCodesPage(kept.codes)));
  });

  app.get('/signin', async (c) => {
    if (await loadSession(db, readCookie(c, SESSION))) return c.redirect('/', 303);
    const state = await setupState(db);
    return c.html(String(signinPage({ setupOpen: state.open })));
  });
  app.post('/signin', async (c) => {
    const f = await form(c);
    const email = String(f.email || '').trim().toLowerCase().slice(0, 320);
    const state = await setupState(db);
    const again = (message, code) => c.html(String(signinPage({ email, message, setupOpen: state.open })), code);
    const byIp = limits.signinIp(clientIp(c));
    // A browser that has signed in here before skips the per-email limit
    // (anyone who knows the email could spend it); the address limit and
    // the wrong-code lock still hold.
    const known = await knownDevice(db, readCookie(c, DEVICE));
    const byEmail = known ? false : limits.signinEmail(email);
    if (byIp || byEmail) return again(TOO_MANY, 429);
    const done = await signIn(db, { email, password: f.password, code: f.code });
    if (!done) return again(NO_MATCH, 401);
    writeCookie(c, SESSION, done.token, SESSION_SECONDS);
    await rememberDevice(c);
    return c.redirect('/', 303);
  });
  app.post('/signout', async (c) => {
    await endSession(db, readCookie(c, SESSION));
    clearCookie(c, SESSION);
    return c.redirect('/signin', 303);
  });
};

// Every other page: signed in, or off to sign in.
export const requireSession = (db) => async (c, next) => {
  const session = await loadSession(db, readCookie(c, SESSION));
  if (!session) return c.redirect('/signin', 303);
  c.set('session', session);
  return next();
};

// The code window: a state-changing form needs a right code within the
// last 10 minutes. A form may carry `code`; a right one starts the window
// again. → 'ok' | 'stale' | 'wrong' (a code was typed and didn't work).
export const codeWindow = async (c, { db, limits }, f) => {
  const session = c.get('session');
  if (codeFresh(session)) return 'ok';
  const typed = String(f.code || '').trim();
  if (!typed) return 'stale';
  if (limits.stepUp(session.tokenHash)) return 'wrong';
  const via = await stepUp(db, session, typed);
  if (!via) return 'wrong';
  // A recovery code forgot every browser: this one, which used it, is known again.
  if (via === 'recovery') {
    const mark = deviceToken(await getOperator(db));
    if (mark) writeCookie(c, DEVICE, mark, DEVICE_SECONDS);
  }
  return 'ok';
};
