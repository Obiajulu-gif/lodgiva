#!/usr/bin/env bash
# Brings up a disposable PostgreSQL for the integration and E2E suites.
#
#   bash scripts/test-db-up.sh
#
# Creates a database named `lodgiva_test` on loopback and an application login
# role that is deliberately NOT a superuser and NOT BYPASSRLS, so the suites
# exercise the same row-level security production runs under. A test that
# passes as the owner proves nothing about tenant isolation.
#
# Migrations run as the owner; the suites connect as the restricted role.
# Those are different jobs and must not share a connection string.
#
# Safe by construction: everything here targets localhost/lodgiva_test, which
# is exactly what scripts/../packages/database/src/reset.js will accept and
# what it refuses to confuse with a managed host.
set -euo pipefail

DB_NAME="lodgiva_test"
APP_ROLE="lodgiva_test_app"
# A throwaway password for a loopback-only database. Not a secret, and
# deliberately not reused anywhere that matters.
APP_PASSWORD="localtestonly"
PG_PORT="${PG_PORT:-5432}"

say() { printf '\n== %s\n' "$1"; }

say "waiting for psql"
for _ in $(seq 1 60); do
  command -v psql >/dev/null 2>&1 && break
  sleep 5
done
command -v psql >/dev/null 2>&1 || { echo "psql never appeared; is the install still running?" >&2; exit 1; }
psql --version

say "starting the cluster"
# WSL has no systemd by default, so drive the cluster directly.
CLUSTER="$(pg_lsclusters -h 2>/dev/null | awk 'NR==1{print $1" "$2}')"
if [ -n "${CLUSTER:-}" ]; then
  # shellcheck disable=SC2086
  sudo pg_ctlcluster ${CLUSTER} start 2>/dev/null || true
fi
for _ in $(seq 1 30); do
  sudo -u postgres pg_isready -q -p "$PG_PORT" && break
  sleep 2
done
sudo -u postgres pg_isready -p "$PG_PORT"

say "creating $DB_NAME and the restricted role"
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
SELECT 'dropping existing test database' WHERE EXISTS (SELECT 1 FROM pg_database WHERE datname = '$DB_NAME');
SQL
sudo -u postgres dropdb --if-exists "$DB_NAME"
sudo -u postgres createdb "$DB_NAME"

sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$APP_ROLE') THEN
    CREATE ROLE $APP_ROLE LOGIN PASSWORD '$APP_PASSWORD';
  ELSE
    ALTER ROLE $APP_ROLE LOGIN PASSWORD '$APP_PASSWORD';
  END IF;
END \$\$;
-- The properties that make the test meaningful. If any of these were true,
-- RLS would be bypassed and an isolation test would pass for the wrong reason.
ALTER ROLE $APP_ROLE NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
SQL

say "role restrictions (all must be false)"
sudo -u postgres psql -At -d "$DB_NAME" -c \
  "SELECT format('superuser=%s bypassrls=%s createdb=%s createrole=%s', rolsuper, rolbypassrls, rolcreatedb, rolcreaterole) FROM pg_roles WHERE rolname = '$APP_ROLE';"

cat <<INFO

== connection strings

Owner (migrations, reset):
  postgresql://postgres@localhost:$PG_PORT/$DB_NAME

Application (the suites; restricted, subject to RLS):
  postgresql://$APP_ROLE:$APP_PASSWORD@localhost:$PG_PORT/$DB_NAME

Next:
  DATABASE_URL=postgresql://postgres@localhost:$PG_PORT/$DB_NAME \\
  DIRECT_URL=postgresql://postgres@localhost:$PG_PORT/$DB_NAME \\
    pnpm --filter @lodgiva/database run migrate

Then grant the app role its rights (the migration creates lodgiva_app):
  sudo -u postgres psql -d $DB_NAME -c "ALTER ROLE $APP_ROLE INHERIT;"
  sudo -u postgres psql -d $DB_NAME -c "GRANT lodgiva_app TO $APP_ROLE WITH INHERIT TRUE;"

WITH INHERIT TRUE is required on PostgreSQL 16+. There, a membership's
inherit option is fixed when the GRANT runs (from the role's INHERIT
attribute at that moment). A grant made while the role was NOINHERIT stays
non-inheriting even after ALTER ROLE ... INHERIT, and every query then fails
with "permission denied for table User".
INFO
