/**
 * Minimal RFC 4180 CSV reader for configuration imports.
 *
 * Written by hand rather than pulled in as a dependency because imports are
 * an attack surface: this parser has no eval, no prototype writes, and a hard
 * row cap, and it is unit-tested against quoted fields, embedded commas,
 * embedded newlines and escaped quotes.
 */

export interface CsvParseResult {
  headers: string[];
  rows: Record<string, string>[];
}

export class CsvError extends Error {}

export function parseCsv(input: string, maxRows = 5000): CsvParseResult {
  const text = input.replace(/^﻿/, ""); // strip BOM from Excel exports
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'; // escaped quote
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      // Treat CRLF as one terminator; ignore blank lines.
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      field = "";
      if (record.length > 1 || record[0] !== "") records.push(record);
      record = [];
      if (records.length > maxRows + 1) {
        throw new CsvError(`CSV exceeds the ${maxRows}-row import limit.`);
      }
    } else {
      field += ch;
    }
  }
  if (inQuotes) throw new CsvError("CSV ended inside a quoted field.");
  record.push(field);
  if (record.length > 1 || record[0] !== "") records.push(record);

  if (records.length === 0) throw new CsvError("CSV is empty.");

  const headers = records[0].map((h) => h.trim());
  if (new Set(headers).size !== headers.length) {
    throw new CsvError("CSV has duplicate column headers.");
  }

  const rows = records.slice(1).map((cells) => {
    const row: Record<string, string> = Object.create(null);
    headers.forEach((h, idx) => {
      row[h] = (cells[idx] ?? "").trim();
    });
    return row;
  });

  return { headers, rows };
}

/** Requires every named column to be present, listing all missing at once. */
export function requireColumns(headers: string[], required: string[]): void {
  const missing = required.filter((c) => !headers.includes(c));
  if (missing.length) {
    throw new CsvError(`CSV is missing required column(s): ${missing.join(", ")}.`);
  }
}
