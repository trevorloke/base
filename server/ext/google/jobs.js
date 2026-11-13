// google.revoke: clean-up (a purpose's onRevoke), then the token revoked at
// Google — always after the write that let it go has committed, never
// inside a campaign's write lock (lib/google/tokens.js revokeJob).
import { revokeJob } from '../../lib/google/tokens.js';

export const jobs = { 'google.revoke': revokeJob };
