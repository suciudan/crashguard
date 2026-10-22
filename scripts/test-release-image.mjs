import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Smoke-test the exact image that will be published, using the pull-only route.
// The bind mount and Compose project are disposable; real user data is untouched.
assert.ok(
  process.env.CRASHGUARD_IMAGE,
  "Set CRASHGUARD_IMAGE to a local candidate image.",
);
const dataDir = mkdtempSync(join(tmpdir(), "crashguard-release-"));
const project = `crashguard-release-${process.pid}`;
const env = {
  ...process.env,
  CRASHGUARD_DATA_DIR: dataDir,
  CRASHGUARD_UID: String(process.getuid()),
  CRASHGUARD_GID: String(process.getgid()),
  CRASHGUARD_BIND_ADDRESS: "127.0.0.1",
  CRASHGUARD_PORT: "0", // Docker allocates a free host port.
  APP_URL: "http://localhost:5000",
  AUTH_ORIGIN: "http://localhost:5000",
};
function compose(...args) {
  return execFileSync(
    "docker",
    ["compose", "-p", project, "-f", "compose.release.yaml", ...args],
    {
      env,
      encoding: "utf8",
      timeout: 150000,
    },
  ).trim();
}
function runNode(source) {
  return compose("exec", "-T", "crashguard", "node", "-e", source);
}
const sqlite = `const db = require('better-sqlite3')(process.env.DATABASE_PATH);`;
try {
  const config = JSON.parse(compose("config", "--format", "json"));
  assert.equal(config.services.crashguard.build, undefined);
  compose(
    "up",
    "-d",
    "--no-build",
    "--pull",
    "never",
    "--wait",
    "--wait-timeout",
    "120",
  );
  const container = compose("ps", "-q", "crashguard");
  const details = JSON.parse(
    execFileSync("docker", ["inspect", container], { encoding: "utf8" }),
  )[0];
  assert.equal(details.Config.User, `${process.getuid()}:${process.getgid()}`);
  assert.ok(
    details.Mounts.some(
      (m) => m.Source === dataDir && m.Destination === "/app/data",
    ),
  );
  runNode(`(async () => {
    const health = await fetch('http://127.0.0.1:5000/api/health');
    if (!health.ok || (await health.json()).ok !== true) throw Error('Health check failed');
    const projects = await fetch('http://127.0.0.1:5000/api/projects');
    if (projects.status !== 401) throw Error('Authentication must be required');
  })().catch(e => { console.error(e); process.exit(1); });`);
  runNode(`${sqlite}
    if (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n < 5) throw Error('Schema missing');
    db.exec("CREATE TABLE release_smoke (value TEXT); INSERT INTO release_smoke VALUES ('persisted');");
    db.close();`);
  compose("down");
  compose(
    "up",
    "-d",
    "--no-build",
    "--pull",
    "never",
    "--wait",
    "--wait-timeout",
    "120",
  );
  assert.notEqual(compose("ps", "-q", "crashguard"), container);
  runNode(`${sqlite}
    if (db.prepare('SELECT value FROM release_smoke').get().value !== 'persisted') throw Error('Data lost after replacement');
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw Error('SQLite integrity check failed');
    db.close();`);
  console.log(
    "PASS: pull-only Compose, runtime health, authentication, SQLite schema/write/integrity, and persistence across container replacement.",
  );
} catch (error) {
  try {
    console.error(compose("logs", "--tail", "100"));
  } catch {
    /* Preserve the initial failure. */
  }
  throw error;
} finally {
  compose("down", "--remove-orphans");
  rmSync(dataDir, { recursive: true, force: true });
}
