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
# Cluster helpers live in cluster.sh (shared with v4/tools/import-legacy/test.sh).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=cluster.sh
source "$HERE/cluster.sh"
SEED_FILE="$CLUSTER_V4_DIR/supabase/seed.sql"

cluster_start
cluster_bootstrap

echo "==> migrations, pass 1 (fresh database)"
cluster_migrate 1
echo "==> migrations, pass 2 (re-apply must be a no-op)"
cluster_migrate 2

echo "==> seed (twice)"
cluster_psql_file "$SEED_FILE"
cluster_psql_file "$SEED_FILE"

echo "==> node tests"
cd "$HERE"
if [ ! -d node_modules/pg ]; then
  if [ -f package-lock.json ]; then npm ci --silent --no-audit --no-fund; else npm install --silent --no-audit --no-fund; fi
fi
cluster_set_test_secrets
cluster_env
node --test --test-concurrency=1 "$HERE"/*.test.mjs
