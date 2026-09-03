import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const PREFIX = "enc:v1:";

function encryptionKey(): Buffer {
  const configured = process.env.MFA_ENCRYPTION_KEY;
  if (configured) {
    const key = Buffer.from(configured, "base64");
    if (key.length !== 32) throw new Error("MFA_ENCRYPTION_KEY must be 32 bytes encoded as base64.");
    return key;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("MFA_ENCRYPTION_KEY is required in production.");
  }
  // Stable local-only key so seeded accounts survive restarts. Production is
  // prevented from reaching this fallback by runtime validation above.
  return createHash("sha256")
    .update(process.env.JWT_SECRET ?? "lodgiva-local-mfa-key")
    .digest();
}

export function encryptMfaSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64url");
}

export function decryptMfaSecret(stored: string): string {
  // Temporary compatibility for existing development rows. Any successful
  // MFA setup/activation writes the encrypted v1 form.
  if (!stored.startsWith(PREFIX)) return stored;
  const packed = Buffer.from(stored.slice(PREFIX.length), "base64url");
  if (packed.length < 29) throw new Error("Encrypted MFA secret is malformed.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), packed.subarray(0, 12));
  decipher.setAuthTag(packed.subarray(12, 28));
  return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8");
}
