# Production deployment

[Back to README](../README.md)

The workflows target `suciudan/crashguard` and an **x64 Linux VPS**. Pull requests targeting `main` or `production` run checks on GitHub-hosted runners. Merging a pull request from this repository's `main` into `production` tests the merged commit, publishes an image to GHCR, then waits for production approval. Your VPS runner deploys that exact image digest with Docker Compose.

Direct pushes, unmerged closed pull requests, and merges from other branches or forks do not trigger deployment. To retry a failed deployment, rerun its existing Actions run.

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
install -d -m 750 /opt/crashguard/data
umask 077
cat > /opt/crashguard/.env.production <<EOF
CRASHGUARD_UID=$(id -u)
CRASHGUARD_GID=$(id -g)
CRASHGUARD_PORT=5000
INGEST_RATE_LIMIT=120
ALERT_WEBHOOK_HOSTS=
EOF
```

The deployment always mounts `/opt/crashguard/data` into the container. SQLite, its WAL, passkeys, and attachments survive runner checkout cleanup and container replacement. Backups go to `/opt/crashguard/backups`; copy them off-host and set a retention policy appropriate to your storage.

Set up an HTTPS reverse proxy on the VPS, forwarding to `127.0.0.1:5000`. The app's port is bound to loopback. Use a stable hostname for passkeys. Restrict access at the proxy while enrolling the first passkey, then open access to colleagues and SDK clients. Allow request bodies up to 25 MB for ingestion.

## Register the runner and configure GitHub

1. In **Settings → Actions → Runners → New self-hosted runner**, follow GitHub's Linux x64 installation commands on the VPS. Add the label **`prod`** and install it as a service under the dedicated account.
2. In **Settings → Secrets and variables → Actions → Variables**, set repository variable **`PRODUCTION_URL`**, e.g. `https://crashguard.example.com` (no trailing slash). It is used during both image build and deployment. No SSH credentials or long-lived registry token are needed.
3. Optional: set repository variable **`CRASHGUARD_NATIVE=1`** to start Symbolicator for minidumps. Configure `SYMBOLICATOR_SOURCES` in the host environment file if needed.
4. Commit and push the workflow files to `main`. Create `production` from the current remote `main` first if the branch does not exist. Open a pull request with **base: `production`** and **compare: `main`**, then merge it when CI passes. After image publication succeeds, open the **Deploy production** run and approve the **production** deployment.

GitHub's job token authenticates GHCR. If a package with this name already exists, grant this repository Actions access in that package's settings. The default setup requires no production secrets in GitHub; runtime configuration stays in `/opt/crashguard/.env.production`.

## Updates and recovery

Each deployment pulls the new image first, takes a consistent SQLite backup using the backup API, then waits for container health. Concurrent deployments are serialized. The resolved Compose file and deployed digest are saved outside the checkout.

```bash
docker compose -p crashguard-production -f /opt/crashguard/compose.yaml ps
docker compose -p crashguard-production -f /opt/crashguard/compose.yaml logs --tail=100
```

If health checks fail, the workflow fails and prints the backup location. The attempted configuration remains at `/opt/crashguard/compose.candidate.yaml`; inspect it with the same Compose commands. The previous successful configuration remains at `/opt/crashguard/compose.yaml`. There is no automatic database restore or image rollback: a new version may already have migrated the database.

To return to the previous image **after confirming database compatibility**, run:

```bash
docker compose -p crashguard-production -f /opt/crashguard/compose.yaml up -d --wait
```

If restoring a backup is necessary, stop the app first, preserve the current database and its `-wal`/`-shm` files elsewhere, and restore the snapshot with matching ownership. Pair it with the Compose configuration saved in the same backup directory. Restoring loses writes after that snapshot; consult [storage operations](operations.md#deployment-and-storage). Avoid automatic image pruning if you need old images available for recovery.
