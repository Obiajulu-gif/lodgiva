/**
 * A minimal, dependency-free PDF 1.4 writer for tabular reports.
 *
 * Why hand-rolled: the only thing exports need is "a page of monospaced rows
 * that an owner can print or email to an auditor". A full layout engine is a
 * large dependency for that, and the PDF file format is small enough at this
 * level to write correctly — the risky parts are the cross-reference table and
 * byte offsets, and those are asserted in test/unit/pdf.test.mjs against a
 * parsed xref rather than by eyeballing a viewer.
 *
 * Deliberate limits, so nobody expects more than is here:
 *  - One font family (Courier / Courier-Bold), because fixed pitch means column
 *    alignment is arithmetic rather than font-metric lookup.
 *  - WinAnsi encoding only. The naira sign has no WinAnsi code point, so money
 *    is written as "NGN" — silently dropping the currency marker would be worse
 *    than an ugly one.
 *  - No compression. A report of a few thousand rows is well under a megabyte,
 *    and an uncompressed stream is inspectable when something looks wrong.
 */

const PAGE_WIDTH = 842; // A4 landscape — reports are wide, not tall.
const PAGE_HEIGHT = 595;
const MARGIN = 32;
const BODY_SIZE = 8;
const LINE_HEIGHT = 10.5;
const TITLE_SIZE = 15;
const META_SIZE = 8;
// Courier advances every glyph by 0.6 em, which is what makes the column maths
// below exact rather than approximate.
const COURIER_ADVANCE = 0.6;

const CHARS_PER_LINE = Math.floor((PAGE_WIDTH - MARGIN * 2) / (BODY_SIZE * COURIER_ADVANCE));
const FOOTER_BLOCK = 26; // page number
const META_LEADING = META_SIZE + 3;

/**
 * The header grows with the number of meta lines. It used to be a fixed 52pt,
 * which silently overlapped the first table row once a report carried three
 * meta lines — the text extracted as one run and the column header vanished
 * into the range line. Measure it instead.
 */
function headerHeightFor(metaCount: number): number {
  return TITLE_SIZE + 6 + metaCount * META_LEADING + 10;
}

function bodyLinesFor(metaCount: number): number {
  const top = PAGE_HEIGHT - MARGIN - headerHeightFor(metaCount);
  return Math.max(1, Math.floor((top - MARGIN - FOOTER_BLOCK) / LINE_HEIGHT));
}

const BODY_LINES = bodyLinesFor(0);

export interface PdfTableDoc {
  title: string;
  /** Shown under the title: property, date range, who asked for it. */
  meta?: string[];
  columns: string[];
  rows: (string | number | null | undefined)[][];
  /** Printed after the table — totals, or a note about what is excluded. */
  notes?: string[];
}

/**
 * WinAnsi has no naira sign, so spell it. Anything else outside the encoding
 * becomes "?" — a visible gap beats a corrupt byte that makes a reader refuse
 * to open the file.
 */
export function toWinAnsi(input: string): string {
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    if (ch === "₦") out += "NGN"; // ₦
    else if (ch === "—" || ch === "–") out += "-"; // em/en dash
    else if (ch === "’" || ch === "‘") out += "'";
    else if (ch === "“" || ch === "”") out += '"';
    else if (ch === "…") out += "...";
    else if (code >= 32 && code <= 126) out += ch;
    else if (code >= 160 && code <= 255) out += ch; // Latin-1 range of WinAnsi
    else if (ch === "\t") out += "    ";
    else out += "?";
  }
  return out;
}

/** Literal strings end at an unbalanced parenthesis, so escape them. */
function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/\r/g, "");
}

/**
 * Lays a table out as fixed-width text.
 *
 * Columns are given the width their widest cell needs; when the total exceeds
 * the page, the widest columns are shrunk first. Narrow columns (dates, codes,
 * amounts) therefore stay intact and long free text absorbs the truncation,
 * which is the right trade: a clipped description is readable, a clipped amount
 * is a wrong number.
 */
