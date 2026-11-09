// Ladders of engagement — Action Network / Action Builder style.
//
// A ladder is a trigger (joined the newsletter, first donation or any gift,
// got a tag, rated 1 or 2, did something on the website — by kind, or one
// petition or pledge —, booked a shift, came to one or didn't show up,
// became a member, answered a survey), a list of steps (Wait · Email ·
// Text · Tag · Remove a tag · Follow-up for staff · Stop) and, if it has
// one, a goal (came to a shift, gave, became a member, voted) that takes
// the person off as soon as they do it. Email steps go only to people who
// said yes to email (subscribed); text steps follow the texting rules
// (quiet hours, STOP, the campaign named, one conversation per number).
// When someone does the trigger they are put on every ladder that is on,
// once, and the steps run one job at a time. Each person also has an
// engagement level (Contact → Supporter → Signer → Donor or volunteer →
// Leader), computed from what they did.
//
//   sql.js      tables + the persons trigger that notes tags just got
//   shape.js    triggers, goals, steps, contracts, {{first_name}} / {{campaign}}
//   engine.js   the events hook (enrolling, goals) and the 'ladder.step' job
//   actions.js  ladder.* actions (desk roles)
//   levels.js   engagement levels
//   api.js      desk-only reads
//   public.js   /lu/:runId — unsubscribe from a ladder email (GET asks, POST does it)
//
// Volunteers see none of it: every read is desk-only, and nothing about
// ladders rides on any read they can make.
export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';
export { publicRoutes } from './public.js';
import { onEvents, runStepJob, JOB } from './engine.js';

export const hooks = { events: onEvents };
export const jobs = { [JOB]: runStepJob };

// In the full export: the ladders, who is on which step, and the follow-ups.
export const exportTables = ['ladders', 'ladder_runs', 'ladder_followups'];

export const deskOnlyReads = [
  /^\/api\/ladders(\/.*)?$/,
  '/persons/:id/ladders',
];
