# Operations reference

[Back to README](../README.md)

## Deployment and storage

CrashGuard runs as a single instance with a shared workspace. Use persistent local disk for SQLite, including its WAL/SHM files. Avoid network filesystems and ephemeral serverless storage.

- Set server-only `APP_URL` to your HTTPS origin at runtime. The image does not need rebuilding when it changes.
- Passkeys require HTTPS, except on `localhost`. Keep the hostname stable: credentials are bound to it.
- A reverse proxy must preserve the incoming host and protocol. Dashboard writes must match `AUTH_ORIGIN`.
- There is no automatic retention. Monitor disk usage, including attachments and replay recordings.
- For backups, stop the app and copy the entire database directory, or use SQLite's online backup API.

### Docker settings

Compose loads these settings with `--env-file .env.local`:

| Variable                            | Default         | Purpose                                        |
| ----------------------------------- | --------------- | ---------------------------------------------- |
| `CRASHGUARD_DATA_DIR`               | `./data`        | Existing host directory mounted at `/app/data` |
| `CRASHGUARD_PORT`                   | `5000`          | Published port; also update the public URL     |
| `CRASHGUARD_BIND_ADDRESS`           | `127.0.0.1`     | Use `0.0.0.0` for direct remote access         |
| `CRASHGUARD_UID` / `CRASHGUARD_GID` | `1000` / `1000` | Container user; match the directory owner      |

Check Linux/WSL IDs with `id -u` and `id -g`. The container needs write access to the directory and existing SQLite files. Compose does not create or change ownership of the host directory.

Inside Compose, `DATABASE_PATH` is fixed at `/app/data/crashguard.sqlite`; change the host location with `CRASHGUARD_DATA_DIR`. Removing the container preserves the mounted database, passkeys, and sessions. `/api/health` reports service availability.

## Passkeys and recovery

The first successful enrollment creates the workspace owner account and closes unrestricted enrollment. Existing installations migrate their passkeys and sessions to that account without re-enrollment; the WebAuthn user handle stays unchanged. Add backup passkeys from **Passkeys** while signed in. Passkeys belong to individual accounts and can only be managed by their owner.

### Project invitations

The workspace owner can open **Members** from the navigation, select a project in the side panel, and create an invitation link. Share it privately with one colleague. The recipient chooses an account name and registers a passkey, then signs in automatically with access to that project. Existing account holders can sign in to accept the link without creating another account.

Links expire after seven days, are single-use, and can be revoked before acceptance. SQLite stores hashes of invitation tokens. The owner can remove a member’s project access from the same panel; their next request will enforce the updated membership. Removing project access preserves the colleague’s account and access to other projects.

Owners can see all projects, create projects, and manage invitations and memberships. Members can view and manage issues, telemetry, SDK setup, releases, source maps, and alerts only within their invited projects. They cannot create projects or invite other users. Account names are display names, not verified email addresses; possession of an unused invitation link authorizes enrollment.

Set `APP_URL` (or `AUTH_ORIGIN`, if overridden) to your reachable HTTPS origin so generated invitation links and passkeys use the same host.

### Recovery

Sessions expire after seven days. Removing a passkey revokes its sessions; the current key and last remaining key for each account cannot be removed. Private keys stay with the authenticator. SQLite stores public credentials and hashed session tokens.

If every passkey is lost:

1. Stop the app, restrict access, and back up its database directory.
2. From the host checkout with dependencies installed, reset authentication against the correct database:

   ```bash
   DATABASE_PATH=/absolute/path/crashguard.sqlite npm run auth:reset -- --confirm
   ```

3. Restart and enroll a new passkey before restoring access.

The reset removes every account’s passkeys, sessions, and challenges, and revokes pending invitations. Projects, issues, and telemetry remain intact. Enroll the owner’s replacement passkey first, then issue fresh invitations to colleagues who need new accounts. Prefer backup passkeys to a workspace-wide reset.

## SDK compatibility

`POST /api/:projectId/envelope/` accepts both trailing-slash variants without redirects. Authenticate with `sentry_key`, `X-Sentry-Auth`, or the envelope's `dsn`; supplied credentials must agree. Gzip, deflate, and Brotli HTTP encodings are supported.

| Envelope item                      | Stored data                                                   |
| ---------------------------------- | ------------------------------------------------------------- |
| `event`                            | Errors/messages grouped into issues                           |
| `transaction`                      | Transactions and child spans                                  |
| `log`                              | Batched structured logs, including container version 2        |
| `attachment`                       | Original binary data and metadata; minidumps queue processing |
| `replay_event`, `replay_recording` | Replay metadata and plain or zlib-compressed rrweb segments   |
| `profile`, `profile_chunk`         | Sampled frames, stacks, and threads                           |

