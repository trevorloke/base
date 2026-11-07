// History from an imported list: a list's own record of each person's last
// interaction ("Interaction Status" + "Interaction Date") comes in as a
// knock or a call on that day, and its Sign column as a lawn sign — so the
// map, the field report and the sign list know what the campaign already
// did. The import screen asks what each status means (routes/data.js does
// the writing).
//   contacts.source  'import' for a conversation that came from a list (no
//                    one on the team logged it, so created_by is empty);
//                    null for every knock, call and talk logged here.
export const sql = `
alter table contacts add column if not exists source text;
create index if not exists contacts_import_idx on contacts (workspace_id, person_id) where source = 'import';
`;
