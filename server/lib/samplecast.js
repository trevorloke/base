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
// organization. render.yaml's staging block sets them (BASE_CANDIDATES,
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

// House numbers: 9900 to 9999, which none of these streets has. Checked on
// 2026-11-27 (scripts/sample-streets.mjs) in the City of Vancouver's open
// data: its property addresses and business licences hold no number from
// 9900 to 9999 on any of the 20 streets, and no street in the city has a
// block numbered higher than 9300. Charles, Kitchener and Graveley also run
// on in Burnaby, whose list was not checked; the address says Vancouver.
export const HOUSE_FIRST = 9900;
export const HOUSE_LAST = 9999;

// One straight piece of each street's centreline inside its neighbourhood's
// box, as two end points [[lat, lng], [lat, lng]]: a person's pin is
// (number - 9900) / 100 of the way along it, so the dot is in the roadway,
// and the numbers rise the way the street's own do (its low-numbered end
// comes first). Each piece is the longest straight run of whole blocks
// inside the box, every corner along it within 1.5 m of the line, counting
// the City's blocks written as a range ("1500-1600 E 10TH AV") too.
// Source: the City of Vancouver's "Public streets" open data (street
// centrelines), looked up on 2026-11-27 by scripts/sample-streets.mjs and
// kept here as numbers; staging never looks anything up. Contains
// information licensed under the Open Government Licence – Vancouver
// (https://opendata.vancouver.ca/pages/licence/).
// A street with no piece here would get a pin inside its neighbourhood's
// box, which can sit on somebody's lot; every street has one.
export const SEGMENTS = Object.freeze({
  'E 10th Ave': [[49.26208, -123.104935], [49.261968, -123.098639]],
  'E 12th Ave': [[49.259773, -123.096123], [49.259732, -123.091099]],
  'Quebec St': [[49.267351, -123.102779], [49.255716, -123.10327]],
  'Ontario St': [[49.267386, -123.104714], [49.256657, -123.105169]],
  'Main St': [[49.267314, -123.100775], [49.255681, -123.101266]],
  'W 4th Ave': [[49.268131, -123.152766], [49.268368, -123.168312]],
  'W 6th Ave': [[49.266416, -123.152831], [49.2666, -123.164441]],
  'Yew St': [[49.271696, -123.155004], [49.262901, -123.155334]],
  'Vine St': [[49.271734, -123.157374], [49.262939, -123.157703]],
  'Balsam St': [[49.271772, -123.159744], [49.262976, -123.160069]],
  'Charles St': [[49.273075, -123.074328], [49.272973, -123.060534]],
  'Kitchener St': [[49.272172, -123.074344], [49.272066, -123.060552]],
  'Graveley St': [[49.270537, -123.073475], [49.270444, -123.06187]],
  'Cotton Dr': [[49.273956, -123.071486], [49.268712, -123.071573]],
  'Victoria Dr': [[49.277535, -123.065616], [49.268664, -123.065771]],
  'E 49th Ave': [[49.225524, -123.094091], [49.225354, -123.081435]],
  'E 51st Ave': [[49.223681, -123.097566], [49.223456, -123.081512]],
  'Prince Edward St': [[49.227484, -123.09745], [49.220067, -123.097682]],
  'Fraser St': [[49.229183, -123.090661], [49.218255, -123.090953]],
  'Ross St': [[49.225381, -123.082815], [49.221878, -123.082951]],
});

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
