import { describe, expect, it, vi } from "vitest";
import { mfaEnforced, mustEnrol } from "@/lib/mfa-policy";
import { qrMatrix, qrSvgPath } from "@/lib/qr";

vi.mock("server-only", () => ({}));
const {
  base32Decode,
  base32Encode,
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  groupSecret,
  hashRecoveryCode,
  hotp,
  looksLikeRecoveryCode,
  otpauthUri,
  totp,
  totpStep,
  verifyTotp,
} = await import("@/lib/server/totp");

const ascii = (s: string) => Buffer.from(s, "ascii");

describe("HOTP (RFC 4226 appendix D)", () => {
  it("matches the published values for counters 0 to 9", () => {
    const key = ascii("12345678901234567890");
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    expect(expected.map((_, i) => hotp(key, i))).toEqual(expected);
  });
});

describe("TOTP (RFC 6238 appendix B)", () => {
  // 8-digit values from the RFC, one seed per hash.
  const seeds = {
    sha1: ascii("12345678901234567890"),
    sha256: ascii("12345678901234567890123456789012"),
    sha512: ascii("1234567890123456789012345678901234567890123456789012345678901234"),
  } as const;
  const vectors: [number, string, string, string][] = [
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"],
    [20000000000, "65353130", "77737706", "47863826"],
  ];
  it.each(vectors)("at %i seconds", (seconds, sha1, sha256, sha512) => {
    const at = seconds * 1000;
    expect(totp(seeds.sha1, at, { digits: 8 })).toBe(sha1);
    expect(totp(seeds.sha256, at, { digits: 8, algorithm: "sha256" })).toBe(sha256);
    expect(totp(seeds.sha512, at, { digits: 8, algorithm: "sha512" })).toBe(sha512);
  });

  it("uses 6 digits and 30-second steps by default", () => {
    // The last six digits of the RFC's 8-digit value.
    expect(totp(seeds.sha1, 59_000)).toBe("287082");
    expect(totpStep(59_000)).toBe(1);
    expect(totpStep(60_000)).toBe(2);
  });
});

describe("checking a code", () => {
  const key = ascii("12345678901234567890");
  const now = 1_700_000_015_000; // inside a step, not on its edge
  const step = totpStep(now);
  const codeAt = (s: number) => hotp(key, s);

  it("accepts now and one step either side, and says which step matched", () => {
    expect(verifyTotp(key, codeAt(step), { nowMs: now })).toBe(step);
    expect(verifyTotp(key, codeAt(step - 1), { nowMs: now })).toBe(step - 1);
    expect(verifyTotp(key, codeAt(step + 1), { nowMs: now })).toBe(step + 1);
  });

  it("refuses codes two steps away, wrong codes and junk", () => {
    expect(verifyTotp(key, codeAt(step - 2), { nowMs: now })).toBeNull();
    expect(verifyTotp(key, codeAt(step + 2), { nowMs: now })).toBeNull();
    const wrong = String((Number(codeAt(step)) + 1) % 1_000_000).padStart(6, "0");
    expect([codeAt(step - 1), codeAt(step + 1)]).not.toContain(wrong);
    expect(verifyTotp(key, wrong, { nowMs: now })).toBeNull();
    expect(verifyTotp(key, "", { nowMs: now })).toBeNull();
    expect(verifyTotp(key, "12345", { nowMs: now })).toBeNull();
    expect(verifyTotp(key, "abcdef", { nowMs: now })).toBeNull();
  });

  it("allows spaces the way apps display codes", () => {
    const c = codeAt(step);
    expect(verifyTotp(key, `${c.slice(0, 3)} ${c.slice(3)}`, { nowMs: now })).toBe(step);
  });

  it("refuses a replay: the same code, or any earlier step, once a step is used", () => {
    const used = verifyTotp(key, codeAt(step), { nowMs: now });
    expect(used).toBe(step);
    expect(verifyTotp(key, codeAt(step), { nowMs: now, afterStep: used })).toBeNull();
    expect(verifyTotp(key, codeAt(step - 1), { nowMs: now, afterStep: used })).toBeNull();
    // The next code is still good.
    expect(verifyTotp(key, codeAt(step + 1), { nowMs: now, afterStep: used })).toBe(step + 1);
    // Thirty seconds later the same code is still refused, though it is inside the window.
    expect(verifyTotp(key, codeAt(step), { nowMs: now + 30_000, afterStep: used })).toBeNull();
  });
});

