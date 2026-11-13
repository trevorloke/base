// Google's notice to the people using base.win (Google Maps terms §3.2.2(a):
// the app says it includes Google Maps and that Google's terms and privacy
// policy apply). base.win has no terms page of its own, so one muted line, at
// the foot of the map's Show sheet and as the last line of Your profile —
// only while Google is the map or its address suggestions are on.
//   google: /api/map/config's { tiles, places }
import './google-notice.css';

const TERMS = 'https://maps.google.com/help/terms_maps/';
const PRIVACY = 'https://policies.google.com/privacy';

export default function GoogleNotice({ google }) {
  if (!google?.tiles && !google?.places) return null;
  return (
    <p className="google-notice">
      {google.places ? 'Maps and address suggestions by Google.' : 'Maps by Google.'}{' '}
      <a href={TERMS} target="_blank" rel="noopener noreferrer">Google Maps terms</a>
      <span aria-hidden="true"> · </span>
      <a href={PRIVACY} target="_blank" rel="noopener noreferrer">Google privacy</a>
    </p>
  );
}
