// At start-up, before anything else reads a setting: every setting still set
// under its older name in Render is copied into its new name where the new
// one is blank, so the whole server — and the files that read a setting the
// moment they load (shared/canvass.js's slates, shared/scale.js's
// candidates, routes/auth.js's secure-cookie switch, the brand) — runs as it
// did before the rename. Nothing is removed or changed under an older name,
// and nothing is ever written back to Render.
//
// server/index.js imports this file first. It says in the log, once per
// setting, which older names are still in use and what to rename them to,
// and which settings are set under both names with different values (the
// new one is used). Names only, never a value. The lines are built from the
// table in shared/old-names.js.
//
// Settings → Services lists the same older names (olderNames below), read
// afresh each time it is asked.
import { adoptOldNames, OLD_SETTINGS } from '@base-win/shared/old-names';

export const adopted = adoptOldNames(process.env);

// One line per older name in use, then one per conflict. → [line…]
export const adoptLines = ({ stillOld, differ }) => [
  ...stillOld.map((now) => `base.win: the setting ${OLD_SETTINGS[now]} still works; rename it to ${now} in Render.`),
  ...differ.map((now) => `base.win: ${now} and its older name are both set and differ; ${now} is used.`),
];
for (const line of adoptLines(adopted)) console.warn(line);

// The settings on this server still under an older name, now: [{ old, now }].
// Worked out on a copy, so asking changes nothing.
export const olderNames = (env = process.env) => adoptOldNames({ ...env }).stillOld.map((now) => ({ old: OLD_SETTINGS[now], now }));
