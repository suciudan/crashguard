import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import assert from "node:assert/strict";

async function checkFooter(page: Page) {
  const column = await page
    .getByRole("region", { name: "Issues column", exact: true })
    .boundingBox();
  const footer = await page.locator(".table-footer").boundingBox();
  assert.ok(column && footer);
  assert.ok(Math.abs(footer.y + footer.height - column.y - column.height) <= 1);
  assert.ok(footer.y + footer.height <= page.viewportSize()!.height + 1);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollHeight <= innerHeight + 1,
    ),
    true,
  );
  return footer.y;
}

async function main() {
  const temp = mkdtempSync(join(tmpdir(), "crashguard-scroll-"));
  process.env.DATABASE_PATH = join(temp, "test.sqlite");
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const base = `http://localhost:${address.port}`;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const { db, createProject, saveEvents } = await import("../src/lib/db");
  const project = createProject("Scroll test", "node");
  saveEvents(
    project.id,
    Array.from({ length: 65 }, (_, i) => ({
      message: `Scroll test error ${String(i + 1).padStart(2, "0")}`,
      fingerprint: ["scroll-test", String(i)],
      environment: "scroll-test",
    })),
  );
  const server = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(address.port),
    ],
    {
      env: { ...process.env, APP_URL: base, AUTH_ORIGIN: base },
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
  try {
    await expect
      .poll(
        () =>
          fetch(base + "/api/health")
            .then((r) => r.status)
            .catch(() => 0),
        { timeout: 30000 },
      )
      .toBe(200);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
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
    await page.getByLabel("Passkey name").fill("Scroll test");
    await page
      .getByRole("button", { name: "Create passkey", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Issues list", exact: true }),
    ).toBeVisible();
    const list = page.getByRole("region", { name: "Issues list", exact: true });
    mkdirSync("test-results", { recursive: true });
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(`${base}/?view=issues&project=${project.id}`);
      await expect(page.locator(".issue-list-row")).toHaveCount(30);
      await expect(page.locator(".table-footer")).toContainText(
        "Showing 1–30 of 65 issues",
      );
      const initialY = await checkFooter(page);
      await list.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      assert.ok(await list.evaluate((el) => el.scrollTop > 0));
      assert.equal(await checkFooter(page), initialY);
      await page.screenshot({
        path: `test-results/issues-scroll-${viewport.width}.png`,
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "Next page", exact: true })
        .click();
      await expect(page.locator(".table-footer")).toContainText(
        "Showing 31–60 of 65 issues",
      );
      assert.equal(await list.evaluate((el) => el.scrollTop), 0);
      await checkFooter(page);
      await page
        .getByRole("button", { name: "Next page", exact: true })
        .click();
      await expect(page.locator(".issue-list-row")).toHaveCount(5);
      await expect(page.locator(".table-footer")).toContainText(
        "Showing 61–65 of 65 issues",
      );
      await expect(
        page.getByRole("button", { name: "Next page", exact: true }),
      ).toBeDisabled();
      await checkFooter(page);
      await page.getByLabel("Search issues").fill("Scroll test error 01");
      await expect(page.locator(".issue-list-row")).toHaveCount(1);
      await checkFooter(page);
      await page.screenshot({
        path: `test-results/issues-short-${viewport.width}.png`,
        fullPage: true,
      });
    }
    assert.deepEqual(errors, []);
    console.log(
      "Issue scrolling passed: 65 issues, three pages, fixed footer on long/short lists, scroll reset, desktop and mobile.",
    );
  } catch (error) {
    console.error(log);
    throw error;
  } finally {
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
