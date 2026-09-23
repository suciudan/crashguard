# Production deployment

[Back to README](../README.md)

The workflows target `suciudan/crashguard` and an **x64 Linux VPS**. Pull requests targeting `main` or `production` run checks on GitHub-hosted runners. Merging a pull request from this repository's `main` into `production` tests the merged commit, publishes an image to GHCR, then waits for production approval. Your VPS runner deploys that exact image digest with Docker Compose.

The workflow runs on pushes to `production` so GitHub applies the Environment's branch policy to the actual deployment branch. Before building, it checks GitHub's PR metadata: the pushed commit must be the merge result of a `main` → `production` PR from this repository. Direct pushes without a matching merged PR and merges from other branches or forks are skipped. To retry a failed deployment, rerun its existing Actions run.

## Protect the repository first

A public repository lets anyone open a pull request. It does **not** grant permission to merge: only trusted users with write access can do that. Keep repository access limited to maintainers.

Before registering the production runner, configure these GitHub settings:

- **Actions → General → Approval for running fork pull request workflows:** require approval for **all external contributors**. Keep the default workflow token read-only and Actions PR approval disabled.
- **Environments → production:** add `suciudan` as a required reviewer; allow the selected **branch** `production` only. Allow your own deployment approvals if you are the sole maintainer. Disable administrator bypass in the environment settings.
- **Rules → Rulesets:** protect `main` and `production` against deletion and force pushes. Require pull requests and the `Checks` status once the first CI run has registered it. If you add collaborators, require your code-owner review for changes to deployment workflows and scripts.

