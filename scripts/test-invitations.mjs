import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { chromium, expect } from "@playwright/test";

// Self-contained: never touches the workspace database or an existing server.
const port = process.env.TEST_DOCKER_PORT || "5006";
const base = `http://localhost:${port}`;
const image = process.env.CRASHGUARD_IMAGE || "crashguard:invitations-test";
mkdirSync("test-results", { recursive: true });
const dataDir = mkdtempSync(resolve("test-results/invitations-"));
const env = {
  ...process.env,
  CRASHGUARD_IMAGE: image,
  CRASHGUARD_DATA_DIR: dataDir,
  CRASHGUARD_PORT: port,
  CRASHGUARD_BIND_ADDRESS: "127.0.0.1",
  CRASHGUARD_UID: String(process.getuid()),
  CRASHGUARD_GID: String(process.getgid()),
  APP_URL: base,
  AUTH_ORIGIN: base,
};
const compose = (...args) =>
  execFileSync(
    "docker",
    ["compose", "-p", `crashguard-invitations-${process.pid}`, ...args],
    { env, encoding: "utf8", stdio: "pipe", timeout: 90000 },
  );
let browser, sql;
try {
  compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "60");
  const container = compose("ps", "-q", "crashguard").trim();
  const actionIds = JSON.parse(
    execFileSync(
      "docker",
      [
        "exec",
        container,
        "node",
        "-e",
        'const m=require("./.next/server/server-reference-manifest.json"); console.log(JSON.stringify(Object.fromEntries(Object.entries(m.node).map(([id,v])=>[v.exportedName,id]))))',
      ],
      { encoding: "utf8" },
    ),
  );
  browser = await chromium.launch({ headless: true });
  sql = new Database(resolve(dataDir, "crashguard.sqlite"));
  const errors = [];
  const authenticatorOptions = {
    protocol: "ctap2",
    transport: "internal",
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  };
  async function client() {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send(
      "WebAuthn.addVirtualAuthenticator",
      { options: authenticatorOptions },
    );
    return { context, page, cdp, authenticatorId };
  }
  async function call(who, name, args = []) {
    assert.ok(actionIds[name], `Missing Server Action ${name}`);
    const response = await who.context.request.post(base + "/", {
      headers: {
        origin: base,
        "next-action": actionIds[name],
        "content-type": "text/plain;charset=UTF-8",
        accept: "text/x-component",
      },
      data: JSON.stringify(args),
    });
    const text = await response.text();
    for (const line of text.split("\n")) {
      try {
        const value = JSON.parse(line.slice(line.indexOf(":") + 1));
        if (
          value &&
          (Object.hasOwn(value, "data") || typeof value.error === "string")
        )
          return value;
      } catch {
        /* Ignore Flight metadata records. */
      }
    }
    throw new Error(`No action result from ${name}: HTTP ${response.status()}`);
  }
  async function data(who, name, args) {
    const result = await call(who, name, args);
    assert.equal(result.error, undefined, `${name}: ${result.error}`);
    return result.data;
  }
  const owner = await client(),
    member = await client(),
    outsider = await client();
  await owner.page.goto(base);
  await owner.page
    .getByLabel("Passkey name", { exact: true })
    .fill("Owner key");
  await owner.page
    .getByRole("button", { name: "Create passkey", exact: true })
    .click();
  await expect(owner.page).toHaveURL(base + "/");
  const membersNav = owner.page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Members", exact: true });
  await membersNav.click();
  await expect(
    owner.page.getByRole("region", { name: "Members", exact: true }),
  ).toContainText("Create a project to start inviting colleagues.");
  await owner.page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Projects", exact: true })
    .click();
  const shared = await data(owner, "addProject", [
    { name: "Shared project", platform: "node" },
  ]);
  const privateProject = await data(owner, "addProject", [
    { name: "Private project", platform: "node" },
  ]);
  async function ingest(project, title) {
    const event = {
      event_id: randomBytes(16).toString("hex"),
      message: title,
      environment:
        project.id === shared.id ? "production" : "hidden-environment",
      release: title + "-release",
    };
    const response = await fetch(
      `${base}/api/${project.id}/envelope/?sentry_key=${project.public_key}`,
      {
        method: "POST",
        body: `${JSON.stringify({ event_id: event.event_id })}\n{"type":"event"}\n${JSON.stringify(event)}\n{"type":"attachment","length":4,"filename":"private.txt"}\nTEST\n`,
      },
    );
    assert.equal(response.status, 200);
  }
  await ingest(shared, "Shared error");
  await ingest(privateProject, "Private error");
  const privateIssue = sql
    .prepare("SELECT id FROM issues WHERE project_id=?")
    .get(privateProject.id).id;
  const privateFile = sql
    .prepare("SELECT id FROM telemetry WHERE project_id=?")
    .get(privateProject.id).id;
  const privateMap = Number(
    sql
      .prepare(
        "INSERT INTO source_maps(project_id,release,filename,debug_id,payload,created_at) VALUES(?,'private-release','private.js','','{}','2026-01-01')",
      )
      .run(privateProject.id).lastInsertRowid,
  );
  const privateRule = Number(
    sql
      .prepare(
        "INSERT INTO alert_rules(project_id,name,url,secret) VALUES(?,'Private rule','https://example.test/hook','test-secret')",
      )
      .run(privateProject.id).lastInsertRowid,
  );
  const privateJob = Number(
    sql
      .prepare(
        "INSERT INTO jobs(kind,dedup,payload,status,available_at,created_at) VALUES('alert','private-job',?,'failed',0,0)",
      )
      .run(JSON.stringify({ rule: privateRule, issue: privateIssue }))
      .lastInsertRowid,
  );
  await owner.page.goto(base + "/?view=projects");
  await owner.page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Members", exact: true })
    .click();
  const card = owner.page.getByRole("region", { name: "Members", exact: true });
  await expect(card).toBeVisible();
  await expect(owner.page.locator(".project-card details")).toHaveCount(0);
  assert.match(
    await membersNav.evaluate((el) => el.previousElementSibling.textContent),
    /^Issues/,
  );
  await owner.page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Projects", exact: true })
    .click();
  await expect(card).toHaveCount(0);
  await owner.page.goBack();
  await expect(card).toBeVisible();
  await card
    .getByLabel("Project", { exact: true })
    .selectOption(String(shared.id));
  await owner.page
    .getByRole("button", { name: "Invite member", exact: true })
    .click();
  await card.getByRole("button", { name: "Create invitation link" }).click();
  await expect(
    card.getByLabel("Invitation link", { exact: false }),
  ).toHaveValue(/\/invite\/[a-f0-9]{64}$/);
  const link = await card
    .getByLabel("Invitation link", { exact: false })
    .inputValue();
  await member.page.goto(link);
  await expect(
    member.page.getByRole("heading", { name: "Join Shared project" }),
  ).toBeVisible();
  await member.page.getByLabel("Account name").fill("Alex Morgan");
  await member.page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await member.page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await member.page.setViewportSize({ width: 1440, height: 1000 });
  await member.page.screenshot({ path: "test-results/invitation-accept.png" });
  await member.page
    .getByRole("button", { name: "Create passkey and join" })
    .click();
  await expect(member.page).toHaveURL(
    base + `/?view=issues&project=${shared.id}`,
  );
  await expect(
    member.page.getByRole("link", { name: "Shared error", exact: true }),
  ).toBeVisible();
  await expect(
    member.page.getByRole("button", { name: "New project", exact: true }),
  ).toHaveCount(0);
  assert.equal(
    (await data(member, "getDashboard", [{}])).account.name,
    "Alex Morgan",
  );
  assert.deepEqual(
    (await data(member, "getDashboard", [{}])).projects.map((p) => p.id),
    [shared.id],
  );
  assert.equal(
    (await call(member, "getIssue", [privateIssue])).error,
    "Issue not found",
  );
  assert.ok(
    (await call(member, "updateIssueStatus", [privateIssue, "resolved"])).error,
  );
  assert.ok((await call(member, "getTelemetryDetail", [privateFile])).error);
  assert.ok((await call(member, "downloadAttachment", [privateFile])).error);
  assert.ok((await call(member, "getReplay", [privateFile])).error);
  assert.equal(
    (
      await data(member, "getTelemetry", [
        { kind: "attachment", project: privateProject.id },
      ])
    ).total,
    0,
  );
  assert.deepEqual(
    (await data(member, "getReleases", [])).map((r) => r.project_id),
    [shared.id],
  );
  assert.ok((await call(member, "getSourceMaps", [privateProject.id])).error);
  assert.deepEqual(await data(member, "getSourceMaps", []), []);
  await data(member, "deleteSourceMap", [privateMap]);
  assert.ok(
    sql.prepare("SELECT 1 FROM source_maps WHERE id=?").get(privateMap),
  );
  assert.deepEqual(await data(member, "getAlerts", []), {
    rules: [],
    deliveries: [],
  });
  await data(member, "setAlertEnabled", [privateRule, false]);
  assert.equal(
    sql.prepare("SELECT enabled FROM alert_rules WHERE id=?").get(privateRule)
      .enabled,
    1,
  );
  assert.ok((await call(member, "retryJob", [privateJob])).error);
  assert.equal(
    sql.prepare("SELECT status FROM jobs WHERE id=?").get(privateJob).status,
    "failed",
  );
  assert.ok(
    (
      await call(member, "findRelatedReplay", [
        privateProject.id,
        "a".repeat(32),
      ])
    ).error,
  );
  assert.ok(
    (
      await call(member, "saveRelease", [
        {
          project: privateProject.id,
          version: "unauthorized",
          notes: "",
          url: "",
          finalized: false,
        },
      ])
    ).error,
  );
  assert.ok((await call(member, "inviteToProject", [shared.id])).error);
  assert.ok((await call(member, "getProjectAccess", [shared.id])).error);
  assert.ok(
    (
      await call(member, "addProject", [
        { name: "Unauthorized", platform: "node" },
      ])
    ).error,
  );
  assert.equal(
    (await call(outsider, "getDashboard", [{}])).code,
    "UNAUTHENTICATED",
  );
  await outsider.page.goto(link);
  await expect(
    outsider.page.getByRole("heading", { name: "Invitation unavailable" }),
  ).toBeVisible();

  // A revoked invitation must fail even after registration options were issued.
  const revoked = await data(owner, "inviteToProject", [shared.id]);
  const revokedId = sql
    .prepare("SELECT id FROM project_invitations WHERE token_hash=?")
    .get(
      createHash("sha256").update(revoked.url.split("/").at(-1)).digest("hex"),
    ).id;
  await outsider.page.route("**/*", async (route) => {
    const request = route.request();
    if (request.headers()["next-action"] === actionIds.registerPasskey)
      await data(owner, "revokeInvitation", [shared.id, revokedId]);
    await route.continue();
  });
  await outsider.page.goto(revoked.url);
  await outsider.page.getByLabel("Account name").fill("Revoked user");
  await outsider.page
    .getByRole("button", { name: "Create passkey and join" })
    .click();
  await expect(outsider.page.locator(".error-banner")).toContainText(
    "invalid, expired, or has already been used",
  );
  assert.equal(
    sql
      .prepare("SELECT COUNT(*) AS n FROM accounts WHERE name='Revoked user'")
      .get().n,
    0,
  );

  // Backup keys and discoverable sign-in remain tied to the member account.
  const ownerKey = (await data(owner, "listPasskeys", [])).keys[0].id;
  await member.page.goto(base + "/settings/security");
  await expect(
    member.page.getByRole("button", { name: "Remove Owner key", exact: true }),
  ).toHaveCount(0);
  await member.cdp.send("WebAuthn.removeVirtualAuthenticator", {
    authenticatorId: member.authenticatorId,
  });
  await member.cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: authenticatorOptions,
  });
  await member.page.getByLabel("New passkey name").fill("Alex backup");
  await member.page
    .getByRole("button", { name: "Add passkey", exact: true })
    .click();
  await expect(member.page.getByRole("status")).toContainText("Passkey added");
  await data(member, "removePasskey", [ownerKey]);
  assert.equal((await data(owner, "listPasskeys", [])).keys.length, 1);
  await member.page
    .getByRole("button", { name: "Sign out", exact: true })
    .click();
  await member.page
    .getByRole("button", { name: "Sign in with passkey" })
    .click();
  await expect(member.page).toHaveURL(base + "/");
  assert.equal(
    (await data(member, "getDashboard", [{}])).account.name,
    "Alex Morgan",
  );

  await member.page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await member.page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await member.page.setViewportSize({ width: 1440, height: 1000 });

  // Existing accounts can accept a second project without creating another key.
  const second = await data(owner, "inviteToProject", [privateProject.id]);
  await member.page.goto(second.url);
  await member.page
    .getByRole("button", { name: "Accept invitation", exact: true })
    .click();
  await expect(member.page).toHaveURL(
    base + `/?view=issues&project=${privateProject.id}`,
  );
  assert.equal((await data(member, "getDashboard", [{}])).projects.length, 2);
  const memberId = sql
    .prepare("SELECT id FROM accounts WHERE name='Alex Morgan'")
    .get().id;
  await data(owner, "removeProjectMember", [privateProject.id, memberId]);
  assert.ok((await call(member, "getIssue", [privateIssue])).error);
  assert.equal((await data(member, "getDashboard", [{}])).projects.length, 1);
  await owner.page.reload();
  await expect(card).toBeVisible();
  await card
    .getByRole("navigation", { name: "Member views" })
    .getByRole("link", { name: /^Members/ })
    .click();
  await expect(
    card.getByRole("link", { name: "Alex Morgan", exact: true }),
  ).toBeVisible();
  await owner.page.screenshot({ path: "test-results/invitation-members.png" });
  await card
    .getByLabel("Project", { exact: true })
    .selectOption(String(privateProject.id));
  await expect(
    card.getByText("No colleagues have joined this project yet.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    card.getByRole("link", { name: "Alex Morgan", exact: true }),
  ).toHaveCount(0);
  await owner.page.goBack();
  await expect(
    card.getByRole("link", { name: "Alex Morgan", exact: true }),
  ).toBeVisible();
  await owner.page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await owner.page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await owner.page.screenshot({ path: "test-results/members-mobile.png" });
  await owner.page.getByLabel("Navigate workspace").selectOption("projects");
  await expect(card).toHaveCount(0);
  await owner.page.getByLabel("Navigate workspace").selectOption("members");
  await expect(card).toBeVisible();
  await card.getByRole("link", { name: "Alex Morgan", exact: true }).click();
  await expect(card.locator(".section-list-pane")).not.toBeVisible();
  await expect(
    card.getByRole("region", { name: "Member details", exact: true }),
  ).toContainText("Alex Morgan");
  await card
    .getByRole("link", { name: "Back to members", exact: true })
    .click();
  await expect(card.locator(".section-list-pane")).toBeVisible();
  await owner.page.setViewportSize({ width: 1440, height: 1000 });
  await expect(card.locator(".section-list-pane")).toBeVisible();
  await expect(card.locator(".section-detail-pane")).toBeVisible();
  await expect(owner.page.locator(".panel-backdrop")).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: invitation UI, passkey signup/sign-in, owner/member isolation, single-use and revoked links, backup keys, existing-account acceptance, and membership removal.",
  );
} finally {
  sql?.close();
  await browser?.close();
  compose("down", "--remove-orphans");
}
