// base.win's signing key. PLATFORM_SIGNING_KEY is a value Render made (32+
// characters); while changing keys it holds "new,old" and the first signs.
// The Ed25519 seed is SHA-256 of a fixed prefix and the value, so nobody
// runs a command to make a key. Clients hold only the public half
// (BASE_PLATFORM_PUBKEY: 43 base64url characters), told apart by its kid
// (the first 8 hex of SHA-256 of the raw public key).
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { cfg } from './config.mjs';

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
export const SIGNING_KEY_MIN = 32;

export const seedOf = (value) => createHash('sha256').update(`base.win/platform-signing/v1\n${String(value).split(',')[0].trim()}`, 'utf8').digest();
export const privateKeyOf = (value) => createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seedOf(value)]), format: 'der', type: 'pkcs8' });
const rawOf = (value) => createPublicKey(privateKeyOf(value)).export({ format: 'der', type: 'spki' }).subarray(-32);
export const kidOfRaw = (raw) => createHash('sha256').update(raw).digest('hex').slice(0, 8);
// → { publicKey (43 chars), kid } for the first value in a list.
export const publicKeyOf = (value) => {
  const raw = rawOf(value);
  return { publicKey: raw.toString('base64url'), kid: kidOfRaw(raw) };
};

// Every usable value in PLATFORM_SIGNING_KEY, the signing one first.
export const signingValues = (value = cfg().signingKey) => String(value || '').split(',').map((v) => v.trim()).filter((v) => v.length >= SIGNING_KEY_MIN);
export const platformKeys = () => signingValues().map((v) => ({ ...publicKeyOf(v), value: v }));
// The kid that signs now, or null when there is no usable key.
export const currentKid = () => platformKeys()[0]?.kid || null;
