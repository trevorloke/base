// What stops a campaign email going out (blast.send, media.send; the
// compose shows the same words first). On the stored text (codes), the
// first of:
//   1. a link with no address      → "Add the address for the link “Read more”"
//   2. a placeholder of the template it was started from (`from`), or of
//      any ready-made one          → "Fill in the [ ] parts first: [Headline one]"
//   3. a fill-in that won't fill    → "{first} won’t fill in — use + First name"
// Any other bracket ("[sic]", "[1]", "[Updated]") is the writer's own: the
// compose asks about it once, nothing refuses it.
import { NO_ADDRESS, placeholders, unfilled } from './words.js';
import { STARTER_PLACEHOLDERS } from './starters.js';

const both = (subject, body) => `${subject ?? ''}\n${body ?? ''}`;
// The placeholders (rule 2) still in it, in order.
export const stillToFill = (subject, body, { from = [] } = {}) => {
  const own = new Set(from || []);
  return placeholders(both(subject, body)).filter((p) => !p.startsWith(NO_ADDRESS) && (own.has(p) || STARTER_PLACEHOLDERS.has(p)));
};
const noAddress = (subject, body) => {
  const empty = placeholders(both(subject, body)).find((p) => p.startsWith(NO_ADDRESS));
  return empty ? `Add the address for the link “${empty.slice(NO_ADDRESS.length)}”` : null;
};
export const emailProblem = (subject, body, { from = [] } = {}) => {
  const left = stillToFill(subject, body, { from });
  return noAddress(subject, body)
    || (left.length ? `Fill in the [ ] parts first: ${left[0]}` : null)
    || unfilled(both(subject, body));
};
// Rules 1 and 3 only: what stops even a test copy ("Send me a test" goes
// with placeholders in, so the writer sees the layout).
export const testProblem = (subject, body) => noAddress(subject, body) || unfilled(both(subject, body));
