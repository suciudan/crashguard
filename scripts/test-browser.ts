import { chromium, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { build } from "esbuild";
import { createProject, dashboard, envelope } from "./test-data";
async function main() {
  const base = process.env.TEST_BASE_URL || "http://localhost:5000";
  mkdirSync("test-results", { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1080 },
    storageState: process.env.TEST_STORAGE_STATE,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(base);
    await expect(
      page.getByRole("combobox", { name: "Project", exact: true }),
    ).toBeVisible();
    // Test-only fixtures go through ingestion; the application has no demo endpoint.
    const fixture = createProject("UI integration " + Date.now(), "javascript");
    const messages = [
      [
        "TypeError",
        "Cannot read properties of undefined (reading 'price')",
        "calculateTotal",
      ],
      ["DatabaseError", "Connection pool exhausted", "getConnection"],
      ["ReferenceError", "Missing integration dependency", "trackPage"],
      ["FetchError", "Request timed out", "fetchData"],
      ["ValidationError", "Invalid address", "validateAddress"],
      ["TypeError", "Failed to load module", "loadModule"],
      ["CacheWarning", "Cache unavailable", "readCache"],
    ];
    for (const [index, [type, value, fn]] of messages.entries()) {
      const response = await context.request.post(
        base +
          "/api/" +
          fixture.id +
          "/envelope/?sentry_key=" +
          fixture.public_key,
        {
          data: envelope({
            environment: index === 4 ? "staging" : "production",
            release: "browser-test@1.0",
            exception: {
              values: [
                {
                  type,
                  value,
                  stacktrace: {
                    frames: [
                      {
                        filename: "test.ts",
                        function: fn,
                        lineno: 10,
                        in_app: true,
                      },
                    ],
                  },
                },
              ],
            },
            breadcrumbs: [
              { category: "navigation", message: "test navigation" },
              { category: "http", message: "test request" },
              { category: "ui.click", message: "button.checkout-submit" },
            ],
          }),
        },
      );
      expect(response.status()).toBe(200);
    }
    await page.reload();
    await page
      .getByRole("combobox", { name: "Project", exact: true })
      .selectOption(String(fixture.id));
    await expect(
      page.getByRole("link", { name: "TypeError: Cannot read properties" }),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/dashboard-desktop.png",
      fullPage: true,
    });
    await page
      .getByRole("link", { name: "TypeError: Cannot read properties" })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(
      page.getByText("calculateTotal", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/issue-detail.png",
      fullPage: true,
    });
    await page.getByRole("link", { name: "Breadcrumbs (3)" }).click();
    await expect(
      page.getByText("button.checkout-submit", { exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Raw event", exact: true }).click();
    await expect(page.locator(".panel-content pre")).toContainText(
      "browser-test@1.0",
    );
    await page
      .getByRole("button", { name: "Mark resolved", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Reopen issue", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Reopen issue", exact: true })
      .click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await page
      .getByRole("textbox", { name: "Search issues" })
      .fill("Connection pool");
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(page.locator("tbody tr")).toHaveCount(7);
    await page
      .getByRole("combobox", { name: "Environment", exact: true })
      .selectOption("staging");
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await page
      .getByRole("combobox", { name: "Environment", exact: true })
      .selectOption("");
    await page
      .getByRole("button", { name: "New project", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Project name" })
      .fill(`Browser smoke ${Date.now()}`);
    await page
      .getByRole("button", { name: "Create project", exact: true })
      .click();
    await expect(
      page.getByText("Point it at CrashGuard", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Send a test from this browser" })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "Test event received",
      { timeout: 20000 },
    );
    await page.screenshot({
      path: "test-results/sdk-setup.png",
      fullPage: true,
    });
    await page
      .getByRole("link", { name: "Issues", exact: false })
      .first()
      .click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "test-results/dashboard-mobile.png",
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
    // Load the actual SDK with default integrations in a separate origin and
    // prove uncaught errors and unhandled rejections reach this ingestion API.
    const p = createProject(`Automatic browser ${Date.now()}`, "javascript");
    const bundle = await build({
      stdin: {
        contents:
          'import * as Sentry from "@sentry/browser"; window.testSentry = Sentry;',
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
    });
    const source = await context.newPage();
    await source.goto(base.replace("localhost", "127.0.0.1"));
    await source.addScriptTag({ content: bundle.outputFiles[0].text });
    await source.evaluate(
      ({ dsn }) => {
        const sdk = (
          window as unknown as { testSentry: { init: (o: object) => void } }
        ).testSentry;
        sdk.init({
          dsn,
          environment: "auto-browser",
          tracesSampleRate: 0,
          sendDefaultPii: false,
        });
        setTimeout(() => {
          throw new Error("Automatic browser exception");
        }, 10);
        setTimeout(() => {
          void Promise.reject(new Error("Automatic browser rejection"));
        }, 30);
      },
      { dsn: `${base.replace("://", `://${p.public_key}@`)}/${p.id}` },
    );
    await expect
      .poll(
        async () => {
          return dashboard(
            new URLSearchParams({ project: String(p.id), status: "all" }),
          ).stats.events;
        },
        { timeout: 15000 },
      )
      .toBe(2);
    console.log(
      "PASS: project creation, real browser SDK test, automatic exception + rejection across origins, issue details, resolve/reopen, search, filters, mobile layout, no UI runtime errors.",
    );
  } finally {
    await browser.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
