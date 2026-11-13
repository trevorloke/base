// Sent to Google Drive's dates: "13 Nov, 10:56 am" on the campaign's clock.
// Through shared/dayparts.js (onClock), so B.C.'s UTC-7-all-year rule holds
// on a browser whose own time-zone rules still fall back in November, the
// same hour every other screen shows.
import { onClock } from '@starbase/shared/dayparts';

export const driveWhen = (iso, tz, time = true) => {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  const [at, zone] = onClock(d, tz);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(at);
  const part = (type) => parts.find((p) => p.type === type)?.value || '';
  const day = `${part('day')} ${part('month').replace('.', '')}`;
  if (!time) return day;
  return `${day}, ${part('hour')}:${part('minute')} ${part('dayPeriod').replace(/\./g, '').toLowerCase()}`;
};
