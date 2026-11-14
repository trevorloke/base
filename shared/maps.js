// Links out to Google Maps (Maps URLs: no key, no charge, nothing to set up).
//
// directionsUrl({ lat, lng, address, city, province }, { mode }) → the phone's
//   Google Maps with directions to a place: its pin when it has one, else its
//   words ("13450 104 Ave, Surrey, BC"; the city and province are added
//   unless the words already name them, so "Newton Library, 7183 136 St"
//   still goes to Surrey's 136 St). mode: walking | driving | bicycling | transit, else
//   Google picks. Never an origin: the phone's Google Maps starts from where
//   it is, and base.win never sends anyone's location to Google. null when
//   there is neither a pin nor an address. Right on a screen.
// searchUrl({ lat, lng }) → a search for a point: the link in texts, emails
//   and calendar files (shiftkinds.js mapUrl), unchanged.
const MODES = ['walking', 'driving', 'bicycling', 'transit'];
const isNum = (v) => v != null && v !== '' && Number.isFinite(Number(v));

// Words that end with the province (or a postal code, or Canada) already say
// where; otherwise the city goes on unless it is named, then the province.
const ENDS_WHERE = /(?:^|[\s,])(?:bc|b\.c\.?|british columbia|canada|[a-z]\d[a-z] ?\d[a-z]\d)\.?$/i;
const placeWords = (words, city, province) => {
  const c = String(city ?? '').trim();
  const p = String(province ?? '').trim();
  const lower = words.toLowerCase();
  if (ENDS_WHERE.test(words) || (p && lower.endsWith(p.toLowerCase()))) return words;
  return [words, c && !lower.includes(c.toLowerCase()) ? c : '', p].filter(Boolean).join(', ');
};

export const directionsUrl = ({ lat, lng, address, city, province } = {}, { mode } = {}) => {
  let destination = null;
  if (isNum(lat) && isNum(lng)) destination = `${Number(lat)},${Number(lng)}`;
  else {
    const words = String(address ?? '').trim();
    if (!words) return null;
    destination = encodeURIComponent(placeWords(words, city, province));
  }
  const travel = MODES.includes(mode) ? `&travelmode=${mode}` : '';
  return `https://www.google.com/maps/dir/?api=1&destination=${destination}${travel}`;
};

export const searchUrl = ({ lat, lng }) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
