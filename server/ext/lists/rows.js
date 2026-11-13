// A list as rows: what GET /api/lists/:id/export.csv downloads and what
// "Send to Google Sheets" writes (ext/drive), the same ten columns. The CSV
// reads everyone at once (peopleOf, up to 100,000); the Sheet reads pages
// by name (peoplePage), with no cap.
import { peopleCount, peopleOf, peoplePage } from './audience.js';

export const LIST_HEAD = ['Name', 'Email', 'Phone', 'Address', 'Unit', 'City', 'Postal code', 'Rating', 'Tags', 'Added'];
const listRow = (p) => [p.name, p.email, p.phone, p.address, p.unit, p.city, p.postal, p.rating, p.tags.join('; '), p.created_at];

export const listRows = async (db, ctx, list) => {
  const { people } = await peopleOf(db, ctx, { list });
  return { head: LIST_HEAD, rows: people.map(listRow) };
};

export const listCount = (db, ctx, list) => peopleCount(db, ctx, { list });

// → { rows, next }: next is the cursor for the page after (null at the end).
export const listPage = async (db, ctx, list, { cursor = null, limit = 1000 } = {}) => {
  const people = await peoplePage(db, ctx, { list, after: cursor, limit });
  const last = people.at(-1);
  return { rows: people.map(listRow), next: people.length === limit && last ? { key: last._key, id: last.id } : null };
};
