// "13 Nov": a day as letters' screens say it. A date alone ("2026-11-13":
// rules checked, published on) is that day wherever the reader is — read as
// a time it would be UTC midnight, the 12th in Surrey. A moment (sent_at,
// created_at, until) is the day it was on the reader's clock.
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
export const dayWords = (iso) => {
  const m = DATE_ONLY.exec(String(iso ?? ''));
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : new Date(iso);
  if (iso == null || iso === '' || Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(m ? { timeZone: 'UTC' } : {}) });
};
