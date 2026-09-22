/**
 * packages/database/src/reset.js deletes every row in the database it points
 * at. Its guard is the only thing between a mistyped DATABASE_URL and an
 * empty production database, so it is exercised here by actually running the
 * script against URLs it must refuse.
 *
 * This also catches the script being broken outright: on 2026-09-17 a "\n"
 * inside it was written as a literal line break, so it failed to parse and
 * the reset (and the e2e suite that calls it) could not run at all - for five
 * days, because nothing ran it. A refusal test fails loudly on a SyntaxError.
 *
 * No database is touched: every URL below is refused before any connection.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, "../../../../packages/database/src/reset.js");

function runReset(databaseUrl) {
  const res = spawnSync(process.execPath, [script], {
    env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: res.status, out: `${res.stdout}\n${res.stderr}` };
}

const MUST_REFUSE = [
  ["a managed Neon host", "postgresql://u:p@ep-cool-x-pooler.us-east-2.aws.neon.tech/neondb"],
  ["a local database not named *_test", "postgresql://u:p@localhost:5432/lodgiva"],
  ["a remote host even when named *_test", "postgresql://u:p@db.example.com:5432/lodgiva_test"],
  ["Supabase", "postgresql://u:p@db.abc.supabase.co:5432/app_test"],
  ["a non-PostgreSQL URL", "mysql://u:p@localhost:3306/lodgiva_test"],
];

for (const [label, url] of MUST_REFUSE) {
  test(`reset refuses ${label}`, () => {
    const { code, out } = runReset(url);
    assert.doesNotMatch(out, /SyntaxError/, "reset.js must at least parse");
    assert.notEqual(code, 0, `reset must exit non-zero for ${label}`);
    assert.match(out, /Refusing/, `reset must explain the refusal for ${label}`);
    assert.doesNotMatch(out, /Cleared \d+ tables/, "nothing may be cleared");
  });
}

test("reset never echoes the connection string it refused", () => {
  const secret = "s3cretPassw0rd";
  const { out } = runReset(`postgresql://owner:${secret}@ep-x.neon.tech/neondb`);
  assert.doesNotMatch(out, new RegExp(secret), "a refused URL's password must not be printed");
});
