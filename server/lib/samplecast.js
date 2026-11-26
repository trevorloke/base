// Every name in staging's sample campaign (lib/samplecampaign.js), in one
// file. Nothing else may seed a name on staging. Staging is public, so
// nothing in it is real: the surnames, the opponents and their elector
// organizations, and the names kept for later were all made up for the
// sample. A first name alone names nobody, so the first names are ordinary
// ones. The four neighbourhoods and their streets are Vancouver's own: they
// are the street map, not anybody's record.
//
// Changing anything here changes what the sample holds: raise
// SAMPLE_VERSION in lib/samplecampaign.js by one, and record the new print
// in server/test/sample-prints.js.

export const FIRST_NAMES = ['Avery', 'Jordan', 'Mei', 'Arjun', 'Sofia', 'Liam', 'Noor', 'Ethan', 'Priya', 'Lucas', 'Hana', 'Owen', 'Camille', 'Diego', 'Amara', 'Felix',
  'Yuki', 'Nadia', 'Marcus', 'Elena', 'Kofi', 'Isla', 'Rohan', 'Chloe', 'Tariq', 'Naomi', 'Henrik', 'Leila', 'Joon', 'Maya', 'Callum', 'Ines'];

// Made up, so a first name and a surname together are nobody's.
export const SURNAMES = ['Alderquist', 'Ashquill', 'Birchlander', 'Brambleholt', 'Calderwyn', 'Copperwend', 'Dapplewyn', 'Dunmarrow', 'Elmsreach', 'Embermoss',
  'Fennimoor', 'Garrowmere', 'Hollowmere', 'Ivorstone', 'Jessamoor', 'Kestrelby', 'Larkhollow', 'Marrowfield', 'Nettlewick', 'Orrinsdale',
  'Pellamoor', 'Quillhaven', 'Rookmantle', 'Sablecourt', 'Thistlewade', 'Umberfell', 'Vantermoor', 'Wrenfallow', 'Yarrowgate', 'Zellamere'];

// The opponents on the sample's rating scale, each with a made-up elector
// organization. render.yaml's staging block sets them (STARBASE_CANDIDATES,
// exactly this line); the app's buttons say "Opposed — Avendrel", and the
// organization shows in /api/scale and in lists the server makes.
export const OPPONENTS = [
  { code: '4A', name: 'Avendrel', label: 'Opposed — Lantern Quay Electors / Tamsin Avendrel' },
  { code: '4B', name: 'Brindlemoor', label: 'Opposed — Juniper Bridge Alliance / Odell Brindlemoor' },
  { code: '4C', name: 'Castramont', label: 'Opposed — Foghorn Civic League / Mireille Castramont' },
];
export const OPPONENTS_LINE = OPPONENTS.map((o) => `${o.code}:${o.name}:${o.label}`).join(';');

// Kept for anything added later. None of these is seeded today: the
// screens they would fill stay empty until someone wants them filled.
export const RESERVED = Object.freeze({
  campaign: 'Sample Campaign',
  candidates: [{ name: 'Imogen Starrowby', office: 'City council' }, { name: 'Rafael Pendlemere', office: 'School board' }],
  media: ['The Tarnwhistle Ledger', 'Radio Kelpline 88.8'], // no Canadian or U.S. FM station sits on an even tenth
  union: 'Amalgamated Kite Menders, Local 000',
  business: 'Thimble & Kettle Supply Co.',
  school: 'Larkspur Hollow Elementary',
  campus: 'Tarnwhistle College',
  church: 'Tidepool Fellowship Hall',
  venue: 'Marigold Room, 9940 Main St',
  votingPlaces: ['Sample voting place 1, 9950 Main St', 'Sample voting place 2, 9950 W 4th Ave'],
  // Links only to https://example.org/…; no social handles (nobody can
  // promise one is unowned); phones 604-555-01xx; emails at example.org,
  // example.com or demo@base.win.
});

// Four Vancouver neighbourhoods as boxes [south, west, north, east], with
// five streets each that run through the box.
export const AREAS = [
  { name: 'Mount Pleasant', box: [49.2555, -123.1100, 49.2675, -123.0905], color: '#2f6fed', streets: ['E 10th Ave', 'E 12th Ave', 'Quebec St', 'Ontario St', 'Main St'] },
  { name: 'Kitsilano', box: [49.2625, -123.1700, 49.2720, -123.1505], color: '#1f9d6b', streets: ['W 4th Ave', 'W 6th Ave', 'Yew St', 'Vine St', 'Balsam St'] },
  { name: 'Grandview-Woodland', box: [49.2685, -123.0750, 49.2800, -123.0600], color: '#c7411f', streets: ['Charles St', 'Kitchener St', 'Graveley St', 'Cotton Dr', 'Victoria Dr'] },
  { name: 'Sunset', box: [49.2180, -123.1000, 49.2300, -123.0805], color: '#8a4fd3', streets: ['E 49th Ave', 'E 51st Ave', 'Prince Edward St', 'Fraser St', 'Ross St'] },
];

// House numbers: 9900 to 9999. As far as we know no street in the City of
// Vancouver has a 9900 block (north-south numbers end near 9100 at the
// Fraser River; avenues end at about 3700 east and 4700 west).
export const HOUSE_FIRST = 9900;
export const HOUSE_LAST = 9999;

// One straight piece of each street's centreline inside its neighbourhood's
// box, as two end points [[lat, lng], [lat, lng]]: a person's pin is
// (number - 9900) / 100 of the way along it, so the dot is in the roadway.
// Looked up once, by hand, from the B.C. Address Geocoder's intersection
// lookup, and kept here as numbers; staging never looks anything up.
// Not looked up yet: a street with no segment here gets a pin inside its
// neighbourhood's box, which can sit on somebody's lot.
export const SEGMENTS = Object.freeze({});

// The sample's shifts: [title, where, days from now, hour (UTC)]. A street
// corner is a place to meet, not a venue; the campaign office has no address.
export const SHIFTS = [
  ['Door knocking: Mount Pleasant', 'Main St at E 12th Ave', 1, 1],
  ['Phone bank', 'Campaign office', 2, 2],
  ['Door knocking: Kitsilano', 'W 4th Ave at Yew St', 3, 1],
  ['Sign crew', 'Campaign office', 4, 18],
  ['Door knocking: Sunset', 'Fraser St at E 49th Ave', 5, 19],
];

export const TAGS = ['volunteer', 'lawn sign', 'donor', 'newsletter', 'renter', 'small business'];
