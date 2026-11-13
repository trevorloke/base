// What the person's page says when it comes back from Google's connect page
// (the Email sheet's "Connect again"): ?google=<code>, once, as a toast.
// They are already signed in, so these are Your profile's words (no "…or use
// your password"), naming Gmail where it is Gmail being connected.
import { googleWords } from './google.js';

export const connectWords = (code) => googleWords(code, { where: 'profile', what: 'Gmail' });
