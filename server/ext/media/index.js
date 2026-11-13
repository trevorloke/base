// Media: press releases to reporters and influencers (the Media tab).
//
// A contact is a person tagged media or influencer (any capitals), so
// People, lists, exports, History and socials all keep working; this
// feature adds what a person has no place for — outlet, beat, a note — and
// when and how they left the list.
//
//   rules.js    onMedia (SQL) and its JS twin: who is on the list
//   leave.js    off the list, by a release's own link (/bu) or the desk
//   actions.js  media.contact.*, media.send / test / resend / attach / picture
//   api.js      GET /api/media/contacts, /releases, /releases/:id
// A release itself is a blast of kind press (actions/field.js, ext/abtests).
export { actions } from './actions.js';
export { api } from './api.js';

// One row per person ever on the list: outlet, beat and note survive a
// removal, so adding them back brings them back. left_how: 'link' (their
// own unsubscribe — the desk can't add them back) or 'desk'. No index
// beyond the key: the contacts read is rare and capped.
export const sql = `
create table if not exists media_contacts (
  workspace_id uuid not null,
  person_id uuid not null,
  outlet text check (outlet is null or length(outlet) <= 160),
  beat text check (beat is null or length(beat) <= 160),
  note text check (note is null or length(note) <= 500),
  left_at timestamptz,
  left_how text check (left_how is null or left_how in ('link', 'desk')),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, person_id)
);`;

export const exportTables = ['media_contacts'];

// Two records made one: if drop left by a release's link, keep has left
// too (the merge drops drop's row when keep has one), so the reach rule
// (lib/reach.js left_media) still holds. Keep's outlet, beat and note stand.
const personMerging = async (tx, ctx, { keep, drop }) => {
  await tx.query(
    `insert into media_contacts (workspace_id, person_id, left_at, left_how, updated_at)
     select $1, $2, d.left_at, 'link', now() from media_contacts d where d.workspace_id = $1 and d.person_id = $3 and d.left_how = 'link'
     on conflict (workspace_id, person_id) do update set left_at = excluded.left_at, left_how = 'link', updated_at = now()`,
    [ctx.workspaceId, keep.id, drop.id],
  );
};
export const hooks = { personMerging };
