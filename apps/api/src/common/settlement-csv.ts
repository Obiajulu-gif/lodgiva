import { CsvError, parseCsv } from "./csv";

/**
 * Maps provider settlement exports onto our settlement lines.
 *
 * The important trap: provider settlement CSVs quote amounts in MAJOR units
 * (naira), even where the same provider's API uses minor units (Paystack's API
 * is in kobo). Importing a CSV as though it were kobo would understate every
 * payout by a factor of 100 and mark every line as an amount mismatch, so the
 * conversion is explicit here and covered by unit tests.
 *
 * Column names differ between providers and drift between exports, so lookup
 * is case-insensitive, ignores punctuation, and accepts known aliases.
 */

export interface ParsedSettlementLine {
  providerRef: string;
  amountMinor: number;
  feeMinor: number;
  paidOn?: string;
}

export interface ParsedSettlementCsv {
  lines: ParsedSettlementLine[];
  skipped: { row: number; reason: string }[];
  totalMinor: number;
  feeTotalMinor: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** First column whose normalised name matches one of the candidates. */
function pick(
  row: Record<string, string>,
  headerMap: Map<string, string>,
  candidates: string[]
): string | undefined {
  for (const c of candidates) {
    const actual = headerMap.get(norm(c));
    if (actual !== undefined) {
      const v = row[actual];
      if (v !== undefined && v.trim() !== "") return v.trim();
    }
  }
  return undefined;
}

/**
 * Parses a money column in major units into minor units.
 *
 * Handles thousands separators, a currency prefix and parenthesised negatives
 * (`(1,234.50)` = -1234.50), all of which appear in real exports. Rounds
 * rather than truncates: 46500.505 must not silently lose a kobo.
 */
export function parseMoneyToMinor(raw: string): number {
  let s = raw.trim();
  if (!s) throw new CsvError("Empty amount.");
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[₦NGN\s]/gi, "").replace(/,/g, "");
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new CsvError(`"${raw}" is not a valid amount.`);
  }
  const minor = Math.round(Number(s) * 100);
  return negative ? -minor : minor;
}

const REF_COLUMNS: Record<string, string[]> = {
  PAYSTACK: ["transaction reference", "reference", "trans ref", "txn reference", "id"],
  FLUTTERWAVE: ["transaction reference", "tx_ref", "txref", "reference", "id"],
};
const AMOUNT_COLUMNS: Record<string, string[]> = {
  PAYSTACK: ["amount", "gross amount", "transaction amount"],
  FLUTTERWAVE: ["amount", "gross amount", "transaction amount"],
};
const FEE_COLUMNS: Record<string, string[]> = {
  PAYSTACK: ["fees", "fee", "transaction fee", "charge"],
  FLUTTERWAVE: ["app fee", "appfee", "fee", "fees", "merchant fee"],
};
const DATE_COLUMNS: Record<string, string[]> = {
  PAYSTACK: ["paid at", "paidat", "date", "transaction date", "settled at"],
  FLUTTERWAVE: ["created at", "date", "transaction date", "settled at"],
};

/**
 * @param amountsAreMajor set false only for an export already in minor units.
 */
export function parseSettlementCsv(
  provider: string,
  text: string,
  opts: { maxRows?: number; amountsAreMajor?: boolean } = {}
): ParsedSettlementCsv {
  const key = provider.toUpperCase();
  if (!REF_COLUMNS[key]) {
    throw new CsvError(`No CSV mapping is defined for provider "${provider}".`);
  }
  const amountsAreMajor = opts.amountsAreMajor ?? true;
  const { headers, rows } = parseCsv(text, opts.maxRows ?? 5000);

  const headerMap = new Map<string, string>();
  for (const h of headers) headerMap.set(norm(h), h);

  const refCol = REF_COLUMNS[key].find((c) => headerMap.has(norm(c)));
  const amtCol = AMOUNT_COLUMNS[key].find((c) => headerMap.has(norm(c)));
  if (!refCol || !amtCol) {
    throw new CsvError(
      `This does not look like a ${key} settlement export. Expected a reference column (one of: ${REF_COLUMNS[key].join(", ")}) and an amount column (one of: ${AMOUNT_COLUMNS[key].join(", ")}). Found: ${headers.join(", ")}.`
    );
  }

  const lines: ParsedSettlementLine[] = [];
  const skipped: { row: number; reason: string }[] = [];

  rows.forEach((row, i) => {
    const rowNumber = i + 2; // 1-based, plus the header row
    try {
      const providerRef = pick(row, headerMap, REF_COLUMNS[key]);
      const amountRaw = pick(row, headerMap, AMOUNT_COLUMNS[key]);
      if (!providerRef) {
        skipped.push({ row: rowNumber, reason: "No transaction reference." });
        return;
      }
      if (!amountRaw) {
        skipped.push({ row: rowNumber, reason: "No amount." });
        return;
      }
      const amountMinor = amountsAreMajor
        ? parseMoneyToMinor(amountRaw)
        : Math.round(Number(amountRaw.replace(/[^\d.-]/g, "")));
      const feeRaw = pick(row, headerMap, FEE_COLUMNS[key]);
      const feeMinor = feeRaw
        ? Math.abs(amountsAreMajor ? parseMoneyToMinor(feeRaw) : Math.round(Number(feeRaw)))
        : 0;

      // A settlement export sometimes carries refund/reversal rows as
      // negatives. They are kept, not dropped: dropping them would overstate
      // the payout and hide money that went back out.
      const paidOnRaw = pick(row, headerMap, DATE_COLUMNS[key]);
      const paidOn = paidOnRaw ? normaliseDate(paidOnRaw) : undefined;

      lines.push({ providerRef, amountMinor, feeMinor, paidOn });
    } catch (e) {
      skipped.push({
        row: rowNumber,
        reason: e instanceof Error ? e.message : "Unparseable row.",
      });
    }
  });

  return {
    lines,
    skipped,
    totalMinor: lines.reduce((s, l) => s + l.amountMinor, 0),
    feeTotalMinor: lines.reduce((s, l) => s + l.feeMinor, 0),
  };
}

/** Best-effort ISO date from the formats these exports actually use. */
export function normaliseDate(raw: string): string | undefined {
  const s = raw.trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // dd/mm/yyyy — the order Nigerian exports use.
  const dmy = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return undefined;
}
