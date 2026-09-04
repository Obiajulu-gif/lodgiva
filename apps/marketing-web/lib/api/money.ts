export type MoneyMinor = string | number | bigint;

export function minorBigInt(minor: MoneyMinor): bigint {
  if (typeof minor === "bigint") return minor;
  if (typeof minor === "number") {
    if (!Number.isSafeInteger(minor))
      throw new TypeError("Money value is not a safe integer");
    return BigInt(minor);
  }
  if (!/^-?\d+$/.test(minor))
    throw new TypeError("Money value is not an integer");
  return BigInt(minor);
}

/** Format PostgreSQL BigInt decimal strings without first losing precision. */
export function naira(minor: MoneyMinor): string {
  try {
    const value = minorBigInt(minor);
    const negative = value < 0n;
    const absolute = negative ? -value : value;
    const whole = absolute / 100n;
    const fraction = String(absolute % 100n).padStart(2, "0");
    return `${negative ? "-" : ""}₦${whole.toLocaleString("en-NG")}.${fraction}`;
  } catch {
    return "—";
  }
}

/** Convert a human-entered naira decimal to an exact, JSON-safe minor-unit integer. */
export function nairaInputToMinor(input: string): number {
  const normalized = input.trim().replace(/,/g, "");
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match)
    throw new TypeError(
      "Enter a valid naira amount with no more than two decimal places.",
    );
  const minor =
    BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  if (minor > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError("This amount is too large.");
  return Number(minor);
}
