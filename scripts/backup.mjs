#!/usr/bin/env node
/**
 * Database backup.
 *
 * Usage:
 *   node scripts/backup.mjs [--out DIR] [--keep N] [--verify]
 *
 * SQLite (development, ADR-LOCAL-001) is backed up with the online backup API
 * via `VACUUM INTO`, not by copying the file. A plain copy of a live SQLite
 * database can capture a half-written page and restore as a corrupt file that
 * only fails months later when someone reads that row.
 *
 * PostgreSQL (production) shells out to pg_dump in custom format, which is
 * what pg_restore needs for selective restore and parallel load.
 *
 * The backup is verified by reopening it and counting rows, because a backup
 * that has never been read is a hypothesis, not a backup.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

const outDir = resolve(flag("out", join(repo, "backups")));
const keep = Number(flag("keep", 7));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const databaseUrl =
  process.env.DATABASE_URL ?? `file:${join(repo, "packages/database/prisma/dev.db")}`;

mkdirSync(outDir, { recursive: true });

function backupSqlite() {
  // Resolve `file:./dev.db` relative to the schema, the way Prisma does.
  const raw = databaseUrl.replace(/^file:/, "");
  const dbPath = raw.startsWith(".")
    ? resolve(repo, "packages/database/prisma", raw)
    : resolve(raw);

  const target = join(outDir, `lodgiva-${stamp}.db`);
  // VACUUM INTO takes a consistent snapshot of a live database and compacts it
  // on the way out. Requires SQLite 3.27+ (2019), which every supported Node
  // build ships with.
  const sqlite = process.env.SQLITE_BIN ?? "sqlite3";
  try {
    execFileSync(sqlite, [dbPath, `VACUUM INTO '${target.replace(/'/g, "''")}'`], {
      stdio: "pipe",
    });
  } catch (err) {
    if (err.code === "ENOENT") {
      // No sqlite3 binary on this machine. Fall back to node:sqlite's backup,
      // available in Node 22+, rather than silently doing nothing.
      return backupSqliteViaNode(dbPath, target);
    }
    throw err;
  }
  return target;
}

async function backupSqliteViaNode(dbPath, target) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  db.close();
  return target;
}

function backupPostgres() {
  const target = join(outDir, `lodgiva-${stamp}.dump`);
  // --format=custom is required for pg_restore's selective and parallel modes.
  // --no-owner keeps the dump restorable into a differently-owned database,
  // which is what a staging restore drill actually needs.
  execFileSync(
    process.env.PG_DUMP_BIN ?? "pg_dump",
    ["--format=custom", "--no-owner", "--no-acl", "--file", target, databaseUrl],
    { stdio: "pipe" }
  );
  return target;
}

async function verify(target) {
  if (target.endsWith(".dump")) {
    // pg_restore --list parses the archive's table of contents; if the file is
    // truncated or corrupt this is where it fails.
    const out = execFileSync(process.env.PG_RESTORE_BIN ?? "pg_restore", ["--list", target], {
      encoding: "utf8",
    });
    const entries = out.split("\n").filter((l) => l && !l.startsWith(";")).length;
    if (entries === 0) throw new Error("archive lists no objects");
    return { entries };
  }

  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(target, { readOnly: true });
  const integrity = db.prepare("PRAGMA integrity_check").get();
  const result = String(Object.values(integrity)[0]);
  if (result !== "ok") throw new Error(`integrity_check returned ${result}`);

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all();
  let rows = 0;
  for (const t of tables) {
    const c = db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get();
    rows += Number(c.n);
  }
  db.close();
  return { tables: tables.length, rows };
}

function prune() {
  const files = readdirSync(outDir)
    .filter((f) => f.startsWith("lodgiva-"))
    .map((f) => ({ f, t: statSync(join(outDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  const removed = files.slice(keep);
  for (const { f } of removed) rmSync(join(outDir, f));
  return removed.map((r) => r.f);
}

const isPostgres = /^postgres(ql)?:/.test(databaseUrl);

try {
  const target = isPostgres ? backupPostgres() : await backupSqlite();
  const size = statSync(target).size;

  let verification = null;
  if (has("verify")) verification = await verify(target);

  const pruned = prune();

  console.log(
    JSON.stringify(
      {
        ok: true,
        engine: isPostgres ? "postgresql" : "sqlite",
        file: target,
        bytes: size,
        verified: verification,
        pruned,
        retained: keep,
      },
      null,
      2
    )
  );
} catch (err) {
  // Non-zero exit so cron and CI notice. A backup job that fails quietly is
  // indistinguishable from one that never ran.
  console.error(
    JSON.stringify({ ok: false, error: err.message, engine: isPostgres ? "postgresql" : "sqlite" })
  );
  process.exit(1);
}
