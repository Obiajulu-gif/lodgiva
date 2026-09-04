export type MoneyMinor = string | number | bigint;

/** PostgreSQL BigInt values arrive as decimal strings; keep them exact in the UI. */
export function minorBigInt(minor: MoneyMinor): bigint {
  if (typeof minor === "bigint") return minor;
  if (typeof minor === "number") {
    if (!Number.isSafeInteger(minor)) throw new TypeError("Money value is not a safe integer");
    return BigInt(minor);
  }
  if (!/^-?\d+$/.test(minor)) throw new TypeError("Money value is not an integer");
  return BigInt(minor);
}

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
