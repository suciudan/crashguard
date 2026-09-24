import { chromium, expect, type Browser } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import assert from "node:assert/strict";

async function main() {
  const temp = mkdtempSync(join(tmpdir(), "crashguard-mcp-browser-"));
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const base = `http://localhost:${port}`;
  process.env.DATABASE_PATH = join(temp, "test.sqlite");
  process.env.AUTH_ORIGIN = base;
  const { db, createProject, saveEvents } = await import("../src/lib/db");
  const project = createProject("MCP browser fixture", "node");
  saveEvents(project.id, [
    { message: "Checkout test error", environment: "production" },
  ]);
  const server = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      env: { ...process.env, APP_URL: base },
      stdio: "pipe",
    },
  );
  let log = "";
  server.stdout.on("data", (chunk) => {
    log = (log + chunk).slice(-8000);
  });
  server.stderr.on("data", (chunk) => {
    log = (log + chunk).slice(-8000);
  });
  let browser: Browser | undefined;
  const client = new Client({
    name: "crashguard-browser-check",
    version: "1.0.0",
  });
  try {
    browser = await chromium.launch({ headless: true });
    await expect
      .poll(
        async () =>
          fetch(base + "/api/health")
            .then((r) => r.status)
            .catch(() => 0),
        { timeout: 30000 },
      )
      .toBe(200);
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 },
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const cdp = await page.context().newCDPSession(page);
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
    await page.goto(base + "/login");
    await page.getByLabel("Passkey name").fill("Browser test");
    await page
      .getByRole("button", { name: "Create passkey", exact: true })
      .click();
    await page
      .getByRole("link", { name: "MCP", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "MCP", exact: true }),
    ).toBeVisible();
    await page.getByLabel("Connection name").fill("Codex integration test");
    await page
      .getByRole("button", { name: "Create token", exact: true })
      .click();
    const token = await page
      .getByRole("textbox", { name: "New MCP token", exact: true })
      .inputValue();
    assert.match(token, /^cg_mcp_[a-f0-9]{64}$/);
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "New MCP token", exact: true }),
    ).toHaveCount(0);
    await expect(page.locator("pre")).toContainText(base + "/api/mcp");
    await client.connect(
      new StreamableHTTPClientTransport(new URL(base + "/api/mcp"), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 4);
    const search = await client.callTool({
      name: "search_issues",
      arguments: {},
    });
    assert.ok(!search.isError);
    assert.equal(
      (search.structuredContent as Record<string, unknown> | undefined)?.total,
      1,
    );
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Revoke Codex integration test" }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "New MCP token", exact: true }),
    ).toHaveCount(0);
    mkdirSync("test-results", { recursive: true });
    await page.screenshot({
      path: "test-results/mcp-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: "test-results/mcp-mobile.png",
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Revoke Codex integration test" })
      .click();
    await expect(
      page.getByRole("button", { name: "Revoke Codex integration test" }),
    ).toHaveCount(0);
    await assert.rejects(() =>
      client.callTool({ name: "list_projects", arguments: {} }),
    );
    const anonymous = await fetch(base + "/api/mcp", { method: "POST" });
    assert.equal(anonymous.status, 401);
    assert.deepEqual(errors, []);
    console.log(
      "MCP browser + HTTP checks passed: passkey enrollment, token creation, real client tools, desktop/mobile layout, one-time secret display, and revocation.",
    );
  } catch (error) {
    console.error(log);
    throw error;
  } finally {
    await client.close();
    await browser?.close();
    if (server.exitCode === null && server.signalCode === null) {
      const stopped = once(server, "exit");
      server.kill("SIGTERM");
      await stopped;
    }
    db().close();
    rmSync(temp, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
