# Time-zone rules for Node (ICU)

British Columbia moved to permanent UTC-7 on November 1, 2026 (tz database
2026e). Node's built-in time-zone data can be older than that, and then
every "Pacific time" calculation on the site (event times, calendar files,
reminders, the January switch of the contribution limit) is an hour off.

These four files are ICU's compiled tz data for **2026e**, copied unchanged
from https://github.com/unicode-org/icu-data/tree/main/tzdata/icunew/2026e/44/le
Node loads them when `ICU_TIMEZONE_FILES_DIR` points at this folder, which
the npm scripts (`dev`, `build`, `start`, `test`, the deploy builds) and the
e2e runner do. Start the site with `npm start` (not `next start`) so it
applies.

To update after a future tz release: download the same four files from the
newest `icunew/<version>/44/le` folder, replace these, and run `npm test`
(tests/timezone.test.ts checks Vancouver's offset).