Retries deduplicate within each project. Invalid supported items reject the whole batch. Unsupported categories, including session aggregates and client reports, are acknowledged in the response's `discarded` array. Sentry management/CLI APIs and legacy store ingestion are outside the compatibility scope.

### Limits and data handling

| Limit                                    | Maximum |
| ---------------------------------------- | ------- |
| Request body, compressed or decompressed | 25 MiB  |
| Items per envelope                       | 100     |
| Individual error event                   | 1 MiB   |
| Expanded replay segment                  | 32 MiB  |
| Expanded telemetry per envelope          | 64 MiB  |
| Replay playback                          | 64 MiB  |
| Source-map upload                        | 20 MiB  |

`INGEST_RATE_LIMIT` defaults to 120 requests per project per minute. Rejected requests return `429` with SDK backoff headers. Public DSN keys grant ingestion access only.

Common secret fields are scrubbed, but this is not comprehensive PII removal. Configure SDK scrubbing and replay masking for your application. Binary attachments are stored unchanged.

Issues group by exception type and application frames, with message fallback and custom fingerprints. New occurrences reopen resolved issues; ignored issues stay ignored. Dashboard periods use receipt time, while SDK timestamps are retained. Issue details show the latest 50 occurrences and can retrieve an older occurrence by ID.

### Tracing, replay, and profiles

Add these options to browser SDK initialization as needed:

```ts
integrations: [
  Sentry.browserTracingIntegration(),
  Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }),
],
tracesSampleRate: 0.1,
replaysSessionSampleRate: 0.1,
replaysOnErrorSampleRate: 1,
```

Replay playback sorts recording segments and flags gaps. The player blocks scripts and external network access; remote media, fonts, and canvas playback are unavailable.

For Node CPU profiling, install `@sentry/profiling-node`, add `nodeProfilingIntegration()`, and configure sampling using the [Sentry profiling guide](https://docs.sentry.io/platforms/javascript/guides/node/profiling/). **Profiles** supports transaction and continuous sampled-stack formats and displays inclusive sample shares. Android binary method traces are not decoded.

### Source maps and releases

**Releases** automatically lists incoming release versions. Use it to create or update notes/URLs, finalize a release, and open its issues.

In **Source maps**, upload a flat version 3 `.map` file. Match it by either:

- Its debug ID and the event's `debug_meta.images`.
- The exact generated file URL and release version.

Include `sourcesContent` for original code context. Uploaded maps apply when opening both existing and new occurrences, preserving original frame coordinates and grouping. Maps are project-scoped; frame URLs are never fetched. Indexed/section maps are not accepted. Uploads and release updates use the UI, not `sentry-cli`.

## Native minidumps

Minidumps arrive as `event.minidump` attachments. Enable the optional Symbolicator container:

```bash
docker compose --env-file .env.local -f compose.yaml -f compose.native.yaml up -d --build
```

For a separate Symbolicator instance, set `SYMBOLICATOR_URL` on the app. Set `SYMBOLICATOR_SOURCES` to a JSON array of [symbol sources](https://getsentry.github.io/symbolicator/api/) to resolve function names and source locations. Without matching symbols, results may contain only module addresses.

**Attachments** shows processing status, stacks, downloads, and failed-job retries. Dumps and results stay in SQLite. The optional container exposes no host port; its symbol cache is disposable.

## Webhook alerts

Create a rule in **Alerts** with a project, URL, and minimum severity. Each new matching error occurrence queues a signed delivery. Duplicate event IDs do not enqueue again; disabling a rule prevents pending deliveries from being sent.

Save the signing secret shown at creation. Payloads include the event, issue, project, rule name, and issue URL.

| Header                   | Receiver use                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `X-CrashGuard-Delivery`  | Stable delivery ID for deduplication                                                    |
| `X-CrashGuard-Timestamp` | Unix seconds; check freshness                                                           |
| `X-CrashGuard-Signature` | `sha256=` followed by HMAC-SHA256 of `<timestamp>.<raw body>`, using the signing secret |

Delivery is at least once. The worker checks every three seconds and retries failures up to eight times with exponential backoff. View history and retry failed jobs in **Alerts**.

Only HTTP(S) URLs are allowed; redirects are not followed. To permit a private-network destination, add its exact hostname to the comma-separated `ALERT_WEBHOOK_HOSTS` setting.
