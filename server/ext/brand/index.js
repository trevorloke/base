// The campaign's brand (Settings → Brand, managers): one colour in, every
// shade out (shared/brand-look.js); its logos, mark and app icons; what
// training is called and the name under the home-screen icon. Stored as
// workspaces.settings.brand and worn by every page — the app's (signed in or
// not), the manifest, the app's public pages, the newsletter and a website
// that follows it — through server/lib/brand.js.
//
//   actions.js   brand.picture · brand.save · brand.reset
//   pictures.js  what each picture may be (type and size read from its bytes)
//   sql          media.brand_kind: which brand picture an upload is
//   GET /brand/:id   a brand picture (no sign-in: the sign-in page shows the
//                    logo). The same bytes as /media/:id, at an address of
//                    its own so the service worker keeps it for no signal
//                    (web/public/sw.js leaves /media to the network).
import { Hono } from 'hono';
import { getDb } from '../../db/client.js';
import { serveMedia } from '../abtests/media.js';

export { actions } from './actions.js';

// A brand picture says which it is (logo, mark, an app icon…): the website's
// "Choose one uploaded" leaves them out (ext/site api.js). The media table
// is Outreach's (ext/abtests, loaded before this).
export const sql = 'alter table media add column if not exists brand_kind text;';

export const publicRoutes = new Hono();
publicRoutes.get('/brand/:id', async (c) => serveMedia(c, await getDb()));
