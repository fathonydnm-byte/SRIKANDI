#!/usr/bin/env bash
# Round-trip proof of backup + restore on a throwaway Postgres 16 (shared machinery: v4/tests/db/cluster.sh).
#
#   1. two databases, both with the Supabase stub and ALL migrations: source (seeded with synthetic data) and an empty target
#   2. server/jobsExport.ts is bundled (rolldown, from v4/web/node_modules) so Node can run the REAL module
#   3. node:test (test/roundtrip.test.mjs): real Code.gs (vm, fake Google services) -> real jobsExport -> PostgREST-like adapter
#      -> source DB; package written by the job -> restore.mjs -> target DB; canonical dump comparison; failure scenarios
#
#   bash v4/tools/restore-backup/test.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../tests/db/cluster.sh
source "$HERE/../../tests/db/cluster.sh"
WEB="$CLUSTER_V4_DIR/web"

echo "==> bundle server/jobsExport.ts"
if [ ! -x "$WEB/node_modules/.bin/rolldown" ]; then (cd "$WEB" && npm ci --silent --no-audit --no-fund); fi
BUNDLE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cf-jobs-bundle.XXXXXX")"
(cd "$WEB" && ./node_modules/.bin/rolldown server/jobsExport.ts --format esm --file "$BUNDLE_DIR/jobsExport.mjs" >/dev/null)
trap 'rm -rf "$BUNDLE_DIR"' EXIT

cluster_start
cluster_bootstrap
echo "==> migrations: source database"
cluster_migrate 1
echo "==> migrations: empty restore target"
"${CLUSTER_PSQL[@]}" -U "$CLUSTER_SUPERUSER" -d postgres -c "create database cf_restore"
CLUSTER_DB=cf_restore cluster_bootstrap
CLUSTER_DB=cf_restore cluster_migrate 1

echo "==> round-trip tests"
cd "$HERE"
if [ ! -d node_modules/pg ]; then
  if [ -f package-lock.json ]; then npm ci --silent --no-audit --no-fund; else npm install --silent --no-audit --no-fund; fi
fi
cluster_env
export CF_RESTORE_DB=cf_restore CF_JOBS_BUNDLE="$BUNDLE_DIR/jobsExport.mjs"
node --test --test-concurrency=1 "$HERE"/test/*.test.mjs
