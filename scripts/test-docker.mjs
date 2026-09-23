import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import Database from "better-sqlite3";

// Run against a prebuilt image. All test data stays outside the real data folder.
const port = process.env.TEST_DOCKER_PORT || "5002";
const base = `http://localhost:${port}`;
const image = process.env.CRASHGUARD_IMAGE || "crashguard:docker-test";
const project = `crashguard-smoke-${process.pid}`;
mkdirSync("test-results", { recursive: true });
const dataDir = mkdtempSync(resolve("test-results/docker-data-"));
const env = {
  ...process.env,
  CRASHGUARD_IMAGE: image,
  CRASHGUARD_DATA_DIR: dataDir,
  CRASHGUARD_PORT: port,
  CRASHGUARD_BIND_ADDRESS: "127.0.0.1",
  CRASHGUARD_UID: String(process.getuid()),
  CRASHGUARD_GID: String(process.getgid()),
  NEXT_PUBLIC_APP_URL: base,
  AUTH_ORIGIN: base,
};
function compose(...args) {
  return execFileSync("docker", ["compose", "-p", project, ...args], {
    env,
    encoding: "utf8",
    timeout: 60000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
let browser;
function read(sql, ...params) {
  const database = new Database(resolve(dataDir, "crashguard.sqlite"), {
    readonly: true,
  });
  try {
    return database.prepare(sql).get(...params);
  } finally {
    database.close();
  }
}
try {
  compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "50");
  console.log("Container healthy on an isolated port and host data directory.");
  assert.equal(
    (await fetch(base + "/api/projects", { headers: { Connection: "close" } }))
      .status,
    401,
  );
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await page.goto(base);
  await page
    .getByLabel("Passkey name", { exact: true })
    .fill("Docker test key");
  await page
    .getByRole("button", { name: "Create passkey", exact: true })
    .click();
  await page.waitForURL(base + "/");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.getByLabel("Project name").fill("Container persistence check");
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(
    page.getByText("Point it at CrashGuard", { exact: true }),
  ).toBeVisible();
  const app = read(
    "SELECT * FROM projects WHERE name = ?",
    "Container persistence check",
  );
  const eventId = randomBytes(16).toString("hex");
  const event = {
    event_id: eventId,
    message: "Persist across container replacement",
  };
  const response = await fetch(
    `${base}/api/${app.id}/envelope/?sentry_key=${app.public_key}`,
    {
      method: "POST",
      headers: { Connection: "close" },
      body: `{}\n{"type":"event"}\n${JSON.stringify(event)}\n`,
    },
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, eventId);
  await page.goto(base + "/?status=all");
  await page
    .getByRole("link", {
      name: "Persist across container replacement",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Mark resolved", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Reopen issue", exact: true }),
  ).toBeVisible();
  const issue = read("SELECT * FROM issues WHERE project_id = ?", app.id);
  assert.equal(issue.status, "resolved");
  assert.ok(existsSync(resolve(dataDir, "crashguard.sqlite")));
  const containerId = compose("ps", "-q", "crashguard").trim();
  const details = JSON.parse(
    execFileSync("docker", ["inspect", containerId], { encoding: "utf8" }),
  )[0];
  assert.notEqual(details.Config.User, "0:0");
  assert.ok(
    details.Mounts.some(
      (m) =>
        m.Type === "bind" &&
        m.Source === dataDir &&
        m.Destination === "/app/data",
    ),
  );

  console.log("Event ingested and issue resolved; recreating the container.");
  compose("down");
  assert.ok(existsSync(resolve(dataDir, "crashguard.sqlite")));
  compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "50");
  assert.notEqual(compose("ps", "-q", "crashguard").trim(), containerId);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Reopen issue", exact: true }),
  ).toBeVisible();
  assert.equal(read("SELECT COUNT(*) AS count FROM events").count, 1);
  assert.equal(
    read("SELECT status FROM issues WHERE id = ?", issue.id).status,
    "resolved",
  );
  assert.equal(read("SELECT name FROM passkeys").name, "Docker test key");
  assert.equal(read("SELECT event_id FROM events").event_id, eventId);
  console.log(
    "PASS: non-root container, authentication, native SQLite ingestion, host bind mount, and event/status persistence after container removal and recreation.",
  );
} finally {
  await browser?.close();
  compose("down", "--remove-orphans");
}