describe("base32 and the setup key", () => {
  it("encodes and decodes RFC 4648's examples", () => {
    const cases: [string, string][] = [
      ["", ""],
      ["f", "MY"],
      ["fo", "MZXQ"],
      ["foo", "MZXW6"],
      ["foob", "MZXW6YQ"],
      ["fooba", "MZXW6YTB"],
      ["foobar", "MZXW6YTBOI"],
    ];
    for (const [plain, encoded] of cases) {
      expect(base32Encode(ascii(plain))).toBe(encoded);
      expect(base32Decode(encoded).toString("ascii")).toBe(plain);
    }
    expect(base32Decode("mzxw 6ytb-oi======").toString("ascii")).toBe("foobar");
    expect(() => base32Decode("MZ1")).toThrow();
  });

  it("makes 160-bit secrets, shown in groups of four", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(secret);
    expect(groupSecret("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")).toBe("ABCD EFGH IJKL MNOP QRST UVWX YZ23 4567");
  });

  it("builds the otpauth address apps read", () => {
    const uri = otpauthUri({ secret: "JBSWY3DPEHPK3PXP", account: "owner@imaginesurrey.ca", issuer: "Imagine Surrey" });
    expect(uri).toBe("otpauth://totp/Imagine%20Surrey:owner%40imaginesurrey.ca?secret=JBSWY3DPEHPK3PXP&issuer=Imagine%20Surrey&algorithm=SHA1&digits=6&period=30");
  });
});

describe("the secret at rest", () => {
  const master = "a-long-random-session-secret-0123456789";

  it("round-trips through AES-256-GCM", () => {
    const secret = generateTotpSecret();
    const stored = encryptSecret(secret, master);
    expect(stored).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(stored).not.toContain(secret);
    expect(decryptSecret(stored, master)).toBe(secret);
  });

  it("uses a fresh IV each time", () => {
    expect(encryptSecret("JBSWY3DPEHPK3PXP", master)).not.toBe(encryptSecret("JBSWY3DPEHPK3PXP", master));
  });

  it("refuses another session secret, a tampered value and junk", () => {
    const stored = encryptSecret("JBSWY3DPEHPK3PXP", master);
    expect(decryptSecret(stored, "another-session-secret-0123456789")).toBeNull();
    const [v, iv, tag, body] = stored.split(".");
    const flipped = Buffer.from(body, "base64url");
    flipped[0] ^= 1;
    expect(decryptSecret([v, iv, tag, flipped.toString("base64url")].join("."), master)).toBeNull();
    expect(decryptSecret("JBSWY3DPEHPK3PXP", master)).toBeNull();
    expect(decryptSecret("v2.a.b.c", master)).toBeNull();
  });
});

describe("recovery codes", () => {
  it("makes ten different codes that read back unambiguously", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) {
      expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
      expect(c).not.toMatch(/[01ilo]/);
      expect(looksLikeRecoveryCode(c)).toBe(true);
    }
    expect(looksLikeRecoveryCode("123456")).toBe(false);
  });

  it("stores a sha256 hash, the same however the code is typed", () => {
    const hash = hashRecoveryCode("k7m2q-x9tbn");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("k7m2q");
    expect(hashRecoveryCode(" K7M2Q X9TBN ")).toBe(hash);
    expect(hashRecoveryCode("k7m2qx9tbn")).toBe(hash);
    expect(hashRecoveryCode("k7m2q-x9tbm")).not.toBe(hash);
  });
});

