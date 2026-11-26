// This server's instance id (sql.js platform_identity), or null. Read each
// time, never kept. Staging's sample is made again by itself when a release
// carries a newer one (lib/samplecampaign.js): the instance is carried over
// that, so the control centre still knows the server. Only the reset word
// (STARBASE_SAMPLE_RESET) makes the database again with a new instance.
export const instanceOf = async (db) =>
  (await db.query('select instance from platform_identity where id = 1')).rows[0]?.instance || null;
