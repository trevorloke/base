// Clear someone's two-step sign-in from the server's own shell — for the one
// case the app can't: the campaign's only manager lost their phone and their
// recovery codes (any other manager can reset theirs under Settings →
// Members). They're signed out everywhere and sign in with their password;
// it's on the campaign's event log ("from the server").
//
//   node scripts/reset-two-step.mjs someone@example.org
//
// On Render: the service → Shell. It uses the same database settings as the
// server (DATABASE_URL, or STARBASE_DATA).
import { getDb } from '../server/db/client.js';
import { runAction } from '../server/lib/events.js';
import { resetFromServer } from '../server/lib/twostep.js';

const email = process.argv[2];
if (!email || !email.includes('@')) {
  console.error('Usage: node scripts/reset-two-step.mjs someone@example.org');
  process.exit(2);
}
const db = await getDb();
const spaces = await resetFromServer(db, email, runAction);
if (!spaces) {
  console.error(`No account for ${email}.`);
  await db.close();
  process.exit(1);
}
console.log(`Two-step sign-in cleared for ${email}: signed out everywhere; on the event log of ${spaces.length} campaign${spaces.length === 1 ? '' : 's'}.`);
await db.close();
