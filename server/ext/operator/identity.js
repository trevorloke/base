// This server's instance id (sql.js platform_identity), or null. Read each
// time, never kept: staging's sample reset makes the database again at boot
// (lib/samplecampaign.js), and with it a new instance.
export const instanceOf = async (db) =>
  (await db.query('select instance from platform_identity where id = 1')).rows[0]?.instance || null;
