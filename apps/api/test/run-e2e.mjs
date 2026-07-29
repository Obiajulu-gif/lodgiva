/* Runs the e2e suite against a freshly seeded development database.
 *
 * The suite is written to be re-runnable on its own (it prepares rooms and
 * closes stale shifts), but a known-clean database is the reliable way to run
 * it. Rows are truncated rather than the file deleted, so this works while the
 * API is running. Local SQLite only — never point it at a shared database.
 */
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dbDir = resolve(here, "../../../packages/database");
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: "inherit" });

console.log("Resetting local development database…");
run("node src/reset.js", dbDir);
run("node src/seed.js", dbDir);

console.log("\nRunning e2e suite…\n");
run("node test/e2e.mjs", resolve(here, ".."));
