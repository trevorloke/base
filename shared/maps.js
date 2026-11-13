// Links out to Google Maps (Maps URLs: no key, no charge, nothing to set up).
//
// directionsUrl({ lat, lng, address, city, province }, { mode }) → the phone's
//   Google Maps with directions to a place: its pin when it has one, else its
//   words ("13450 104 Ave, Surrey, BC"; words that already carry a comma are
//   sent as they are). mode: walking | driving | bicycling | transit, else
//   Google picks. Never an origin: the phone's Google Maps starts from where
//   it is, and base.win never sends anyone's location to Google. null when
//   there is neither a pin nor an address. Right on a screen.
// searchUrl({ lat, lng }) → a search for a point: the link in texts, emails
//   and calendar files (shiftkinds.js mapUrl), unchanged.
const MODES = ['walking', 'driving', 'bicycling', 'transit'];
const isNum = (v) => v != null && v !== '' && Number.isFinite(Number(v));

export const directionsUrl = ({ lat, lng, address, city, province } = {}, { mode } = {}) => {
  let destination = null;
  if (isNum(lat) && isNum(lng)) destination = `${Number(lat)},${Number(lng)}`;
  else {
    const words = String(address ?? '').trim();
    if (!words) return null;
    destination = encodeURIComponent(words.includes(',') ? words
      : [words, String(city ?? '').trim(), String(province ?? '').trim()].filter(Boolean).join(', '));
  }
  const travel = MODES.includes(mode) ? `&travelmode=${mode}` : '';
  return `https://www.google.com/maps/dir/?api=1&destination=${destination}${travel}`;
};

export const searchUrl = ({ lat, lng }) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
