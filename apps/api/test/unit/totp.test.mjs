/**
 * Unit tests for TOTP/HOTP.
 *
 * The important assertions are the published test vectors: RFC 4226 Appendix D
 * (HOTP) and RFC 6238 Appendix B (TOTP). An implementation that agrees with
 * itself but not with the RFC produces codes no authenticator app will ever
 * accept, and that failure only shows up when a real person is locked out.
 *
 * Run: node --test test/unit/totp.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  base32Encode,
  base32Decode,
  hotp,
  totp,
  verifyTotp,
  generateSecret,
  generateRecoveryCodes,
  normaliseRecoveryCode,
  otpauthUri,
} from "../../dist/common/totp.js";

// ── RFC 4226 Appendix D ──────────────────────────────────────────────────

test("HOTP matches the RFC 4226 test vectors", () => {
  const secret = Buffer.from("12345678901234567890", "ascii");
  const expected = [
    "755224", "287082", "359152", "969429", "338314",
    "254676", "287922", "162583", "399871", "520489",
  ];
  expected.forEach((code, counter) => {
    assert.equal(hotp(secret, counter), code, `counter ${counter}`);
  });
});

// ── RFC 6238 Appendix B ──────────────────────────────────────────────────

test("TOTP matches the RFC 6238 test vectors for SHA-1", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890", "ascii"));
  const vectors = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  for (const [seconds, code] of vectors) {
    assert.equal(
      totp(secret, seconds * 1000, { digits: 8 }),
      code,
      `t=${seconds}`
    );
  }
});

test("TOTP matches the RFC 6238 vectors for SHA-256 and SHA-512", () => {
  // The RFC uses seeds extended to the hash block size, not the SHA-1 seed.
  const seed256 = base32Encode(Buffer.from("12345678901234567890123456789012", "ascii"));
  const seed512 = base32Encode(
    Buffer.from("1234567890123456789012345678901234567890123456789012345678901234", "ascii")
  );
  assert.equal(totp(seed256, 59_000, { digits: 8, algorithm: "sha256" }), "46119246");
  assert.equal(totp(seed512, 59_000, { digits: 8, algorithm: "sha512" }), "90693936");
  assert.equal(
    totp(seed256, 1111111109_000, { digits: 8, algorithm: "sha256" }),
    "68084774"
  );
});

// ── base32 ───────────────────────────────────────────────────────────────

test("base32 round-trips and matches RFC 4648 vectors", () => {
  assert.equal(base32Encode(Buffer.from("f")), "MY");
  assert.equal(base32Encode(Buffer.from("fo")), "MZXQ");
  assert.equal(base32Encode(Buffer.from("foo")), "MZXW6");
  assert.equal(base32Encode(Buffer.from("foobar")), "MZXW6YTBOI");
  assert.equal(base32Decode("MZXW6YTBOI").toString(), "foobar");
});

test("base32 tolerates how people actually paste a secret", () => {
  const secret = generateSecret();
  const mangled = secret.toLowerCase().replace(/(.{4})/g, "$1 ").trim();
  assert.deepEqual(base32Decode(mangled), base32Decode(secret));
  assert.deepEqual(base32Decode(`${secret}===`), base32Decode(secret));
});

test("a secret is 160 bits, as RFC 4226 recommends", () => {
  assert.equal(base32Decode(generateSecret()).length, 20);
  // Two enrolments must never collide.
  assert.notEqual(generateSecret(), generateSecret());
});

// ── verification ─────────────────────────────────────────────────────────

test("the current code verifies and a wrong one does not", () => {
  const secret = generateSecret();
  const now = Date.now();
  assert.equal(verifyTotp(secret, totp(secret, now), { atMs: now }), true);
  assert.equal(verifyTotp(secret, "000000", { atMs: now }), false);
});

test("clock drift of one step either side is accepted, two is not", () => {
  const secret = generateSecret();
  const now = 1_700_000_000_000;
  // A phone 25 seconds slow, and a user who typed slowly.
  assert.equal(verifyTotp(secret, totp(secret, now - 30_000), { atMs: now }), true);
  assert.equal(verifyTotp(secret, totp(secret, now + 30_000), { atMs: now }), true);
  // Beyond that a stolen code stays useful for too long.
  assert.equal(verifyTotp(secret, totp(secret, now - 90_000), { atMs: now }), false);
  assert.equal(verifyTotp(secret, totp(secret, now + 90_000), { atMs: now }), false);
});

test("malformed input is rejected without throwing", () => {
  const secret = generateSecret();
  for (const bad of ["", "12345", "1234567", "abcdef", "12 34 56", "  "]) {
    assert.equal(verifyTotp(secret, bad), false, `rejected ${JSON.stringify(bad)}`);
  }
});

test("a code from a different secret never verifies", () => {
  const a = generateSecret();
  const b = generateSecret();
  const now = Date.now();
  assert.equal(verifyTotp(a, totp(b, now), { atMs: now }), false);
});

// ── recovery codes ───────────────────────────────────────────────────────

test("recovery codes are unique, readable and free of ambiguous glyphs", () => {
  const codes = generateRecoveryCodes(20);
  assert.equal(new Set(codes).size, 20, "duplicates would silently halve the set");
  for (const c of codes) {
    assert.match(c, /^[ACDEFGHJKLMNPQRTWXY34679]{5}-[ACDEFGHJKLMNPQRTWXY34679]{5}$/);
    // Read aloud at 2am, these are the characters people get wrong.
    assert.ok(!/[OI1S5BZ]/.test(c), `${c} contains an ambiguous character`);
  }
});

test("recovery codes normalise the way people retype them", () => {
  assert.equal(normaliseRecoveryCode("acdef-ghjkl"), "ACDEFGHJKL");
  assert.equal(normaliseRecoveryCode("ACDEF GHJKL"), "ACDEFGHJKL");
});

// ── enrolment URI ────────────────────────────────────────────────────────

test("the otpauth URI carries what an authenticator app needs", () => {
  const uri = otpauthUri({ secret: "JBSWY3DPEHPK3PXP", accountName: "owner@grandpalm.demo" });
  assert.ok(uri.startsWith("otpauth://totp/Lodgiva:owner%40grandpalm.demo?"));
  const params = new URL(uri).searchParams;
  assert.equal(params.get("secret"), "JBSWY3DPEHPK3PXP");
  assert.equal(params.get("issuer"), "Lodgiva");
  assert.equal(params.get("digits"), "6");
  assert.equal(params.get("period"), "30");
});
