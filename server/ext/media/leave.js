// Off the media list. A press release's own unsubscribe link (/bu, in
// routes/public.js) takes everyone with that address off it — both tags,
// whatever their capitals — and keeps a row saying when and how, so the
// desk can't put them back (media.contact.add refuses) and History says so.
// It touches nothing else: not the newsletter, no do-not-email tag, and so
// nothing at Mailchimp.
import { offMedia } from './rules.js';

const parseJ = (v) => (typeof v === 'string' ? JSON.parse(v) : (v || []));

// One person off the list, `how` 'link' or 'desk'; the row (outlet, beat,
// note) is kept, so adding them back brings it back.
export const takeOff = async (tx, workspaceId, p, how, emit, source) => {
  const tags = parseJ(p.tags);
  const next = offMedia(tags);
  if (next.length !== tags.length) {
    await tx.query('update persons set tags = $3, updated_at = now() where id = $1 and workspace_id = $2', [p.id, workspaceId, JSON.stringify(next)]);
    emit('person', p.id, 'update', { tags: next, source });
  }
  await tx.query(
    `insert into media_contacts (workspace_id, person_id, left_at, left_how, updated_at) values ($1, $2, now(), $3, now())
     on conflict (workspace_id, person_id) do update set left_at = now(), left_how = excluded.left_how, updated_at = now()`,
    [workspaceId, p.id, how],
  );
  emit('media_contact', p.id, 'update', { left: how });
};

export const leaveByLink = async (tx, workspaceId, email, emit) => {
  const people = (await tx.query(
    'select id, tags from persons where workspace_id = $1 and lower(email) = $2 and deleted_at is null', [workspaceId, email],
  )).rows;
  for (const p of people) await takeOff(tx, workspaceId, p, 'link', emit, 'press-unsubscribe');
  return people.length;
};
