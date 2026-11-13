// How much of Google's map services the campaign used each day
// (lib/gusage.js): a date, a kind (tiles, autocomplete, details, probe) and a
// number. No person, no workspace: it is the server's count against Google's
// free use, kept so a restart doesn't start it again. Not in the export.
export const sql = `
create table if not exists google_usage (
  day date not null,
  kind text not null,
  n integer not null default 0,
  primary key (day, kind)
);
`;
