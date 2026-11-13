// Stored Google refresh tokens, sealed with GOOGLE_TOKEN_KEY — the same
// shape as two-step's (lib/twostep.js), `v1.<kid>.<iv>.<tag>.<body>`,
// AES-256-GCM, but its own derived keys (its own HKDF info), so even the
// same value set in both variables never opens the other's.
//
// There is no fallback key in the database (two-step keeps one there): no
// key, no connections — sealToken throws NoTokenKey and connecting is
// refused before anyone reaches Google. A lost key means people connect
// again; nothing else is lost.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export const TOKEN_KEY_ENV = 'GOOGLE_TOKEN_KEY';
export const TOKEN_KEY_MIN = 32;
const derive = (raw, info) => Buffer.from(hkdfSync('sha256', raw, Buffer.alloc(0), info, 32));

export class NoTokenKey extends Error {
  constructor() { super(`${TOKEN_KEY_ENV} isn’t set (32+ characters)`); this.name = 'NoTokenKey'; }
}

// [{ kid, key }], the first one sealing. Too-short values are left out.
const keys = () => String(process.env[TOKEN_KEY_ENV] || '').split(/[\s,]+/).filter((k) => k.length >= TOKEN_KEY_MIN)
  .map((raw) => ({ kid: `g${derive(raw, 'base.win/google-kid/v1').toString('hex').slice(0, 10)}`, key: derive(raw, 'base.win/google-token/v1') }));

export const tokenKeyReady = () => keys().length > 0;

export const sealToken = (plain) => {
  const k = keys()[0];
  if (!k) throw new NoTokenKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k.key, iv, { authTagLength: 16 });
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', k.kid, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
};

// → { plain, current } (current: sealed with the key that seals now), or
// null: tampered with, or its key is gone.
export const openToken = (stored) => {
  const [version, kid, iv, tag, body] = String(stored || '').split('.');
  if (version !== 'v1' || !kid || !iv || !tag || body === undefined) return null;
  const all = keys();
  const k = all.find((e) => e.kid === kid);
  if (!k) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', k.key, Buffer.from(iv, 'base64url'), { authTagLength: 16 });
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const plain = Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
    return { plain, current: kid === all[0].kid };
  } catch {
    return null;
  }
};
