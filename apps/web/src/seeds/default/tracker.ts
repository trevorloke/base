// A new client's promise tracker copy: neutral words around whatever promises
// it tracks (/admin/tracker). Imagine Surrey's is in ../imagine-surrey/tracker.ts.
import type { KeyDate } from "../imagine-surrey/tracker";

export const trackerIntro = {
  title: "Promise tracker",
  lede: "Every promise City Hall's majority made in the last campaign, logged against delivery so residents can see what was kept.",
  summary: "Each promise is scored against the public record, with the date and a link for every change.",
};

export const trackerHighlights: { title: string; body: string }[] = [];

export const scoringNote = "A promise is scored against what was said, not against what is reasonable.";

export const keyDates: KeyDate[] = [];

export const termStart = "2026-11-01";
export const termEnd = "2030-10-31";

export const sourcesNote = "";

export const sourceGroups: { label: string; links: { label: string; url: string }[] }[] = [];

export const methodology = {
  title: "How the promises are scored",
  lede: "Every line on the tracker is a claim about the public record. This page says what each score means, where the evidence comes from, how to dispute a score, and how often the log is updated.",
  statuses: {
    not_started: "No public record of any action on the promise. Every promise starts here on election night; staying here is itself a finding once a deadline passes.",
    in_progress: "A dated step toward delivery is on the record: a council resolution, a budget line, a contract, a letter to the Province. The promise's own delivery test is not yet met.",
    partly_kept: "The delivery test's \"partly kept\" line is met: something was delivered, but less than promised, later than promised, or with a condition the party did not mention.",
    kept: "The delivery test's \"kept\" line is met in full, on the record, and the record is linked from the promise.",
    broken: "The delivery test's \"broken\" line is met: a deadline passed with nothing in service, council voted the other way, or the party said it will not do it.",
  },
  sections: [
    {
      title: "The delivery test",
      paragraphs: [
        "Before any score, each promise gets a written test: what counts as kept, what counts as partly kept, what counts as broken, and which record to check. The tests were written before the first council meeting, so the bar cannot move once the results are in.",
        "A promise is scored against what the party said, not against what is reasonable.",
        "Promises that share a test are scored one by one: one of four promised pools funded is one promise moved, not four.",
      ],
    },
    {
      title: "Where the evidence comes from",
      paragraphs: [
        "Primary records first: council and committee agendas and minutes, adopted bylaws, the five-year financial plan, the Police Board's minutes and budget, procurement notices, and correspondence released under freedom of information. News coverage is cited for what the party said and for events the City has not yet minuted.",
        "Every update carries a date and a link to the record it rests on. If the record is a document that is not online, the update says where it is and how it was obtained.",
        "The log is additive. A score is changed by adding an update that says what changed and why; earlier updates are not rewritten. Corrections are logged the same way, marked as corrections.",
      ],
    },
    {
      title: "What a score is not",
      paragraphs: [
        "A score is not an opinion on whether the promise was a good idea, and \"kept\" is not an endorsement. A promise kept badly, or kept by cutting something else, still scores as kept if it meets its test; the cost shows up in the specifics and in the updates of the promises it collided with.",
      ],
    },
  ],
  dispute: {
    title: "Disputing a score",
    paragraphs: [
      "If you think a score is wrong, or a record is missing, email us with a link to the record you are relying on. Councillors, City staff and the party are as welcome to do this as anyone else.",
      "We reply to every dispute. If the record supports a change, the score changes and the correction is logged with the date and the reason. If it does not, we say why. Disputes and their outcomes are kept so the reasoning can be checked later.",
    ],
    subject: "Promise tracker: dispute",
  },
  cadence: {
    title: "How often the log is updated",
    paragraphs: [
      "The log is reviewed after every regular council meeting and every Police Board meeting, and in full when each year's financial plan is adopted (by May 15). Deadlines the party set are checked on the day they fall.",
      "Follow a promise to get an email when its score changes, subscribe to the RSS feed for every update, or read the JSON API if you are building something of your own.",
    ],
  },
};

export const followCopy = {
  title: "Follow this promise",
  text: "Get an email when the score changes, with a link to the record behind it. Nothing else.",
  consent: "Email me when this promise's status changes. I can stop at any time with one click from the email.",
  button: "Follow this promise",
  confirmed: "You're following this promise. We'll email you when its status changes, with a link to the record.",
  pending: "Check your inbox: one click on the email we just sent confirms that you want these updates.",
};

export const embedCopy = {
  title: "Put the scoreboard on your site",
  lede: "A small card with the live counts and a link back to the tracker. One script, no dependencies, no cookies, no tracking. It reads the public JSON API and updates whenever a score changes.",
  howTo: "Paste the snippet where you want the card to appear. The script finds the element named in data-target and draws the card inside it. Leave out data-site and the script reads from the site it was loaded from.",
};


/** The letter residents can copy into an email or the council's contact form. */
export function councilLetter(p: { number: number; total: number; title: string; statusLabel: string; dueLine: string | null; url: string }): string {
  return [
    "Dear Mayor and Council,",
    "",
    `I am writing about a promise made in the last campaign: "${p.title}" (promise ${p.number} of ${p.total} on the public tracker at ${p.url}).`,
    "",
    `The tracker currently scores this promise as ${p.statusLabel.toLowerCase()}.${p.dueLine ? ` ${p.dueLine}.` : ""} Please tell me, in writing:`,
    "",
    "1. What has been done on this promise so far, with the dates and the council or board records.",
    "2. What the next step is and who is responsible for it.",
    "3. When residents can expect it to be delivered, and what it will cost.",
    "",
    "I would appreciate a reply within 30 days. I will share your answer with the people who are tracking this promise with me.",
    "",
    "Sincerely,",
    "[Your name]",
    "[Your street or neighbourhood]",
  ].join("\n");
}

export const councilContactUrl = "";
