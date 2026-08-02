/**
 * Unit tests for the PDF writer.
 *
 * These parse the file back rather than asserting "some bytes were produced":
 * a PDF with a wrong cross-reference offset still looks like a PDF to a byte
 * count, and only fails when an auditor tries to open it.
 *
 * Run: node --test test/unit/pdf.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { renderTablePdf, layoutTable, toWinAnsi, PDF_LAYOUT } from "../../dist/common/pdf.js";

const doc = () => ({
  title: "Revenue — Grand Palm Hotel",
  meta: ["Property: GPH-LAG", "Range: 2026-07-01 to 2026-07-31"],
  columns: ["date", "category", "amount"],
  rows: [
    ["2026-07-01", "ROOM_CHARGE", "₦125,000.00"],
    ["2026-07-02", "FOOD_BEVERAGE", "₦18,500.00"],
  ],
  notes: ["Payments and refunds are excluded: they settle revenue."],
});

/** Reads the xref table back and checks each offset points at "N 0 obj". */
function parseXref(buf) {
  const text = buf.toString("latin1");
  const startIdx = text.lastIndexOf("startxref");
  assert.ok(startIdx > 0, "startxref must be present");
  const startxref = Number(text.slice(startIdx + 9).trim().split(/\s/)[0]);
  assert.ok(Number.isInteger(startxref), "startxref must be a number");

  const xref = text.slice(startxref);
  assert.ok(xref.startsWith("xref\n"), "startxref must point at the xref keyword");

  const header = xref.split("\n")[1];
  const [first, count] = header.trim().split(/\s+/).map(Number);
  assert.equal(first, 0);

  const entriesStart = startxref + 5 + header.length + 1;
  const entries = [];
  for (let i = 0; i < count; i++) {
    const raw = text.slice(entriesStart + i * 20, entriesStart + i * 20 + 20);
    assert.equal(raw.length, 20, `xref entry ${i} must be exactly 20 bytes`);
    entries.push({ offset: Number(raw.slice(0, 10)), type: raw[17] });
  }
  return { entries, count, text };
}

test("produces a structurally valid PDF whose xref offsets resolve", () => {
  const buf = renderTablePdf(doc());
  const text = buf.toString("latin1");

  assert.ok(text.startsWith("%PDF-1.4\n"), "must carry a PDF header");
  assert.ok(text.trimEnd().endsWith("%%EOF"), "must be terminated with %%EOF");

  const { entries, count } = parseXref(buf);
  assert.equal(entries[0].type, "f", "object 0 is always the free head of the list");

  // The real assertion: every offset lands exactly on its object header.
  for (let i = 1; i < count; i++) {
    const at = text.slice(entries[i].offset);
    assert.ok(
      at.startsWith(`${i} 0 obj`),
      `xref offset for object ${i} points at ${JSON.stringify(at.slice(0, 20))}`
    );
  }

  // /Size must match the number of objects or readers reject the trailer.
  const size = Number(/\/Size (\d+)/.exec(text)[1]);
  assert.equal(size, count);
  assert.ok(/\/Root 1 0 R/.test(text), "the trailer must name the catalog");
});

test("declared stream lengths match the actual stream bytes", () => {
  const buf = renderTablePdf(doc());
  const text = buf.toString("latin1");
  const re = /<< \/Length (\d+) >>\nstream\n/g;
  let m;
  let streams = 0;
  while ((m = re.exec(text))) {
    const declared = Number(m[1]);
    const start = m.index + m[0].length;
    const end = text.indexOf("\nendstream", start);
    assert.equal(end - start, declared, "a wrong /Length silently truncates the page");
    streams += 1;
  }
  assert.ok(streams >= 1, "at least one content stream must exist");
});

test("the naira sign is spelled out rather than emitted as an unmappable byte", () => {
  const text = renderTablePdf(doc()).toString("latin1");
  assert.ok(text.includes("NGN125,000.00"), "money must survive into the page text");
  assert.ok(!text.includes("₦"), "no character outside WinAnsi may reach the stream");
});

