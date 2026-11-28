// The voter guide's words in the field app (VG): the public page's own
// (shared/site/ui-words.js vg.*, English), and the field's two. Kept apart
// from guide.js so Today doesn't carry the website's word list.
import { wordsIn } from '@base-win/shared/site/ui-words';

const FIELD = {
  'vg.nearPlace': 'You’re near a voting place — no campaigning within 100 m.',
  'vg.nearChip': 'Near a voting place',
};
const words = wordsIn(FIELD);
export const W = (key, slots) => words(key, slots);
