#!/usr/bin/env bash
# Database test runner for Central File v4.
#
#   create throwaway cluster + db -> Supabase stub bootstrap -> apply all
#   migrations (twice, to prove idempotency) -> apply seed (twice) -> run
#   node:test suite -> tear down. Exits non-zero on any failure.
#
# Requirements: Postgres 16 server binaries (PG_BIN, default
# /usr/lib/postgresql/16/bin), node >= 20, npm (first run installs `pg`).
# When run as root, the cluster runs as the `postgres` OS user (initdb refuses
# root); the temp directory is then created under /tmp (override CF_DB_TMP_ROOT).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V4="$(cd "$HERE/../.." && pwd)"
MIGRATIONS_DIR="$V4/supabase/migrations"
SEED_FILE="$V4/supabase/seed.sql"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${CF_DB_PORT:-54329}"
DB="cf_test"
SUPERUSER="supabase_admin"
TMP_ROOT="${CF_DB_TMP_ROOT:-${TMPDIR:-/tmp}}"

WORK="$(mktemp -d "$TMP_ROOT/cf-v4-db.XXXXXX")"
DATA="$WORK/data"
SOCK="$WORK/sock"
LOG="$WORK/postgres.log"
mkdir -p "$SOCK"

AS_PG=()
if [ "$(id -u)" = "0" ]; then
  id postgres >/dev/null 2>&1 || { echo "running as root but no 'postgres' OS user" >&2; exit 2; }
  chown -R postgres "$WORK"
  AS_PG=(runuser -u postgres --)
fi

cleanup() {
  local code=$?
  if [ -f "$DATA/postmaster.pid" ]; then
    "${AS_PG[@]}" "$PG_BIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true
  fi
  if [ $code -ne 0 ] && [ -f "$LOG" ]; then
    echo "---- postgres log (tail) ----" >&2
    tail -n 40 "$LOG" >&2 || true
  fi
  rm -rf "$WORK"
  exit $code
}
trap cleanup EXIT

echo "==> initdb ($WORK)"
"${AS_PG[@]}" "$PG_BIN/initdb" -D "$DATA" -U "$SUPERUSER" --auth=trust -E UTF8 --no-locale >/dev/null
"${AS_PG[@]}" "$PG_BIN/pg_ctl" -D "$DATA" -l "$LOG" -w \
  -o "-c listen_addresses='' -k $SOCK -p $PORT -c max_connections=100 -c fsync=off -c TimeZone=UTC" start >/dev/null

PSQL=("$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$SOCK" -p "$PORT")

"${PSQL[@]}" -U "$SUPERUSER" -d postgres -c "create database $DB"

echo "==> bootstrap Supabase stub"
"${PSQL[@]}" -U "$SUPERUSER" -d "$DB" -f "$HERE/bootstrap_supabase_stub.sql"

apply_all() {
  local pass="$1" f
  for f in "$MIGRATIONS_DIR"/[0-9][0-9][0-9][0-9]_*.sql; do
    echo "    [$pass] $(basename "$f")"
    # pipefail + set -e: a psql failure aborts the run.
    "${PSQL[@]}" -U postgres -d "$DB" --single-transaction -f "$f" 2>&1 \
      | { grep -v -E 'NOTICE: .*(already exists|does not exist)' || true; }
  done
}

echo "==> migrations, pass 1 (fresh database)"
apply_all 1
echo "==> migrations, pass 2 (re-apply must be a no-op)"
apply_all 2

echo "==> seed (twice)"
"${PSQL[@]}" -U postgres -d "$DB" --single-transaction -f "$SEED_FILE"
"${PSQL[@]}" -U postgres -d "$DB" --single-transaction -f "$SEED_FILE"

echo "==> node tests"
cd "$HERE"
if [ ! -d node_modules/pg ]; then
  if [ -f package-lock.json ]; then npm ci --silent --no-audit --no-fund; else npm install --silent --no-audit --no-fund; fi
fi
PGHOST="$SOCK" PGPORT="$PORT" PGDATABASE="$DB" PGUSER=postgres \
CF_MIGRATIONS_DIR="$MIGRATIONS_DIR" \
  node --test --test-concurrency=1 "$HERE"/*.test.mjs
