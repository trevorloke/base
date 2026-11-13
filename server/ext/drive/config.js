// Google Drive's settings for this server, all from the environment
// (Render). The OAuth client, the token key and the public address are
// Google sign-in's (lib/google/config.js); Drive adds two, both safe in a
// browser but never in the repo, the database or the web build:
//
//   GOOGLE_PICKER_KEY             a browser key limited to base.win's
//                                 addresses and to the Google Picker API
//   GOOGLE_CLOUD_PROJECT_NUMBER   digits: the Picker's app ID, the project
//                                 that holds the OAuth client
//   GOOGLE_DRIVE_API_BASE, GOOGLE_SHEETS_API_BASE, GOOGLE_PICKER_SCRIPT
//                                 test addresses (server/test/fake-google.js);
//                                 ignored in production
//
// And the campaign's own switches, in workspace settings.drive:
//   { on: false, sheets: 'off' | 'managers' | 'desk', folder: { id, name, shared } | null }
import { googleSetup } from '../../lib/google/config.js';

export const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
export const DESK = ['manager', 'treasurer', 'staff'];

const env = (k) => String(process.env[k] || '').trim();
const production = () => process.env.NODE_ENV === 'production';
const testBase = (k) => (production() ? '' : env(k).replace(/\/+$/, ''));

export const driveBase = () => testBase('GOOGLE_DRIVE_API_BASE') || 'https://www.googleapis.com';
export const sheetsBase = () => testBase('GOOGLE_SHEETS_API_BASE') || 'https://sheets.googleapis.com';
export const pickerScript = () => testBase('GOOGLE_PICKER_SCRIPT') || 'https://apis.google.com/js/api.js';
export const testBaseInUse = () => Boolean(testBase('GOOGLE_DRIVE_API_BASE') || testBase('GOOGLE_SHEETS_API_BASE') || testBase('GOOGLE_PICKER_SCRIPT'));

export const pickerKey = () => env('GOOGLE_PICKER_KEY');
export const projectNumber = () => env('GOOGLE_CLOUD_PROJECT_NUMBER');

// → { ok, missing: [setting names], connections } — ok once Google's
// connections work and both of Drive's settings are right.
export const driveSetup = () => {
  const missing = [];
  if (!pickerKey()) missing.push('GOOGLE_PICKER_KEY');
  if (!/^\d{1,20}$/.test(projectNumber())) missing.push('GOOGLE_CLOUD_PROJECT_NUMBER');
  const connections = googleSetup().connect;
  return { ok: connections && !missing.length, missing, connections };
};

const SHEETS = ['off', 'managers', 'desk'];
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : (v || {}));
export const driveRules = (settings) => {
  const d = parse(settings)?.drive || {};
  const f = d.folder && d.folder.id ? { id: String(d.folder.id), name: String(d.folder.name || ''), shared: d.folder.shared === true } : null;
  return { on: d.on === true, sheets: SHEETS.includes(d.sheets) ? d.sheets : 'off', folder: f };
};
export const SHEETS_CHOICES = SHEETS;
