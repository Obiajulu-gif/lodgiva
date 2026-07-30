import { randomInt } from "crypto";

/**
 * Guest-facing confirmation codes.
 *
 * These are read aloud down a bad phone line, written on paper registers and
 * typed back in by guests, so the format is chosen for transcription rather
 * than for density:
 *
 *  - Ambiguous glyphs are excluded (no O/0, I/1/L, S/5, B/8, U/V).
 *  - Codes are grouped `LDG-XXXX-XXXX` because people read groups of four
 *    reliably and long runs badly.
 *  - Lookup normalises case, spaces and dashes, so "ldg 7k3m 9pqr" resolves.
 *
 * They are RANDOM, not sequential. A sequential code (…-5001, …-5002) both
 * races under concurrent booking and quietly publishes how many reservations
 * a property has taken — a competitor can book twice a month and read the
 * hotel's volume straight off the codes.
 */

/** 26 unambiguous characters. */
export const CODE_ALPHABET = "ACDEFGHJKMNPQRTWXY2346789";

const GROUP = 4;
const GROUPS = 2;
export const CODE_PREFIX = "LDG";

/** ~25^8 ≈ 1.5e11 combinations, so collisions are rare and retried anyway. */
export function generateConfirmationCode(
  rand: (max: number) => number = (max) => randomInt(max)
): string {
  const chars: string[] = [];
  for (let i = 0; i < GROUP * GROUPS; i++) {
    chars.push(CODE_ALPHABET[rand(CODE_ALPHABET.length)]);
  }
  const body = chars.join("");
  return `${CODE_PREFIX}-${body.slice(0, GROUP)}-${body.slice(GROUP)}`;
}

/**
 * Maps characters that are NOT in the alphabet onto the one they are most
 * likely a misreading of.
 *
 * Every key here must be absent from CODE_ALPHABET and every value present in
 * it. Folding a character that a real code can contain would corrupt valid
 * codes — an earlier version mapped 8→9 and silently broke every code with an
 * 8 in it.
 *
 * Characters with no unambiguous target (I, L, 1, S, 5) are deliberately left
 * out: rejecting them tells the guest to re-read the code, which is far better
 * than guessing and sending them to somebody else's booking.
 */
const FOLD: Record<string, string> = {
  B: "8", // B misread for 8
  O: "Q", // O/0 misread for Q
  "0": "Q",
  U: "W", // U/V misread for W
  V: "W",
  Z: "2", // Z misread for 2
};

// Guard the invariant at module load rather than trusting the table by eye.
for (const [from, to] of Object.entries(FOLD)) {
  if (CODE_ALPHABET.includes(from)) {
    throw new Error(`Fold source "${from}" must not be part of CODE_ALPHABET.`);
  }
  if (!CODE_ALPHABET.includes(to)) {
    throw new Error(`Fold target "${to}" must be part of CODE_ALPHABET.`);
  }
}

/**
 * Accepts whatever a human typed and returns the canonical form, or null if
 * it cannot be a confirmation code.
 */
export function normaliseConfirmationCode(input: string): string | null {
  if (!input) return null;
  let s = input.toUpperCase().replace(/[\s\-_.]/g, "");
  if (s.startsWith(CODE_PREFIX)) s = s.slice(CODE_PREFIX.length);

  s = [...s].map((c) => FOLD[c] ?? c).join("");

  if (s.length !== GROUP * GROUPS) return null;
  if (![...s].every((c) => CODE_ALPHABET.includes(c))) return null;
  return `${CODE_PREFIX}-${s.slice(0, GROUP)}-${s.slice(GROUP)}`;
}

export function isValidConfirmationCode(input: string): boolean {
  return normaliseConfirmationCode(input) !== null;
}
