import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const runner = resolve("scripts/test-sdk-isolated.ts");
const loader = pathToFileURL(
  createRequire(resolve("package.json")).resolve("tsx"),
).href;

function fixture(t: TestContext, server: string) {
  const dir = mkdtempSync(join(tmpdir(), "crashguard-sdk-runner-"));
  mkdirSync(join(dir, ".next"));
  writeFileSync(join(dir, ".next/BUILD_ID"), "fixture");
  mkdirSync(join(dir, "node_modules/next/dist/bin"), { recursive: true });
  writeFileSync(join(dir, "node_modules/next/dist/bin/next"), server);
  const workspaceDb = join(dir, "workspace.sqlite");
  writeFileSync(workspaceDb, "untouched workspace database");
  const child = spawn(process.execPath, ["--import", loader, runner], {
    cwd: dir,
    env: {
      ...process.env,
      DATABASE_PATH: workspaceDb,
      TEST_DATABASE_PATH: workspaceDb,
      TEST_BASE_URL: "http://127.0.0.1:1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const done = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    const pidPath = join(dir, "server.pid");
    if (existsSync(pidPath)) {
      try {
        process.kill(Number(readFileSync(pidPath, "utf8")), "SIGKILL");
      } catch {
        /* Already stopped. */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    child,
    done,
    output: () => output,
    assertClean() {
      assert.deepEqual(readdirSync(join(dir, "test-results")), []);
      assert.equal(
        readFileSync(workspaceDb, "utf8"),
        "untouched workspace database",
      );
      const pidPath = join(dir, "server.pid");
      if (existsSync(pidPath))
        assert.throws(
          () => process.kill(Number(readFileSync(pidPath, "utf8")), 0),
          { code: "ESRCH" },
        );
    },
  };
}

const server = (status: number) => `
const fs = require("node:fs");
fs.writeFileSync("server.pid", String(process.pid));
fs.writeFileSync(process.env.DATABASE_PATH, "disposable database");
require("node:http").createServer((req, res) => {
  res.writeHead(${status}, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}).listen(Number(process.argv.at(-1)), "127.0.0.1");
`;

test(
  "isolated SDK runner reports startup failures and removes its database",
  { timeout: 15000 },
  async (t) => {
    const f = fixture(
      t,
      'console.error("fixture startup failure"); process.exit(31);',
    );
    assert.equal(await f.done, 1);
    assert.match(f.output(), /fixture startup failure/);
    assert.match(f.output(), /exited before becoming ready/);
    f.assertClean();
  },
);

test(
  "isolated SDK runner propagates SDK failures and stops the healthy server",
  { timeout: 15000 },
  async (t) => {
    // The fixture intentionally has no SDK script/tsx package: its child must fail.
    const f = fixture(t, server(200));
    assert.equal(await f.done, 1);
    assert.match(f.output(), /SDK smoke failed/);
    f.assertClean();
  },
);

test(
  "isolated SDK runner cleans up when interrupted during readiness",
  { timeout: 15000, skip: process.platform === "win32" },
  async (t) => {
    const f = fixture(t, server(503));
    const deadline = Date.now() + 10000;
    while (!existsSync(join(f.dir, "server.pid")) && Date.now() < deadline)
      await delay(25);
    assert.ok(existsSync(join(f.dir, "server.pid")), f.output());
    f.child.kill("SIGTERM");
    assert.equal(await f.done, 143);
    f.assertClean();
  },
);
