// Google Sheets over plain fetch, through GSI's googleFetch, at most one
// call per person every 1.1 s (Sheets allows 60 a minute per person).
//
//   shapeSheet(db, g, id, { rows, cols })  first tab named "base.win", its
//       grid rows × cols, row 1 frozen
//   growSheet(db, g, id, more)             more rows at the end
//   writeRows(db, g, id, at, values)       the exact range 'base.win'!A<at>,
//       RAW: nothing is ever run as a formula, nothing guessed; a part tried
//       again lands on the same rows, never twice (never values.append)
//   readSheet(db, g, id)                   the Services Check's spreadsheets.get
import { googleFetch } from '../../lib/google/tokens.js';
import { sheetsBase } from './config.js';

export const TAB = 'base.win';
const PACE = { ms: 1100 };
export const _setPaceForTest = (ms) => { PACE.ms = ms; };
const last = new Map(); // user id → when their last Sheets call went

const paced = async (g) => {
  const wait = (last.get(g.userId) || 0) + PACE.ms - Date.now();
  if (wait > 0) await new Promise((r) => { setTimeout(r, wait); });
  last.set(g.userId, Date.now());
  if (last.size > 5000) last.clear();
};
const sheet = (id, path = '') => `${sheetsBase()}/v4/spreadsheets/${encodeURIComponent(id)}${path}`;
const call = async (db, g, url, init) => {
  await paced(g);
  return googleFetch(db, g, url, { headers: { 'Content-Type': 'application/json' }, ...init });
};
const quoted = (title) => `'${String(title).replace(/'/g, "''")}'`;

export const shapeSheet = (db, g, id, { rows, cols }) => call(db, g, sheet(id, ':batchUpdate'), {
  method: 'POST',
  body: JSON.stringify({
    requests: [{
      updateSheetProperties: {
        properties: { sheetId: 0, title: TAB, gridProperties: { rowCount: rows, columnCount: cols, frozenRowCount: 1 } },
        fields: 'title,gridProperties(rowCount,columnCount,frozenRowCount)',
      },
    }],
  }),
});

export const growSheet = (db, g, id, more) => call(db, g, sheet(id, ':batchUpdate'), {
  method: 'POST',
  body: JSON.stringify({ requests: [{ appendDimension: { sheetId: 0, dimension: 'ROWS', length: more } }] }),
});

export const writeRows = (db, g, id, at, values) => {
  const range = `${quoted(TAB)}!A${at}`;
  return call(db, g, `${sheet(id, `/values/${encodeURIComponent(range)}`)}?valueInputOption=RAW`, {
    method: 'PUT',
    body: JSON.stringify({ range, majorDimension: 'ROWS', values }),
  });
};

export const readSheet = (db, g, id) => googleFetch(db, g, `${sheet(id)}?fields=sheets.properties`);
