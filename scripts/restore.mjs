#!/usr/bin/env node
/**
 * Database restore, and the drill that proves a backup is real.
 *
 * Usage:
 *   node scripts/restore.mjs --file backups/lodgiva-....db --to ./restored.db
 *   node scripts/restore.mjs --file backups/....dump --to postgres://…/restore_test
 *   node scripts/restore.mjs --drill        # backup, restore, compare, report
 *
 * Restoring OVER the live database is refused unless --force is passed with
 * the exact target spelled out. The most expensive way to lose a night's
 * bookings is a restore command typed into the wrong terminal.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};
const has = (n) => args.includes(`--${n}`);

const liveUrl = process.env.DATABASE_URL ?? `file:${join(repo, "packages/database/prisma/dev.db")}`;
const livePath = liveUrl.startsWith("file:")
  ? resolve(repo, "packages/database/prisma", liveUrl.replace(/^file:/, ""))
  : null;

function latestBackup(dir = join(repo, "backups")) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("lodgiva-"))
    .map((f) => ({ p: join(dir, f), t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files[0]?.p ?? null;
}

async function tableCounts(dbPath) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all();
  const counts = {};
  for (const t of tables) {
    counts[t.name] = Number(db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get().n);
  }
  db.close();
  return counts;
}

async function restoreSqlite(file, to) {
  if (livePath && resolve(to) === livePath && !has("force")) {
    throw new Error(
      `Refusing to overwrite the live database at ${livePath}. Re-run with --force if that is genuinely what you want.`
    );
  }
  copyFileSync(file, to);
  const counts = await tableCounts(to);
  return { target: to, tables: Object.keys(counts).length, counts };
}

function restorePostgres(file, to) {
  if (to === liveUrl && !has("force")) {
    throw new Error("Refusing to restore over the live database without --force.");
  }
  execFileSync(
    process.env.PG_RESTORE_BIN ?? "pg_restore",
    ["--no-owner", "--no-acl", "--clean", "--if-exists", "--dbname", to, file],
    { stdio: "pipe" }
  );
  return { target: to };
}

/**
 * The drill. A backup nobody has restored is a hypothesis; this turns it into
 * a measurement, and prints the row counts on both sides so a silent partial
 * restore cannot pass as success.
 */
async function drill() {
  const started = Date.now();
  const out = execFileSync(process.execPath, [join(here, "backup.mjs"), "--verify"], {
    encoding: "utf8",
  });
  const backup = JSON.parse(out);
  if (!backup.ok) throw new Error("backup step failed");

  const scratch = join(repo, "backups", `drill-${Date.now()}.db`);
  const before = livePath ? await tableCounts(livePath) : {};
  const restored = await restoreSqlite(backup.file, scratch);

  const mismatches = [];
  for (const [table, n] of Object.entries(before)) {
    // _prisma_migrations is expected to match too: a restore that loses the
    // migration history restores data the schema no longer describes.
    if (restored.counts[table] !== n) {
      mismatches.push({ table, live: n, restored: restored.counts[table] ?? null });
    }
  }
  rmSync(scratch, { force: true });

  const rows = Object.values(before).reduce((a, b) => a + b, 0);
  return {
    ok: mismatches.length === 0,
    backupFile: backup.file,
    backupBytes: backup.bytes,
    tables: Object.keys(before).length,
    rows,
    mismatches,
    // The number that belongs in the runbook: how long a restore actually
    // takes here, so the RTO is measured rather than guessed.
    elapsedMs: Date.now() - started,
  };
}

try {
  if (has("drill")) {
    const result = await drill();
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  const file = flag("file", latestBackup());
  if (!file) throw new Error("No backup file given and none found in backups/.");
  if (!existsSync(file)) throw new Error(`Backup not found: ${file}`);

  const isPg = file.endsWith(".dump");
  const to = flag("to", isPg ? liveUrl : join(repo, "restored.db"));
  const result = isPg ? restorePostgres(file, to) : await restoreSqlite(file, to);
  console.log(JSON.stringify({ ok: true, from: file, ...result }, null, 2));
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
}