describe("who must enrol", () => {
  const prod = { NODE_ENV: "production", DATABASE_URL: "postgres://u:p@db.example.com:5432/x" };

  it("requires it for owners and administrators by default, not for organizers and editors", () => {
    expect(mfaEnforced(prod)).toBe(true);
    expect(mustEnrol("owner", false, prod)).toBe(true);
    expect(mustEnrol("admin", false, prod)).toBe(true);
    expect(mustEnrol("owner", true, prod)).toBe(false);
    expect(mustEnrol("organizer", false, prod)).toBe(false);
    expect(mustEnrol("editor", false, prod)).toBe(false);
  });

  it("ignores ADMIN_MFA_REQUIRED=0 in production, on Render and on Vercel", () => {
    expect(mfaEnforced({ ...prod, ADMIN_MFA_REQUIRED: "0" })).toBe(true);
    expect(mfaEnforced({ ...prod, ADMIN_MFA_REQUIRED: "0", E2E: "1", RENDER: "true" })).toBe(true);
    expect(mfaEnforced({ NODE_ENV: "development", ADMIN_MFA_REQUIRED: "0", RENDER: "true" })).toBe(true);
    expect(mfaEnforced({ NODE_ENV: "development", ADMIN_MFA_REQUIRED: "0", VERCEL: "1" })).toBe(true);
    expect(mfaEnforced({ ...prod, ADMIN_MFA_REQUIRED: "0", E2E: "1", VERCEL_ENV: "production" })).toBe(true);
  });

  it("honours ADMIN_MFA_REQUIRED=0 off production and under the e2e runner", () => {
    expect(mfaEnforced({ NODE_ENV: "development", ADMIN_MFA_REQUIRED: "0" })).toBe(false);
    expect(mfaEnforced({ ...prod, ADMIN_MFA_REQUIRED: "0", E2E: "1" })).toBe(false);
    expect(mfaEnforced({ NODE_ENV: "development", ADMIN_MFA_REQUIRED: "false" })).toBe(true);
    expect(mfaEnforced({ NODE_ENV: "development" })).toBe(true);
  });

  it("is skipped by the local preview mode", () => {
    expect(mfaEnforced({ NODE_ENV: "development", ADMIN_PREVIEW_MODE: "1", DATABASE_URL: "postgres://u:p@localhost:5432/x" })).toBe(false);
    expect(mfaEnforced({ NODE_ENV: "development", ADMIN_PREVIEW_MODE: "1", DATABASE_URL: "postgres://u:p@localhost:5432/x", RENDER: "true" })).toBe(true);
  });
});

describe("QR code for the setup", () => {
  const uri = otpauthUri({ secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", account: "owner@imaginesurrey.ca", issuer: "Imagine Surrey" });

  it("picks the smallest version that fits, with finder and timing patterns in place", () => {
    expect(qrMatrix("hello")).toHaveLength(21); // version 1
    const m = qrMatrix(uri);
    const version = (m.length - 17) / 4;
    expect(Number.isInteger(version) && version >= 6 && version <= 10).toBe(true);
    // Finder patterns: a dark 7×7 ring around a dark 3×3 centre, in three corners.
    for (const [x0, y0] of [
      [0, 0],
      [m.length - 7, 0],
      [0, m.length - 7],
    ]) {
      for (let i = 0; i < 7; i++) {
        expect(m[y0][x0 + i] && m[y0 + 6][x0 + i] && m[y0 + i][x0] && m[y0 + i][x0 + 6]).toBe(true);
      }
      expect(m[y0 + 1][x0 + 1]).toBe(false);
      expect(m[y0 + 3][x0 + 3]).toBe(true);
    }
    // Timing patterns alternate between the finders.
    for (let i = 8; i < m.length - 8; i++) {
      expect(m[6][i]).toBe(i % 2 === 0);
      expect(m[i][6]).toBe(i % 2 === 0);
    }
    expect(m[m.length - 8][8]).toBe(true); // the dark module
  });

  it("is deterministic and refuses text that is too long", () => {
    expect(qrMatrix(uri)).toEqual(qrMatrix(uri));
    expect(() => qrMatrix("x".repeat(500))).toThrow(/Too long/);
  });

  it("draws the dark modules as an SVG path with a quiet zone", () => {
    const { d, size } = qrSvgPath("hello");
    expect(size).toBe(21 + 8);
    expect(d.startsWith("M4 4h7v1h-7z")).toBe(true); // the top row of the first finder pattern
  });
});
