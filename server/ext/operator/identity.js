// This server's instance id (sql.js platform_identity): read once per
// database and kept. null when the database can't be read.
const known = new WeakMap();

export const instanceOf = async (db) => {
  if (known.has(db)) return known.get(db);
  const r = (await db.query('select instance from platform_identity where id = 1')).rows[0];
  if (r?.instance) known.set(db, r.instance);
  return r?.instance || null;
};
