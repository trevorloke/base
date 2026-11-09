// The "volunteer" tag, found without reading a city-wide voter list row by
// row (data.js loadVolunteers asks exactly this). A partial index: only the
// few people who carry the tag are in it.
export const sql = `
create index if not exists persons_volunteer_tag_idx on persons (workspace_id)
  where deleted_at is null and (tags @> '["volunteer"]'::jsonb or tags @> '["Volunteer"]'::jsonb);
`;