export function layoutTable(
  columns: string[],
  rows: (string | number | null | undefined)[][],
  maxChars = CHARS_PER_LINE
): string[] {
  const gap = 2;
  const cell = (v: string | number | null | undefined) =>
    toWinAnsi(v === null || v === undefined ? "" : String(v));

  const widths = columns.map((c, i) =>
    Math.max(toWinAnsi(c).length, ...rows.map((r) => cell(r[i]).length), 1)
  );

  const budget = maxChars - gap * (columns.length - 1);
  let total = widths.reduce((a, b) => a + b, 0);
  // Shave the widest column repeatedly rather than scaling everything: scaling
  // would clip a 10-character date column to fit a 200-character note.
  while (total > budget && Math.max(...widths) > 3) {
    const widest = widths.indexOf(Math.max(...widths));
    widths[widest] -= 1;
    total -= 1;
  }

  const fit = (s: string, w: number) =>
    s.length > w ? (w > 3 ? `${s.slice(0, w - 3)}...` : s.slice(0, w)) : s.padEnd(w);

  const line = (values: string[]) => values.map((v, i) => fit(v, widths[i])).join(" ".repeat(gap)).trimEnd();

  return [
    line(columns.map(toWinAnsi)),
    widths.map((w) => "-".repeat(w)).join(" ".repeat(gap)),
    ...rows.map((r) => line(columns.map((_, i) => cell(r[i])))),
  ];
}

interface PdfPage {
  title: string;
  meta: string[];
  lines: string[];
  pageNumber: number;
  pageCount: number;
}

function contentStream(page: PdfPage): string {
  const parts: string[] = [];
  let y = PAGE_HEIGHT - MARGIN - TITLE_SIZE;

  parts.push("BT", `/F2 ${TITLE_SIZE} Tf`, `${MARGIN} ${y} Td`, `(${escapeText(page.title)}) Tj`, "ET");

  y -= META_SIZE + 6;
  for (const m of page.meta) {
    parts.push("BT", `/F1 ${META_SIZE} Tf`, `${MARGIN} ${y} Td`, `(${escapeText(m)}) Tj`, "ET");
    y -= META_LEADING;
  }

  y = PAGE_HEIGHT - MARGIN - headerHeightFor(page.meta.length);
  parts.push("BT", `/F1 ${BODY_SIZE} Tf`, `${MARGIN} ${y} Td`, `${LINE_HEIGHT} TL`);
  page.lines.forEach((l, i) => {
    if (i > 0) parts.push("T*");
    parts.push(`(${escapeText(l)}) Tj`);
  });
  parts.push("ET");

  const footer = `Page ${page.pageNumber} of ${page.pageCount}`;
  parts.push(
    "BT",
    `/F1 ${META_SIZE} Tf`,
    `${PAGE_WIDTH - MARGIN - footer.length * META_SIZE * COURIER_ADVANCE} ${MARGIN} Td`,
    `(${escapeText(footer)}) Tj`,
    "ET"
  );
  return parts.join("\n");
}

/**
 * Assembles the objects, cross-reference table and trailer.
 *
 * Every offset in the xref is the byte position of its object; getting one
 * wrong produces a file that some readers repair silently and others reject,
 * so the offsets are measured from the buffer being built rather than
 * predicted.
 */
export function renderTablePdf(doc: PdfTableDoc): Buffer {
  const body = layoutTable(doc.columns, doc.rows);
  // A header row with nothing under it looks like a file that got cut off.
  // Say the report is empty, so "no data" is never mistaken for "data lost".
  if (doc.rows.length === 0) body.push("", "No rows matched this report.");
  const lines = doc.notes?.length ? [...body, "", ...doc.notes.map(toWinAnsi)] : body;

  const meta = (doc.meta ?? []).map(toWinAnsi);
  const perPage = bodyLinesFor(meta.length);

  const chunks: string[][] = [];
  for (let i = 0; i < lines.length; i += perPage) chunks.push(lines.slice(i, i + perPage));


  const title = toWinAnsi(doc.title);

  const objects: string[] = [];
  /** Appends an object body and returns its 1-based PDF object number. */
  const add = (s: string) => {
    objects.push(s);
    return objects.length;
  };

  const catalogNo = add("<< /Type /Catalog /Pages 2 0 R >>");
  const pagesNo = add(""); // placeholder, filled once kids are known
  const fontNo = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
  const boldNo = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>"
  );

  const kids: number[] = [];
  chunks.forEach((chunk, i) => {
    const stream = contentStream({
      title,
      meta,
      lines: chunk,
      pageNumber: i + 1,
      pageCount: chunks.length,
    });
    const contentNo = add(
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`
    );
    const pageNo = add(
      `<< /Type /Page /Parent ${pagesNo} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 ${fontNo} 0 R /F2 ${boldNo} 0 R >> >> /Contents ${contentNo} 0 R >>`
    );
    kids.push(pageNo);
  });
  objects[pagesNo - 1] =
    `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n`;
  out += "0000000000 65535 f \n";
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNo} 0 R >>\n`;
  out += `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(out, "latin1");
}

export const PDF_LAYOUT = { PAGE_WIDTH, PAGE_HEIGHT, CHARS_PER_LINE, BODY_LINES };
