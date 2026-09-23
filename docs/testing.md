# Testing

[Back to README](../README.md)

## Local checks

```bash
npm test
python3 -B -m unittest discover -s tests -p 'test_deploy.py' -v
npx next typegen
npm run typecheck
npm run build
```

`npm test` uses temporary databases to verify authentication, ingestion, validation, grouping, telemetry, source maps, and webhook delivery. It does not need a running server. Deployment tests use temporary SQLite databases and a simulated Docker command to verify backup and failure handling. GitHub Actions runs these checks on hosted runners for pull requests and before production image builds. Coverage reporting and thresholds are not configured.

## SDK and browser tests

Use a **fresh, disposable database**. The passkey test enrolls virtual credentials; never run it against your workspace database. Stop any development server in the same checkout before starting this test instance.

```bash
AUTH_ORIGIN=http://localhost:5001 \
APP_URL=http://localhost:5001 \
DATABASE_PATH=./test-results/integration.sqlite \
npm run dev -- --port 5001
```

In another terminal:

```bash
npx playwright install chromium
export TEST_BASE_URL=http://localhost:5001
export TEST_DATABASE_PATH=./test-results/integration.sqlite

TEST_ALLOW_ENROLLMENT=1 npm run test:passkeys
export TEST_STORAGE_STATE=test-results/passkey-session.json

npm run test:sdk
npm run test:browser
npm run test:links
npm run test:telemetry
npm run test:replay
```

Fixtures require `TEST_DATABASE_PATH` to resolve inside `test-results/`. For Docker, use the host path to its bind-mounted test database. Screenshots and the virtual passkey session are written to this ignored directory.

| Command           | Checks                                                                            |
| ----------------- | --------------------------------------------------------------------------------- |
| `test:passkeys`   | Enrollment, sign-in, authorization, revocation, and backup keys                   |
| `test:sdk`        | Real Node SDK error ingestion                                                     |
| `test:browser`    | Browser SDK capture and dashboard workflows                                       |
| `test:links`      | Navigation, history, occurrence URLs, and missing records                         |
| `test:telemetry`  | Real SDK transactions, logs, attachments, profiles, replay, and source-map upload |
| `test:replay`     | Playback blocks recorded scripts and external requests                            |
| `test:operations` | Alert configuration, background delivery attempts, and releases                   |
| `test:native`     | Real minidump processing and stored native frames                                 |

For `test:operations`, the test server must listen on port **5000 inside its container** (or locally), with `ALERT_WEBHOOK_HOSTS=127.0.0.1`. Set `TEST_BASE_URL` to its published URL. This test intentionally sends a webhook to the test app's health route to verify failed-delivery history.

For `test:native`, also set `SYMBOLICATOR_URL` and `TEST_MINIDUMP_PATH`. A running Symbolicator and a real dump are required; fixtures are available in the [Symbolicator test suite](https://github.com/getsentry/symbolicator/tree/master/tests/fixtures).

## Docker persistence

With Docker and Playwright Chromium installed:

```bash
docker build -t crashguard:docker-test .
node scripts/test-docker.mjs
```

This test uses port 5002 and a separate database under `test-results/`. It recreates the container and verifies that events, issue status, passkeys, and sessions persist. Test containers are removed afterward; the database remains for inspection.