test("parentheses in data cannot break out of a PDF string", () => {
  // An unescaped ")" ends the string early and corrupts every following object.
  const text = renderTablePdf({
    title: "T",
    columns: ["note"],
    rows: [["Refund (duplicate charge) \\ backslash"]],
  }).toString("latin1");
  assert.ok(text.includes("\\(duplicate charge\\)"), "parentheses must be escaped");
  assert.ok(text.includes("\\\\ backslash"), "backslashes must be escaped");
});

test("long free text is truncated before narrow columns are", () => {
  const long = "x".repeat(400);
  const lines = layoutTable(
    ["date", "description", "amount"],
    [["2026-07-01", long, "1,234.00"]],
    80
  );
  const row = lines[2];
  assert.ok(row.startsWith("2026-07-01"), "the date column must stay intact");
  assert.ok(row.endsWith("1,234.00"), "the amount column must stay intact");
  assert.ok(row.length <= 80, `line was ${row.length} chars`);
  assert.ok(row.includes("..."), "the truncated cell must show it was truncated");
});

test("an empty report says so instead of producing a blank page", () => {
  const text = renderTablePdf({ title: "Empty", columns: ["a"], rows: [] }).toString("latin1");
  assert.ok(text.includes("No rows matched"), "an empty export must state that it is empty");
});

test("long tables paginate and every page is numbered", () => {
  const rows = Array.from({ length: PDF_LAYOUT.BODY_LINES * 2 + 5 }, (_, i) => [
    `2026-07-${String((i % 28) + 1).padStart(2, "0")}`,
    `row ${i}`,
  ]);
  const text = renderTablePdf({ title: "Big", columns: ["date", "label"], rows }).toString("latin1");
  const pageCount = (text.match(/\/Type \/Page[^s]/g) ?? []).length;
  assert.ok(pageCount >= 3, `expected pagination, got ${pageCount} pages`);
  assert.ok(text.includes(`(Page 1 of ${pageCount})`));
  assert.ok(text.includes(`(Page ${pageCount} of ${pageCount})`));
  assert.equal(Number(/\/Count (\d+)/.exec(text)[1]), pageCount, "/Count must match the kids");
});

test("the header block never overlaps the first table row", () => {
  // Regression: the header was a fixed 52pt, so a report with three or more
  // meta lines drew the last one on top of the column header. Both were still
  // "in the file" — they just could not both be read.
  for (const metaCount of [0, 1, 3, 4, 6]) {
    const text = renderTablePdf({
      title: "T",
      meta: Array.from({ length: metaCount }, (_, i) => `meta ${i}`),
      columns: ["date", "value"],
      rows: [["2026-07-01", "1.00"]],
    }).toString("latin1");

    // Text positions in drawing order: title, each meta line, then the body.
    const ys = [...text.matchAll(/^\d+(?:\.\d+)? (\d+(?:\.\d+)?) Td$/gm)].map((m) => Number(m[1]));
    const lastHeaderY = ys[metaCount]; // title is index 0
    const bodyY = ys[metaCount + 1];
    assert.ok(
      lastHeaderY - bodyY >= 8,
      `with ${metaCount} meta lines the body starts ${lastHeaderY - bodyY}pt below the header`
    );
  }
});

test("more meta lines leave room for fewer body lines per page", () => {
  const rows = Array.from({ length: 200 }, (_, i) => [String(i)]);
  const pages = (meta) =>
    (renderTablePdf({ title: "T", meta, columns: ["n"], rows })
      .toString("latin1")
      .match(/\/Type \/Page[^s]/g) ?? []).length;
  assert.ok(
    pages(["a", "b", "c", "d", "e", "f"]) >= pages([]),
    "a taller header must not silently push rows off the page"
  );
});

test("toWinAnsi keeps Latin-1 accents and replaces what it cannot encode", () => {
  assert.equal(toWinAnsi("Café"), "Café");
  assert.equal(toWinAnsi("—"), "-");
  assert.equal(toWinAnsi("₦500"), "NGN500");
  assert.equal(toWinAnsi("日本"), "??");
});