**Public self-hosted runner caveat:** an environment protects jobs that reference it; it cannot stop a modified PR workflow from requesting the runner without that environment. Labels are not access controls. Inspect every external workflow run before approving it, including changes to workflow files, local actions, scripts, and dependencies. Never run external PR code on this VPS. GitHub [recommends against self-hosted runners in public repositories](https://docs.github.com/en/actions/reference/security/secure-use#hardening-for-self-hosted-runners); these controls reduce exposure but do not provide isolation. Docker access gives a runner substantial control over the host.

## Prepare the VPS

Install Docker Engine with Compose v2.20+ (or v5), Python 3, Git, and `flock` (Ubuntu's `util-linux`). Use a dedicated runner account with Docker access. Run the following as that account, with `sudo` for the initial directory creation:

```bash
sudo install -d -m 750 -o "$(id -u)" -g "$(id -g)" /opt/crashguard
# These must match the container UID/GID Environment secrets (default: 1000).
sudo install -d -m 750 -o 1000 -g 1000 /opt/crashguard/data
```

The data directory belongs to the **container user**, even if the runner runs as root. Do not use root's `id -u`/`id -g` for the container. If the dedicated runner uses another non-root UID/GID, use those IDs for the data directory and set matching `CRASHGUARD_UID`/`CRASHGUARD_GID` Environment secrets; the runner also needs access for backups. Deployment checks container write access before replacing the app.

If the first deployment fails because the data directory was created as root, follow [SQLite permission recovery](#sqlite-permission-recovery).

The deployment always mounts `/opt/crashguard/data` into the container. SQLite, its WAL, passkeys, and attachments survive runner checkout cleanup and container replacement. Backups go to `/opt/crashguard/backups`; copy them off-host and set a retention policy appropriate to your storage.

Set up an HTTPS reverse proxy on the VPS, forwarding to `127.0.0.1:5000`. The app's port is bound to loopback. For a private installation, restrict the proxy to your VPN or private network; SDK clients must be able to reach it too. Use a stable hostname for passkeys. Restrict access while enrolling the first passkey. Allow request bodies up to 25 MB for ingestion.

## Register the runner and configure GitHub

1. In **Settings → Actions → Runners → New self-hosted runner**, follow GitHub's Linux x64 installation commands on the VPS. Add the label **`prod`** and install it as a service under the dedicated account.
2. Open **Settings → Environments → production → Environment secrets** and add the values below. Use **secrets**, not configuration variables: GitHub masks secrets in logs; ordinary variables are not automatically masked.
3. Production values are passed only to the approved deployment step. The image is built without them. No SSH credentials or long-lived registry token are needed.
4. Commit and push the workflow files to `main`. Create `production` from the current remote `main` first if the branch does not exist. Open a pull request with **base: `production`** and **compare: `main`**, then merge it when CI passes. After image publication succeeds, open the **Deploy production** run and approve the **production** deployment.

| Environment secret | Purpose / default |
| --- | --- |
| `PRODUCTION_URL` | **Required:** the app's HTTPS origin, without a trailing slash; becomes server-only `APP_URL` at runtime |
| `CRASHGUARD_UID`, `CRASHGUARD_GID` | Host data owner IDs; both default to `1000` |
| `CRASHGUARD_PORT` | Loopback port; defaults to `5000` |
| `INGEST_RATE_LIMIT` | Requests per project per minute; defaults to `120` |
| `ALERT_WEBHOOK_HOSTS` | Optional allowlist of private webhook hostnames |
| `CRASHGUARD_NATIVE` | Set to `1` to start Symbolicator; defaults to `0` |
| `SYMBOLICATOR_SOURCES` | Optional Symbolicator source configuration; defaults to `[]` |

The workflow does not publish the origin as a deployment URL, pass configuration through build arguments or job outputs, or upload deployment logs. Detailed command output and resolved configuration stay on the VPS in files readable only by the runner account (mode `600`). Host administrators and Docker administrators can still access runtime configuration. The address remains visible to people using the app; secret storage does not replace private networking.

GitHub's job token authenticates GHCR. If a package with this name already exists, grant this repository Actions access in that package's settings. The deployment no longer reads `/opt/crashguard/.env.production`; move any settings from that file into Environment secrets. For local development, rename `NEXT_PUBLIC_APP_URL` to `APP_URL`. The runtime origin can change without rebuilding the image.

## Updates and recovery

Each deployment pulls the new image first, takes a consistent SQLite backup using the backup API, then waits for container health. Concurrent deployments are serialized. The resolved Compose file and deployed digest are saved outside the checkout.

```bash
docker compose -p crashguard-production -f /opt/crashguard/compose.yaml ps
docker compose -p crashguard-production -f /opt/crashguard/compose.yaml logs --tail=100
```

If health checks fail, the workflow reports a generic failure. Read `/opt/crashguard/deploy.log` on the VPS for details and the backup location; do not paste that file into public logs or issues. The attempted configuration remains at `/opt/crashguard/compose.candidate.yaml`; inspect it with the same Compose commands. The previous successful configuration remains at `/opt/crashguard/compose.yaml`. There is no automatic database restore or image rollback: a new version may already have migrated the database.

To return to the previous image **after confirming database compatibility**, run:

```bash
docker compose -p crashguard-production -f /opt/crashguard/compose.yaml up -d --wait
```

If restoring a backup is necessary, stop the app first, preserve the current database and its `-wal`/`-shm` files elsewhere, and restore the snapshot with matching ownership. Pair it with the Compose configuration saved in the same backup directory. Restoring loses writes after that snapshot; consult [storage operations](operations.md#deployment-and-storage). Avoid automatic image pruning if you need old images available for recovery.

### SQLite permission recovery

If the container is unhealthy and logs show `SQLITE_CANTOPEN: unable to open database file`, inspect the container and directory ownership **on the production VPS**:

```bash
sudo docker logs --tail 100 crashguard-production-crashguard-1
sudo stat -c '%u:%g %a %n' /opt/crashguard/data
```

A root-owned directory (`0:0`, mode `750`) blocks the default container user (`1000:1000`). For this first-install case, run **on the VPS**:

```bash
sudo chown 1000:1000 /opt/crashguard/data
sudo docker restart crashguard-production-crashguard-1
curl --fail --retry 6 --retry-connrefused --retry-delay 2 \
  http://127.0.0.1:5000/api/health
```

Expect `{"ok":true}`, then **re-run the failed GitHub Actions job** to finish deployment and save the successful configuration. Use your configured `CRASHGUARD_UID`, `CRASHGUARD_GID`, and `CRASHGUARD_PORT` if they differ from these defaults. Existing SQLite, WAL, and SHM files must also be readable and writable by the container user; changing only the directory owner does not change file ownership.
