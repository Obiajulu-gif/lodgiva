/**
 * TOTP (RFC 6238) over HOTP (RFC 4226), plus base32 (RFC 4648) for the
 * enrolment secret.
 *
 * Written against the RFCs rather than pulled in as a dependency because the
 * whole algorithm is an HMAC and a modulo, and the correctness bar is a
 * published set of test vectors that test/unit/totp.test.mjs asserts directly.
 * A second-factor implementation that is not checked against those vectors is
 * a second factor nobody can trust.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  // Padding is optional for authenticator apps and only ever confuses the
  // people typing it in by hand, so it is omitted.
  return out;
}

export function base32Decode(input: string): Buffer {
  // Authenticator apps show the secret in groups; users paste it with spaces,
  // lower case, and sometimes the padding they were told to ignore.
  const clean = input.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 bits, the RFC 4226 recommended secret length. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

export type TotpAlgorithm = "sha1" | "sha256" | "sha512";

export interface TotpOptions {
  digits?: number;
  periodSeconds?: number;
  algorithm?: TotpAlgorithm;
}

/** RFC 4226 §5.3 — the truncation and modulo that turn an HMAC into a code. */
export function hotp(
  secret: Buffer,
  counter: number | bigint,
  { digits = 6, algorithm = "sha1" }: TotpOptions = {}
): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(algorithm, secret).update(buf).digest();

  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function totp(
  secretBase32: string,
  atMs = Date.now(),
  options: TotpOptions = {}
): string {
  const period = options.periodSeconds ?? 30;
  const counter = Math.floor(atMs / 1000 / period);
  return hotp(base32Decode(secretBase32), counter, options);
}

/**
 * Verifies a submitted code.
 *
 * `window` accepts codes from adjacent steps because phone clocks drift and
 * people finish typing after the code rolls. One step either side (±30s) is
 * the usual compromise: wider makes a stolen code useful for longer.
 *
 * Comparison is constant-time — a timing-variable compare on a six-digit code
 * is a realistic oracle, not a theoretical one.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  { window = 1, atMs = Date.now(), ...options }: TotpOptions & { window?: number; atMs?: number } = {}
): boolean {
  const digits = options.digits ?? 6;
  const submitted = code.replace(/\s/g, "");
  if (!new RegExp(`^\\d{${digits}}$`).test(submitted)) return false;

  const period = options.periodSeconds ?? 30;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(atMs / 1000 / period);

  let matched = false;
  for (let drift = -window; drift <= window; drift++) {
    const expected = hotp(secret, counter + drift, options);
    // Every candidate is compared even after a match, so the number of
    // comparisons does not reveal which step was accepted.
    const a = Buffer.from(expected);
    const b = Buffer.from(submitted);
    if (a.length === b.length && timingSafeEqual(a, b)) matched = true;
  }
  return matched;
}

/**
 * The otpauth:// URI an authenticator app scans. The issuer appears twice by
 * design (RFC-adjacent convention): the prefix is what older apps display, the
 * parameter is what newer ones read.
 */
export function otpauthUri(input: {
  secret: string;
  accountName: string;
  issuer?: string;
  digits?: number;
  periodSeconds?: number;
}): string {
  const issuer = input.issuer ?? "Lodgiva";
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(input.accountName)}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer,
    algorithm: "SHA1",
    digits: String(input.digits ?? 6),
    period: String(input.periodSeconds ?? 30),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Recovery codes for the phone that fell in a pool.
 *
 * Grouped and typed in Crockford-ish uppercase without vowels, so a code read
 * over the phone to a colleague at 2am does not turn into a support ticket.
 */
export function generateRecoveryCodes(count = 10): string[] {
  const alphabet = "ACDEFGHJKLMNPQRTWXY34679";
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = randomBytes(10);
    let raw = "";
    for (const b of bytes) raw += alphabet[b % alphabet.length];
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return codes;
}

export function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}
