#!/usr/bin/env bash
# Importer tests: throwaway Postgres 16 + Supabase stub + all v4 migrations
# (shared machinery: v4/tests/db/cluster.sh), then node:test against the
# synthetic fixture workbook. Exits non-zero on failure.
#   bash v4/tools/import-legacy/test.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../tests/db/cluster.sh
source "$HERE/../../tests/db/cluster.sh"

cluster_start
cluster_bootstrap
echo "==> migrations"
cluster_migrate 1

echo "==> importer tests"
cd "$HERE"
if [ ! -d node_modules/exceljs ] || [ ! -d node_modules/pg ]; then
  if [ -f package-lock.json ]; then npm ci --silent --no-audit --no-fund; else npm install --silent --no-audit --no-fund; fi
fi
cluster_env
node --test --test-concurrency=1 "$HERE"/test/*.test.mjs
