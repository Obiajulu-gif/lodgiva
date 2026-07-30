import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv, requireColumns, CsvError } from "../../dist/common/csv.js";

test("parses a simple file", () => {
  const { headers, rows } = parseCsv("room_number,floor\n101,1\n102,2\n");
  assert.deepEqual(headers, ["room_number", "floor"]);
  assert.equal(rows.length, 2);
  assert.deepEqual({ ...rows[0] }, { room_number: "101", floor: "1" });
});

test("handles quoted fields containing commas", () => {
  const { rows } = parseCsv('code,name\nDLX,"Deluxe, sea view"\n');
  assert.equal(rows[0].name, "Deluxe, sea view");
});

test("handles escaped quotes", () => {
  const { rows } = parseCsv('code,name\nSTD,"The ""Garden"" Room"\n');
  assert.equal(rows[0].name, 'The "Garden" Room');
});

test("handles newlines inside quoted fields", () => {
  const { rows } = parseCsv('code,note\nA,"line one\nline two"\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].note, "line one\nline two");
});

test("handles CRLF line endings from Excel", () => {
  const { rows } = parseCsv("a,b\r\n1,2\r\n3,4\r\n");
  assert.equal(rows.length, 2);
  assert.equal(rows[1].a, "3");
});

test("strips a UTF-8 BOM", () => {
  const { headers } = parseCsv("﻿room_number,floor\n101,1\n");
  assert.deepEqual(headers, ["room_number", "floor"]);
});

test("ignores trailing blank lines", () => {
  const { rows } = parseCsv("a\n1\n\n");
  assert.equal(rows.length, 1);
});

test("missing trailing cells become empty strings, not undefined", () => {
  const { rows } = parseCsv("a,b,c\n1,2\n");
  assert.equal(rows[0].c, "");
});

test("rejects an unterminated quoted field", () => {
  assert.throws(() => parseCsv('a\n"oops\n'), CsvError);
});

test("rejects duplicate headers", () => {
  assert.throws(() => parseCsv("a,a\n1,2\n"), CsvError);
});

test("rejects an empty file", () => {
  assert.throws(() => parseCsv(""), CsvError);
});

test("enforces the row cap", () => {
  const big = "a\n" + "1\n".repeat(20);
  assert.throws(() => parseCsv(big, 5), CsvError);
});

test("rows have a null prototype so __proto__ cannot be injected", () => {
  const { rows } = parseCsv("__proto__,a\npolluted,1\n");
  assert.equal(Object.getPrototypeOf(rows[0]), null);
  assert.equal({}.polluted, undefined);
});

test("requireColumns lists every missing column at once", () => {
  assert.doesNotThrow(() => requireColumns(["a", "b"], ["a"]));
  assert.throws(
    () => requireColumns(["a"], ["a", "b", "c"]),
    (e) => e instanceof CsvError && e.message.includes("b, c")
  );
});
