// What the person's page says when it comes back from Google's connect page
// (the Email sheet's "Connect again"): ?google=<code>, once, as a toast.
// They are already signed in, so where GSI's words are sign-in's ("…or use
// your password") Gmail's own are said instead; the rest are Your profile's.
import { googleWords } from './google.js';

const CONNECT = {
  cancelled: 'Connecting Gmail was cancelled.',
  blocked: 'Your Google Workspace admin hasn’t allowed base.win — ask them to mark it Trusted.',
  unavailable: 'Google isn’t answering right now. Try again in a minute.',
  off: 'Google is turned off for this campaign. Ask your campaign manager.',
  'not-set-up': 'Google isn’t working on this server — tell your campaign manager.',
};
const AGAIN = 'Connecting Gmail didn’t work. Try again.';

export const connectWords = (code) => {
  if (CONNECT[code]) return CONNECT[code];
  const said = googleWords(code, { where: 'profile' });
  return /password|sign[ -]?in/i.test(said) ? AGAIN : said;
};
