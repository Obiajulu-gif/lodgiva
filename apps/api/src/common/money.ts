// §7.3 / §13.3 — money is BigInt minor units (kobo); tax rates are basis
// points, applied as separate ledger lines so historical invoices never
// change when configuration changes.

export const VAT_BP = 750n; // 7.5% VAT
export const SERVICE_BP = 500n; // 5% service charge (applied before VAT)

export interface ChargeLines {
  base: bigint;
  serviceCharge: bigint;
  vat: bigint;
  total: bigint;
}

/** Exclusive pricing: service charge on base, VAT on (base + service). */
export function computeChargeLines(baseMinor: bigint): ChargeLines {
  const serviceCharge = (baseMinor * SERVICE_BP) / 10000n;
  const vat = ((baseMinor + serviceCharge) * VAT_BP) / 10000n;
  return { base: baseMinor, serviceCharge, vat, total: baseMinor + serviceCharge + vat };
}

export function nightsBetween(arrivalIso: string, departureIso: string): string[] {
  const nights: string[] = [];
  const d = new Date(arrivalIso + "T00:00:00Z");
  const end = new Date(departureIso + "T00:00:00Z");
  while (d < end) {
    nights.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return nights;
}

export function addDaysIso(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
