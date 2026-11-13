// Google Drive and Sheets, for the desk: one Google permission (drive.file —
// only the files people use with base.win), on GSI's one Google connection
// (lib/google/). INTEGRATIONS.md "Google Drive and Sheets" is the long version.
//
//   config.js   settings (GOOGLE_PICKER_KEY, GOOGLE_CLOUD_PROJECT_NUMBER) and
//               the campaign's switches (settings.drive)
//   grant.js    driveGrant — the only way Drive code gets a connection
//   files.js    Drive: a file, the "base.win exports" folder, a new Sheet
//   sheets.js   Sheets: the grid, the rows (RAW, exact ranges)
//   export.js   drive.export's job: one part per job
//   picker.js   the Picker's narrowed token
//   actions.js  drive.settings · folder · folder.reach · export · export.retry
//   api.js      GET /api/drive, /drive/picker, /drive/exports(/:id)
//   service.js  the row on Settings → Services, and its Check
import { definePurpose } from '../../lib/google/purposes.js';
import { registerIntegration } from '../integrations/index.js';
import { DRIVE_FILE, driveSetup } from './config.js';
import { JOB, runExportJob } from './export.js';

definePurpose('drive', {
  label: 'Google Drive',
  scopes: [DRIVE_FILE],
  roles: ['manager', 'treasurer', 'staff'],
  area: null,
  domain: (s) => s.google?.domain || null,
  browserToken: true,
});
// The server's half only: whether a campaign turned Drive on is GET /api/drive's.
registerIntegration('drive', () => driveSetup().ok);

export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';
export const jobs = { [JOB]: runExportJob };
export const exportTables = ['drive_exports'];
export const deskOnlyReads = ['/drive', '/drive/picker', '/drive/exports', '/drive/exports/:id'];
