# cluster.sh — sourceable helpers for a throwaway Postgres 16 cluster with the
# Supabase stub and the v4 migrations. Used by v4/tests/db/run.sh and
# v4/tools/import-legacy/test.sh. Source it, then call:
#
#   cluster_start            # initdb + start, sets PGHOST/PGPORT/PGDATABASE/PGUSER exports via cluster_env
#   cluster_bootstrap        # Supabase stub
#   cluster_migrate <label>  # apply every migration in filename order
#   cluster_psql_file <file> # run a SQL file as the migration owner (postgres)
#   cluster_set_test_secrets # test-only app.secret.* settings (Vault stand-in)
#   cluster_env              # export PG* so node `pg` connects as postgres
#
# Cleanup (stop + delete) is installed as an EXIT trap by cluster_start.
# Env: PG_BIN (default /usr/lib/postgresql/16/bin), CF_DB_PORT (default 54329),
# CF_DB_TMP_ROOT (default $TMPDIR or /tmp).

CLUSTER_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLUSTER_V4_DIR="$(cd "$CLUSTER_LIB_DIR/../.." && pwd)"
CLUSTER_MIGRATIONS_DIR="$CLUSTER_V4_DIR/supabase/migrations"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
CLUSTER_PORT="${CF_DB_PORT:-54329}"
CLUSTER_DB="cf_test"
CLUSTER_SUPERUSER="supabase_admin"

cluster_cleanup() {
  local code=$?
  if [ -n "${CLUSTER_DATA:-}" ] && [ -f "$CLUSTER_DATA/postmaster.pid" ]; then
    "${CLUSTER_AS_PG[@]}" "$PG_BIN/pg_ctl" -D "$CLUSTER_DATA" -m immediate stop >/dev/null 2>&1 || true
  fi
  if [ $code -ne 0 ] && [ -f "${CLUSTER_LOG:-/nonexistent}" ]; then
    echo "---- postgres log (tail) ----" >&2
    tail -n 40 "$CLUSTER_LOG" >&2 || true
  fi
  [ -n "${CLUSTER_WORK:-}" ] && rm -rf "$CLUSTER_WORK"
  exit $code
}

cluster_start() {
  local tmp_root="${CF_DB_TMP_ROOT:-${TMPDIR:-/tmp}}"
  CLUSTER_WORK="$(mktemp -d "$tmp_root/cf-v4-db.XXXXXX")"
  CLUSTER_DATA="$CLUSTER_WORK/data"
  CLUSTER_SOCK="$CLUSTER_WORK/sock"
  CLUSTER_LOG="$CLUSTER_WORK/postgres.log"
  mkdir -p "$CLUSTER_SOCK"
  CLUSTER_AS_PG=()
  if [ "$(id -u)" = "0" ]; then
    id postgres >/dev/null 2>&1 || { echo "running as root but no 'postgres' OS user" >&2; exit 2; }
    chown -R postgres "$CLUSTER_WORK"
    CLUSTER_AS_PG=(runuser -u postgres --)
  fi
  trap cluster_cleanup EXIT
  echo "==> initdb ($CLUSTER_WORK)"
  "${CLUSTER_AS_PG[@]}" "$PG_BIN/initdb" -D "$CLUSTER_DATA" -U "$CLUSTER_SUPERUSER" --auth=trust -E UTF8 --no-locale >/dev/null
  "${CLUSTER_AS_PG[@]}" "$PG_BIN/pg_ctl" -D "$CLUSTER_DATA" -l "$CLUSTER_LOG" -w \
    -o "-c listen_addresses='' -k $CLUSTER_SOCK -p $CLUSTER_PORT -c max_connections=100 -c fsync=off -c TimeZone=UTC" start >/dev/null
  CLUSTER_PSQL=("$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$CLUSTER_SOCK" -p "$CLUSTER_PORT")
  "${CLUSTER_PSQL[@]}" -U "$CLUSTER_SUPERUSER" -d postgres -c "create database $CLUSTER_DB"
}

cluster_bootstrap() {
  echo "==> bootstrap Supabase stub"
  "${CLUSTER_PSQL[@]}" -U "$CLUSTER_SUPERUSER" -d "$CLUSTER_DB" -f "$CLUSTER_LIB_DIR/bootstrap_supabase_stub.sql"
}

cluster_psql_file() {
  "${CLUSTER_PSQL[@]}" -U postgres -d "$CLUSTER_DB" --single-transaction -f "$1"
}

cluster_migrate() {
  local pass="$1" f
  for f in "$CLUSTER_MIGRATIONS_DIR"/[0-9][0-9][0-9][0-9]_*.sql; do
    echo "    [$pass] $(basename "$f")"
    # pipefail + set -e in the caller: a psql failure aborts the run.
    cluster_psql_file "$f" 2>&1 | { grep -v -E 'NOTICE: .*(already exists|does not exist)' || true; }
  done
}

# Test-only server secrets (on Supabase they live in Vault). Superuser is
# needed to persist a custom setting on the database.
cluster_set_test_secrets() {
  export CF_TEST_UPLOAD_SECRET="${CF_TEST_UPLOAD_SECRET:-test-only-upload-attest-secret-0123456789abcdef}"
  "${CLUSTER_PSQL[@]}" -U "$CLUSTER_SUPERUSER" -d "$CLUSTER_DB" \
    -c "alter database $CLUSTER_DB set app.secret.UPLOAD_ATTEST_SECRET = '$CF_TEST_UPLOAD_SECRET'"
}

cluster_env() {
  export PGHOST="$CLUSTER_SOCK" PGPORT="$CLUSTER_PORT" PGDATABASE="$CLUSTER_DB" PGUSER=postgres
  export CF_MIGRATIONS_DIR="$CLUSTER_MIGRATIONS_DIR"
}
