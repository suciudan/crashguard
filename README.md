![CrashGuard — logo and wordmark on a dark navy background](docs/assets/crashguard-banner.png)

# CrashGuard

Self-hosted monitoring for frontend and backend apps, using official Sentry SDKs.

**Next.js 16 · React 19 · TypeScript · Tailwind CSS 4 · SQLite**

## Quick start

Requires **Node.js 22.13+** (24 recommended) and npm. Run these commands from the checkout; use WSL for a WSL-hosted project.

```bash
npm ci
cp -n .env.example .env.local
npm run dev
```

Open [localhost:5000](http://localhost:5000), create your first passkey, then create a project. **SDK setup** provides your DSN and a button to send a test event.

If SQLite's native module fails to build on Ubuntu, install `build-essential` and `python3`, then rerun `npm ci`.

## Docker

SQLite stays on the host. Stop the local server first if it uses the same port and database.

```bash
cp -n .env.example .env.local
mkdir -p data
docker compose --env-file .env.local up -d --build
```

Open [localhost:5000](http://localhost:5000). The mount is:

```text
./data/crashguard.sqlite → /app/data/crashguard.sqlite
```

Set `CRASHGUARD_DATA_DIR` in `.env.local` to use another host directory; create it before starting. The container user must be able to write there. Container replacement preserves your data.

```bash
docker compose --env-file .env.local logs -f
docker compose --env-file .env.local down
```

See [deployment and storage](docs/operations.md#deployment-and-storage) for permissions, backups, and native crash processing.

## Connect your app

Install the appropriate [Sentry SDK](https://docs.sentry.io/platforms/) in your application and use the DSN from **SDK setup**.

```bash
npm install @sentry/browser  # use @sentry/node for a Node backend
```

```ts
import * as Sentry from "@sentry/browser";

Sentry.init({
  dsn: "http://PROJECT_PUBLIC_KEY@localhost:5000/PROJECT_ID",
  environment: "production",
  release: "my-app@1.0.0",
  sendDefaultPii: false,
  enableLogs: true,
});

Sentry.captureException(new Error("Hello from my app"));
Sentry.logger.info("Application started");
```

Initialize the SDK before your application code. Framework SDKs use their normal setup with the CrashGuard DSN. For remote apps, replace `localhost` with your reachable CrashGuard host.

## Features

| Area                         | Support                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| Issues                       | Grouping, search, filters, resolve/reopen/ignore, stack traces, breadcrumbs, and event context |
| Performance & logs           | Transactions, span timelines, structured logs, and trace correlation                           |
| Replay & profiles            | DOM replay with playback controls; transaction and continuous sampled profiles                 |
| Attachments & native crashes | Binary downloads; minidump processing through optional Symbolicator                            |
| Releases & source maps       | Release tracking and source-map uploads through the UI                                         |
| Alerts                       | Signed webhooks, persistent delivery queue, retries, and delivery history                      |

SDK ingestion uses `POST /api/:projectId/envelope/`. Sentry management and `sentry-cli` release/upload APIs are not implemented.

See [SDK compatibility](docs/operations.md#sdk-compatibility) for supported formats, limits, and feature setup.

## Configuration

Copy [.env.example](.env.example) to `.env.local`.

| Variable              | Default / purpose                                                    |
| --------------------- | -------------------------------------------------------------------- |
| `DATABASE_PATH`       | `./data/crashguard.sqlite` for local runs                            |
| `NEXT_PUBLIC_APP_URL` | Set your public URL; the example uses `http://localhost:5000`        |
| `AUTH_ORIGIN`         | Defaults to the public URL; used for passkeys and dashboard requests |
| `INGEST_RATE_LIMIT`   | `120` requests per project per minute                                |
| `CRASHGUARD_DATA_DIR` | `./data` — host storage directory for Docker                         |

For production, use a stable HTTPS URL and set it **before building**:

```bash
npm run build
npm start
```

Both local servers use port **5000**. The public URL is embedded at build time, so changing it requires a rebuild. Use persistent local storage; there is no automatic data retention.

The first passkey secures the shared workspace. Enroll it before exposing a fresh installation, and add backup keys under **Passkeys**. [Recovery and deployment details →](docs/operations.md)

## Development

```bash
npm test                # isolated protocol, storage, auth, and telemetry tests
npm run typecheck
npm run build
```

Real SDK, browser, passkey, replay, native-crash, and Docker checks are available separately. See [testing](docs/testing.md) for setup and commands. Coverage percentages and CI are not configured yet.

| Path                       | Purpose                                                          |
| -------------------------- | ---------------------------------------------------------------- |
| `src/app/actions/`         | Authenticated UI operations                                      |
| `src/app/api/[projectId]/` | Sentry ingestion                                                 |
| `src/lib/`                 | SQLite, validation, grouping, symbolication, and background jobs |
| `src/components/`          | Dashboard and feature views                                      |
| `tests/`, `scripts/`       | Unit and integration tests                                       |

## License

[MIT](LICENSE)
