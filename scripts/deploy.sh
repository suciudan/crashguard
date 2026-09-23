#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

root="${CRASHGUARD_DEPLOY_DIR:-/opt/crashguard}"
export CRASHGUARD_DEPLOY_DIR="$root"
: "${CRASHGUARD_IMAGE:?Set the image digest to deploy}"
: "${APP_URL:?Set the PRODUCTION_URL Environment secret}"
if [[ ! "$CRASHGUARD_IMAGE" =~ ^ghcr\.io/suciudan/crashguard@sha256:[a-f0-9]{64}$ ]]; then
  echo 'Deployment requires a CrashGuard image pinned by SHA-256 digest.' >&2
  exit 1
fi
if [[ "$root" != /* || ! -d "$root/data" ]]; then
  echo 'Create the absolute deployment directory and data directory first.' >&2
  exit 1
fi
command -v python3 >/dev/null
command -v flock >/dev/null
exec 9>"$root/deploy.lock"
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }

# Tools can include configuration in their errors. Keep their output on the VPS,
# including on failure; only fixed status messages go to public Actions logs.
exec 3>&1
touch "$root/deploy.log"
chmod 600 "$root/deploy.log"
exec >"$root/deploy.log" 2>&1
trap 'status=$?; if (( status != 0 )); then echo "Deployment failed. Inspect deploy.log in the deployment directory on the VPS." >&3; fi' EXIT

python3 - <<'PY'
import os
import sys
from urllib.parse import urlsplit

try:
    value = os.environ['APP_URL']
    url = urlsplit(value)
    valid = (url.scheme == 'https' and url.hostname and not url.username
             and not url.password and not url.path and not url.query
             and not url.fragment and not any(c.isspace() for c in value))
    if not valid:
        raise ValueError()
    url.port  # Reject malformed port numbers, without printing the input.
except (KeyError, ValueError):
    print('Set the PRODUCTION_URL Environment secret to an HTTPS origin without a trailing slash.', file=sys.stderr)
    sys.exit(1)
PY

repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# Configuration comes from the approved job's Environment secrets, never a
# repository .env file or a stale host override.
compose=(docker compose --project-name crashguard-production --env-file /dev/null -f "$repo/compose.production.yaml")
if [[ "${CRASHGUARD_NATIVE:-0}" == 1 ]]; then
  compose+=(-f "$repo/compose.native.yaml")
fi
# Save the resolved configuration outside the runner checkout for host operations.
candidate="$root/compose.candidate.yaml"
touch "$candidate"
chmod 600 "$candidate"
"${compose[@]}" config > "$candidate"
docker compose --project-name crashguard-production -f "$candidate" pull

# Check the bind mount as the actual container user, before replacing the app.
# Root running the deployment does not imply the app can write to this directory.
docker compose --project-name crashguard-production -f "$candidate" run --rm --no-deps -T --entrypoint node crashguard -e '
const fs = require("node:fs");
const path = require("node:path");
try {
  const dir = "/app/data";
  const probe = fs.mkdtempSync(path.join(dir, ".write-check-"));
  fs.rmdirSync(probe);
  for (const name of ["crashguard.sqlite", "crashguard.sqlite-wal", "crashguard.sqlite-shm"]) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK);
  }
} catch {
  console.error("The container cannot write to its SQLite data directory or files. Match host data ownership and permissions to CRASHGUARD_UID/CRASHGUARD_GID before retrying.");
  process.exit(1);
}
'

backup_dir="$root/backups/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p -- "$backup_dir"
if [[ -f "$root/compose.yaml" ]]; then
  chmod 600 "$root/compose.yaml"
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
echo 'Deployment healthy.' >&3
