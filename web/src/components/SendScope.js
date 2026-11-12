// Where a send's screens read and write: Outreach's own (GET /api/blasts,
// /api/blasts/stats, blast.resend) or the Media tab's (GET /api/media/releases,
// /api/media/stats, media.resend), so someone holding Media but not Outreach
// sees the same rows, results and Try again. pages/Media.jsx wraps its
// screen in <SendScope.Provider value={MEDIA_SCOPE}>.
import { createContext, useContext } from 'react';

export const OUTREACH_SCOPE = {
  listKey: ['blasts'], listPath: '/blasts', rows: (d) => d?.blasts,
  statsKey: ['blasts', 'stats'], statsPath: '/blasts/stats',
  resend: 'blast.resend',
};
export const MEDIA_SCOPE = {
  listKey: ['media', 'releases'], listPath: '/media/releases', rows: (d) => d?.releases,
  statsKey: ['media', 'releases', 'stats'], statsPath: '/media/stats',
  resend: 'media.resend',
};
export const SendScope = createContext(OUTREACH_SCOPE);
export const useSendScope = () => useContext(SendScope);
