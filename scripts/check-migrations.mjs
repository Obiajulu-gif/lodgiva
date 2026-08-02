#!/usr/bin/env node
/**
 * Pre-deploy migration safety checks.
 *
 * Usage: node scripts/check-migrations.mjs [--strict]
 *
 * Answers the three questions that decide whether a deploy is safe:
 *
 *  1. Is every migration on disk applied, and is every applied migration still
 *     on disk? A migration that exists in the database but not in the repo
 *     means someone deployed from a branch that no longer exists.
 *  2. Did any migration fail part-way? Prisma records these; deploying on top
 *     of a failed migration compounds the damage.
 *  3. Does any pending migration contain a statement that breaks a running
 *     older version of the app? A dropped column is not a schema change, it is
 *     an outage for every instance still serving traffic during the rollout.
 *
 * Exits non-zero on any blocking finding, so CI can gate on it.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
// Overridable so the destructive-statement rules can be exercised against a
// fixture directory rather than only against whatever the repo happens to
// contain today.
const migrationsDir = process.env.MIGRATIONS_DIR
  ? resolve(process.env.MIGRATIONS_DIR)
  : join(repo, "packages/database/prisma/migrations");

const strict = process.argv.includes("--strict");

/**
 * Statements that are unsafe during a rolling deploy, because the previous
 * version of the application is still running while they take effect.
 */
const DESTRUCTIVE = [
  {
    pattern: /\bDROP\s+TABLE\b/i,
    code: "DROP_TABLE",
    why: "The running version may still read this table. Ship the code that stops using it first, then drop it in a later release.",
  },
  {
    pattern: /\bDROP\s+COLUMN\b/i,
    code: "DROP_COLUMN",
    why: "SELECTs from the old version will fail. Deploy the code that no longer references the column, then drop it.",
  },
  {
    pattern: /\bALTER\s+COLUMN\b.*\bNOT\s+NULL\b/i,
    code: "ADD_NOT_NULL",
    why: "Existing rows and in-flight writes from the old version may have NULLs. Backfill first, constrain second.",
  },
  {
    pattern: /\bRENAME\s+(COLUMN|TO)\b/i,
    code: "RENAME",
    why: "A rename is a drop and an add at the same instant. Add the new name, migrate reads and writes, then remove the old.",
  },
  {
    pattern: /\bCREATE\s+(UNIQUE\s+)?INDEX\b(?!\s+CONCURRENTLY)/i,
    code: "BLOCKING_INDEX",
    why: "On PostgreSQL this locks the table for writes. Use CREATE INDEX CONCURRENTLY on anything with real row counts.",
    postgresOnly: true,
  },
];

function onDisk() {
  if (!existsSync(migrationsDir)) return [];
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

async function applied() {
  // Resolved from the database package rather than the repo root: in a pnpm
  // workspace the root has no @prisma/client, and this script is run from
  // wherever CI happens to be standing.
  const { createRequire } = await import("node:module");
  const require = createRequire(join(repo, "packages/database/package.json"));
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRawUnsafe(
      "SELECT migration_name, finished_at, rolled_back_at, applied_steps_count FROM _prisma_migrations ORDER BY migration_name"
    );
    return rows.map((r) => ({
      name: r.migration_name,
      finished: !!r.finished_at,
      rolledBack: !!r.rolled_back_at,
      steps: Number(r.applied_steps_count ?? 0),
    }));
  } catch (err) {
    // No migrations table at all is a legitimate first-deploy state; anything
    // else is a real failure worth surfacing.
    if (/_prisma_migrations/.test(String(err.message))) return [];
    throw err;
  } finally {
    await prisma.$disconnect();
  }
}

const isPostgres = /^postgres/.test(process.env.DATABASE_URL ?? "");

function scan(names) {
  const findings = [];
  for (const name of names) {
    const file = join(migrationsDir, name, "migration.sql");
    if (!existsSync(file)) continue;
    const sql = readFileSync(file, "utf8");
    // Strip comments so a rule cannot fire on a sentence describing the rule.
    const body = sql.replace(/--[^\n]*/g, "");
    for (const rule of DESTRUCTIVE) {
      if (rule.postgresOnly && !isPostgres) continue;
      if (rule.pattern.test(body)) {
        findings.push({ migration: name, code: rule.code, why: rule.why });
      }
    }
  }
  return findings;
}

const disk = onDisk();
const db = await applied();
const appliedNames = new Set(db.filter((m) => m.finished && !m.rolledBack).map((m) => m.name));

const pending = disk.filter((m) => !appliedNames.has(m));
const orphaned = db.filter((m) => !disk.includes(m.name)).map((m) => m.name);
const failed = db.filter((m) => !m.finished && !m.rolledBack).map((m) => m.name);

const blocking = [];
if (orphaned.length) {
  blocking.push({
    code: "ORPHANED_MIGRATIONS",
    detail: orphaned,
    why: "These are recorded as applied but are not in the repository. The database was migrated from a branch this deploy does not contain.",
  });
}
if (failed.length) {
  blocking.push({
    code: "FAILED_MIGRATIONS",
    detail: failed,
    why: "A migration started and never finished. Resolve it (prisma migrate resolve) before deploying anything on top of it.",
  });
}

const destructive = scan(pending);
// Destructive statements are a warning by default and a blocker under
// --strict, which is what a rolling production deploy should run.
if (strict && destructive.length) {
  blocking.push({ code: "DESTRUCTIVE_PENDING", detail: destructive, why: "Unsafe during a rolling deploy." });
}

const report = {
  ok: blocking.length === 0,
  engine: isPostgres ? "postgresql" : "sqlite",
  migrationsOnDisk: disk.length,
  applied: appliedNames.size,
  pending,
  destructivePending: destructive,
  blocking,
};

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
