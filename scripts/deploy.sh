#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

root="${CRASHGUARD_DEPLOY_DIR:-/opt/crashguard}"
export CRASHGUARD_DEPLOY_DIR="$root"
: "${CRASHGUARD_IMAGE:?Set the image digest to deploy}"
: "${NEXT_PUBLIC_APP_URL:?Set the public HTTPS origin}"
if [[ ! "$CRASHGUARD_IMAGE" =~ ^ghcr\.io/suciudan/crashguard@sha256:[a-f0-9]{64}$ ]]; then
  echo 'Deployment requires a CrashGuard image pinned by SHA-256 digest.' >&2
  exit 1
fi
if [[ "$root" != /* || ! -d "$root/data" || ! -f "$root/.env.production" ]]; then
  echo 'Create the absolute deployment directory, data directory, and .env.production first.' >&2
  exit 1
fi
command -v python3 >/dev/null
command -v flock >/dev/null
exec 9>"$root/deploy.lock"
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }

repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
compose=(docker compose --project-name crashguard-production --env-file "$root/.env.production" -f "$repo/compose.production.yaml")
if [[ "${CRASHGUARD_NATIVE:-0}" == 1 ]]; then
  compose+=(-f "$repo/compose.native.yaml")
fi
# Save the resolved configuration outside the runner checkout for host operations.
candidate="$root/compose.candidate.yaml"
"${compose[@]}" config > "$candidate"
docker compose --project-name crashguard-production -f "$candidate" pull

backup_dir="$root/backups/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p -- "$backup_dir"
if [[ -f "$root/compose.yaml" ]]; then
  cp -- "$root/compose.yaml" "$backup_dir/compose.yaml"
fi
# The SQLite backup API includes committed WAL data and works with a live writer.
python3 - "$root/data/crashguard.sqlite" "$backup_dir/crashguard.sqlite" <<'PY'
import pathlib
import sqlite3
import sys

source = pathlib.Path(sys.argv[1])
if source.exists():
    with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as live:
        with sqlite3.connect(sys.argv[2]) as backup:
            live.backup(backup)
            if backup.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('SQLite backup failed integrity check')
    print('SQLite backup saved to', sys.argv[2])
else:
    print('First deployment: no existing database to back up.')
PY

if ! docker compose --project-name crashguard-production -f "$candidate" up -d --wait --wait-timeout 120; then
  echo "Deployment failed. Backup and previous configuration: $backup_dir" >&2
  echo 'Inspect container health. Restore the previous image only after checking schema compatibility; see docs/deployment.md.' >&2
  exit 1
fi
mv -- "$candidate" "$root/compose.yaml"
printf '%s\n' "$CRASHGUARD_IMAGE" > "$root/current-image"
echo "Deployment healthy: $CRASHGUARD_IMAGE"
