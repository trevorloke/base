// What staging's sample is made from, recorded (not a test; used by
// samplecampaign.test.js and staging-walk.test.js).
//
// SAMPLE_PRINT: a sha256 of the sample's people, its cast, its shifts and
// the three staging-block values stored when the campaign is made. When the
// sample changes, the print changes: raise SAMPLE_VERSION in
// server/lib/samplecampaign.js (so staging makes the sample again by
// itself) and record the new print here with that version.
//
// STARTING_FIELDS: the profile fields a new campaign starts with, by name
// and in order, as staging shows them. When they change, staging's sample
// needs making again too: raise SAMPLE_VERSION and update this list.
//
// A print only tells that something changed. What the sample must hold is
// checked word by word in the tests themselves.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const SAMPLE_PRINT = { version: 3, print: 'a20bfee941d1d43142b3470f2a53d5da817bfb96688c11079f9fe75144efcc9c' };

export const STARTING_FIELDS = [
  'House notes', 'Building notes', 'Access type', 'Dwelling type', 'Email opt-in', 'SMS opt-in',
  'Language', 'Notes', 'Faith', 'Interested in being a candidate',
];

// One service's block of render.yaml: every key with a value written in
// the file, as { KEY: 'value' }. stagingBlock(): base-win-staging's.
export const serviceBlock = (service) => {
  const yaml = readFileSync(new URL('../../render.yaml', import.meta.url), 'utf8');
  const at = new RegExp(`\\n\\s+name: ${service}\\n`).exec(yaml);
  if (!at) throw new Error(`render.yaml has no service ${service}`);
  const end = yaml.indexOf('\n  - type:', at.index + 1);
  const block = yaml.slice(at.index, end === -1 ? undefined : end);
  const out = {};
  const re = /- key: (\w+)[^\n]*\n\s+value: ("(?:[^"\\]|\\.)*"|[^\n#]*)/g;
  for (let m = re.exec(block); m; m = re.exec(block)) {
    const raw = m[2].trim();
    out[m[1]] = raw.startsWith('"') ? JSON.parse(raw) : raw;
  }
  return out;
};
export const stagingBlock = () => serviceBlock('base-win-staging');

// The print of what the code makes now.
export const printNow = async () => {
  const { samplePeople } = await import('../lib/samplecampaign.js');
  const cast = await import('../lib/samplecast.js');
  const block = stagingBlock();
  const what = {
    people: samplePeople(320),
    cast: Object.fromEntries(Object.keys(cast).sort().map((k) => [k, cast[k]])),
    shifts: cast.SHIFTS,
    block: { STARBASE_ORG_NAME: block.STARBASE_ORG_NAME, STARBASE_JURISDICTION: block.STARBASE_JURISDICTION, STARBASE_TZ: block.STARBASE_TZ },
  };
  return createHash('sha256').update(JSON.stringify(what)).digest('hex');
};
