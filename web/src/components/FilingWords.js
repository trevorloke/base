// The financial agent's filing dates (server/ext/filingdates), in words.
// Plain JS (no JSX): Today and Donations both say a date the same way.

// How far off a date is: "today", "tomorrow", "in 12 days" — or, once it
// has passed, "yesterday", "3 days ago".
export const daysLeft = (days) => {
  const n = Number(days);
  if (!Number.isFinite(n)) return '';
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n.toLocaleString('en-CA')} days` : `${Math.abs(n).toLocaleString('en-CA')} days ago`;
};

// The countdown's big part and its small word: 66 · "days left", 1 · "day
// left", "Today", 3 · "days ago".
export const countdown = (days) => {
  const n = Number(days);
  if (!Number.isFinite(n)) return { n: '', word: '' };
  if (n === 0) return { n: 'Today', word: '' };
  const abs = Math.abs(n);
  return { n: abs.toLocaleString('en-CA'), word: `${abs === 1 ? 'day' : 'days'} ${n > 0 ? 'left' : 'ago'}` };
};

// "Jan 15, 2027" from 2027-01-15 — the day as typed, never shifted by a time zone.
export const filingDay = (iso) => {
  const [y, m, d] = String(iso || '').slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '';
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};

// Within a week (or just passed): said in the warning colour.
export const filingSoon = (days) => Number(days) <= 7;
