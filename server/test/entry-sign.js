// Tests only: signs an entry token as the control centre does
// (apps/platform/mint.mjs), from a test signing key. Imported only under
// server/test and by e2e-entry.mjs (a structural test checks).
import { createHash, createPrivateKey, sign } from 'node:crypto';

const PK8 = Buffer.from('302e020100300506032b657004220420', 'hex');

export const signEntry = (signingKey, payload) => {
  const first = String(signingKey).split(',')[0].trim();
  const seed = createHash('sha256').update('base.win/platform-signing/v1\n' + first, 'utf8').digest();
  const priv = createPrivateKey({ key: Buffer.concat([PK8, seed]), format: 'der', type: 'pkcs8' });
  const P = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const S = sign(null, Buffer.from('bw-entry.v1.' + P, 'ascii'), priv).toString('base64url');
  return `bw-entry.v1.${P}.${S}`;
};
