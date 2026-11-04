import { describe, expect, it } from "vitest";
import { AttemptLimiter, SCRYPT_PARAMS, hashPassword, needsRehash, verifyPassword } from "../src/index.ts";

describe("password hashing", () => {
  it("encodes scrypt parameters, salt and a 64-byte key", async () => {
    const h = await hashPassword("correct horse battery");
    const [alg, N, r, p, salt, key] = h.split("$");
    expect(alg).toBe("scrypt");
    expect(Number(N)).toBe(2 ** 15);
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
    expect(Buffer.from(salt!, "base64url")).toHaveLength(SCRYPT_PARAMS.saltLength);
    expect(Buffer.from(key!, "base64url")).toHaveLength(64);
    expect(h).not.toContain("correct horse");
  });

  it("verifies the right password and rejects others", async () => {
    const h = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("correct horse batterY", h)).toBe(false);
    expect(await verifyPassword("", h)).toBe(false);
  });

  it("salts per hash", async () => {
    const [a, b] = await Promise.all([hashPassword("same password!"), hashPassword("same password!")]);
    expect(a).not.toBe(b);
    expect(await verifyPassword("same password!", a)).toBe(true);
    expect(await verifyPassword("same password!", b)).toBe(true);
  });

  it("normalizes unicode so the same visible password verifies", async () => {
    const h = await hashPassword("café-password");
    expect(await verifyPassword("café-password", h)).toBe(true);
  });

  it("reads parameters from the stored string and flags old ones for rehash", async () => {
    const h = await hashPassword("parameters travel");
    expect(needsRehash(h)).toBe(false);
    // A hash made with a lower cost still verifies (the params come from the string), and asks to be upgraded.
    const { scryptSync } = await import("node:crypto");
    const salt = Buffer.from("0123456789abcdef");
    const weak = `scrypt$1024$8$1$${salt.toString("base64url")}$${scryptSync("parameters travel", salt, 64, { N: 1024, r: 8, p: 1 }).toString("base64url")}`;
    expect(await verifyPassword("parameters travel", weak)).toBe(true);
    expect(needsRehash(weak)).toBe(true);
  });

  it("never matches malformed or out-of-bounds hashes", async () => {
    for (const bad of ["", "plain", "bcrypt$x", "scrypt$3$8$1$AAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA", "scrypt$1073741824$8$1$AAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA", "scrypt$32768$8$1$$"]) {
      expect(await verifyPassword("anything", bad)).toBe(false);
    }
  });
});

describe("attempt limiter", () => {
  it("blocks after max hits within the window and frees up as they age out", () => {
    let t = 0;
    const l = new AttemptLimiter(5, 15 * 60_000, () => t);
    for (let i = 0; i < 4; i++) {
      l.hit("a@x.test");
      t += 1000;
    }
    expect(l.retryAfterMs("a@x.test")).toBe(0);
    l.hit("a@x.test");
    expect(l.retryAfterMs("a@x.test")).toBeGreaterThan(14 * 60_000);
    expect(l.retryAfterMs("b@x.test")).toBe(0);
    t += 15 * 60_000;
    expect(l.retryAfterMs("a@x.test")).toBe(0);
    l.hit("a@x.test");
    l.reset("a@x.test");
    expect(l.retryAfterMs("a@x.test")).toBe(0);
  });
});
