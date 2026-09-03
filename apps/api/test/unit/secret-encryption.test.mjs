import test from "node:test";
import assert from "node:assert/strict";
import { decryptMfaSecret, encryptMfaSecret } from "../../dist/common/secret-encryption.js";

test("MFA secrets are encrypted and round-trip", () => {
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  const encrypted = encryptMfaSecret("JBSWY3DPEHPK3PXP");
  assert.match(encrypted, /^enc:v1:/);
  assert.ok(!encrypted.includes("JBSWY3DPEHPK3PXP"));
  assert.equal(decryptMfaSecret(encrypted), "JBSWY3DPEHPK3PXP");
});

test("tampered MFA ciphertext is rejected", () => {
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  const encrypted = encryptMfaSecret("JBSWY3DPEHPK3PXP");
  const packed = Buffer.from(encrypted.slice("enc:v1:".length), "base64url");
  packed[packed.length - 1] ^= 1;
  assert.throws(() => decryptMfaSecret(`enc:v1:${packed.toString("base64url")}`));
});
