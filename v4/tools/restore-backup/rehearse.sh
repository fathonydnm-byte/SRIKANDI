#!/usr/bin/env bash
# Restore real backup packages into a new, socket-only PostgreSQL test cluster.
set -euo pipefail
umask 077

if [[ "$#" -lt 1 || "$1" == "-h" || "$1" == "--help" ]]; then
  echo "Pemakaian: bash rehearse.sh <folder-atau-zip> [<folder-atau-zip> ...]"
  [[ "$#" -gt 0 ]]
  exit
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$here/../../tests/db/cluster.sh"
CLUSTER_DB="cf_restore_rehearsal"
# Keep the temporary database off shared mounts and away from an existing cluster.
export CF_DB_TMP_ROOT=/tmp

package_args=()
for package in "$@"; do
  if [[ ! -f "$package" && ! -d "$package" ]]; then
    echo "Paket tidak ditemukan: $package" >&2
    exit 2
  fi
  package_args+=(--package "$package")
done
for exe in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$exe" ]]; then
    echo "PostgreSQL 16 tidak ditemukan: pasang PostgreSQL 16 atau arahkan PG_BIN ke direktori bin." >&2
    exit 1
  fi
done
if [[ ! -f "$here/node_modules/pg/package.json" ]]; then
  echo "Jalankan npm ci --prefix v4/tools/restore-backup terlebih dahulu." >&2
  exit 1
fi

cluster_start
cluster_bootstrap
cluster_migrate 1
sock_encoded="$(node -p 'encodeURIComponent(process.argv[1])' "$CLUSTER_SOCK")"
# The socket path is unique to this run. No caller-supplied connection string is used.
export CF_REHEARSAL_DATABASE_URL="postgresql://postgres@localhost/$CLUSTER_DB?host=$sock_encoded&port=$CLUSTER_PORT"

echo "==> Uji pemulihan tanpa menyimpan hasil"
node "$here/restore.mjs" "${package_args[@]}" --database-url-env CF_REHEARSAL_DATABASE_URL --dry-run
echo "==> Pemulihan ke database latihan"
node "$here/restore.mjs" "${package_args[@]}" --database-url-env CF_REHEARSAL_DATABASE_URL
echo "Latihan pemulihan lulus. Database sementara dibersihkan saat proses berakhir."
