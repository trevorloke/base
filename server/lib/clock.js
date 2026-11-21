// The one clock the tests can move. now() is Date.now(), plus
// STARBASE_CLOCK_SHIFT_MS when NODE_ENV is test (or node --test runs it) or the server runs with
// STARBASE_E2E=1 (a browser suite moving to election day at 19:59);
// anywhere else the setting is ignored. The voter guide reads it for every
// state, banner and cache expiry; GOTV mode's "is today a voting day" and
// Path to win's today (todayOf) follow it too, so a moved clock moves them
// together.
const movable = () => process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT) || process.env.STARBASE_E2E === '1';
export const clockShift = () => {
  if (!movable()) return 0;
  const n = Number(process.env.STARBASE_CLOCK_SHIFT_MS);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};
export const now = () => Date.now() + clockShift();
// A line for the server's start when the clock is moved (or the setting is
// there and ignored), else null.
export const clockNote = () => {
  if (!String(process.env.STARBASE_CLOCK_SHIFT_MS || '').trim()) return null;
  return movable()
    ? `clock: moved by STARBASE_CLOCK_SHIFT_MS=${clockShift()} ms (tests only)`
    : 'clock: STARBASE_CLOCK_SHIFT_MS is set and ignored (only tests and STARBASE_E2E=1 move the clock)';
};
