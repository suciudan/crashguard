import { chromium, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createProject, dashboard, envelope } from "./test-data";

async function main() {
  const base = process.env.TEST_BASE_URL || "http://localhost:5002";
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1080 },
    storageState: process.env.TEST_STORAGE_STATE,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const project = createProject(`Link tests ${Date.now()}`, "node");
    const ids: string[] = [];
    // More than 50 occurrences prove a shared older event remains accessible.
    for (let i = 0; i < 55; i++) {
      const id = randomBytes(16).toString("hex");
      ids.push(id);
      const sent = await context.request.post(
        `${base}/api/${project.id}/envelope/?sentry_key=${project.public_key}`,
        {
          data: envelope({
            event_id: id,
            message: "Shareable error",
            environment: "links",
            extra: { occurrence: i },
            breadcrumbs: [{ message: `Occurrence ${i}` }],
          }),
        },
      );
      expect(sent.status()).toBe(200);
    }
    const result = dashboard(
      new URLSearchParams({ project: String(project.id), status: "all" }),
    );
    const issue = result.issues[0];
    const listUrl = `${base}/?project=${project.id}&environment=links&hours=168&status=all&sort=frequency&q=Shareable`;
    await page.goto(listUrl);
    await expect(page.getByLabel("Project", { exact: true })).toHaveValue(
      String(project.id),
    );
    await expect(page.getByLabel("Environment", { exact: true })).toHaveValue(
      "links",
    );
    await expect(page.getByLabel("Time range")).toHaveValue("168");
    await expect(page.getByLabel("Search issues")).toHaveValue("Shareable");
    await expect(page.getByLabel("Sort issues")).toHaveValue("frequency");
    await page
      .getByRole("link", { name: "Shareable error", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`issue=${issue.id}`));
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.goForward();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("link", { name: "Raw event", exact: true }).click();
    await expect(page.locator(".panel-content pre")).toContainText(ids[54]);
    await page.getByLabel("Event occurrence").selectOption(ids[53]);
    await expect(page.locator(".panel-content pre")).toContainText(ids[53]);
    const sharedUrl = page.url();
    expect(new URL(sharedUrl).searchParams.get("event")).toBe(ids[53]);
    expect(new URL(sharedUrl).searchParams.get("tab")).toBe("raw");
    const colleague = await context.newPage();
    await colleague.goto(sharedUrl);
    await expect(colleague.locator(".panel-content pre")).toContainText(
      ids[53],
    );
    await colleague.reload();
    await expect(colleague.locator(".panel-content pre")).toContainText(
      ids[53],
    );
    await colleague.goto(`${base}/?issue=${issue.id}&event=${ids[0]}&tab=raw`);
    await expect(colleague.locator(".panel-content pre")).toContainText(ids[0]);
    await expect(
      colleague.getByLabel("Event occurrence").locator("option"),
    ).toHaveCount(51);
    await colleague
      .getByRole("button", { name: "Mark resolved", exact: true })
      .click();
    await expect(
      colleague.getByRole("button", { name: "Reopen issue", exact: true }),
    ).toBeVisible();
    await colleague.reload();
    await expect(colleague.locator(".panel-content pre")).toContainText(ids[0]);
    await expect(
      colleague.getByRole("button", { name: "Reopen issue", exact: true }),
    ).toBeVisible();
    await colleague.goto(`${base}/?issue=${issue.id}&event=${"0".repeat(32)}`);
    await expect(colleague.locator(".error-banner")).toContainText(
      "occurrence was not found",
    );
    await colleague.goto(`${base}/?issue=999999999`);
    await expect(colleague.locator(".error-banner")).toContainText(
      "Issue not found",
    );
    await expect(colleague.getByText("Loading event…")).toHaveCount(0);
    await page.getByRole("button", { name: "Close issue" }).click();
    await expect(page.getByLabel("Search issues")).toHaveValue("Shareable");
    await expect(page).not.toHaveURL(/issue=/);
    await page
      .getByRole("navigation")
      .getByRole("link", { name: "Projects", exact: true })
      .click();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Projects", exact: true }),
    ).toBeVisible();
    const card = page
      .locator(".project-card")
      .filter({ hasText: project.name });
    const setupLink = card.getByRole("link", { name: "SDK setup" });
    const popupPromise = context.waitForEvent("page");
    await setupLink.click({ modifiers: ["Control"] });
    const popup = await popupPromise;
    await popup.waitForLoadState();
    await expect(
      popup.getByText("Point it at CrashGuard", { exact: true }),
    ).toBeVisible();
    await popup.getByRole("link", { name: "Python", exact: true }).click();
    await popup.reload();
    await expect(popup.locator(".code-block").first()).toContainText(
      "pip install sentry-sdk",
    );
    await expect(popup.locator(".setup-project select")).toHaveValue(
      String(project.id),
    );
    await page.goto(`${listUrl}&offset=30`);
    await page.reload();
    await expect(page).toHaveURL(/offset=30/);
    await expect(page.locator("tbody tr")).toHaveCount(0);
    await page.getByLabel("Time range").selectOption("720");
    await expect(page).not.toHaveURL(/offset=/);
    await page.getByLabel("Search issues").fill("Shareable & detail");
    await page.reload();
    await expect(page.getByLabel("Search issues")).toHaveValue(
      "Shareable & detail",
    );
    await page.goto(listUrl);
    expect(page.url()).toBe(listUrl);
    await page.setViewportSize({ width: 390, height: 844 });
    mkdirSync("test-results", { recursive: true });
    await page.screenshot({
      path: "test-results/links-mobile.png",
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.goto(sharedUrl);
    await expect(page.locator(".panel-content pre")).toContainText(ids[53]);
    await page.screenshot({
      path: "test-results/links-issue-mobile.png",
      fullPage: true,
    });
    expect(errors).toEqual([]);
    console.log(
      "PASS: address-bar issue/occurrence links, older events, authentication, reload, history, missing links, filters/pagination, SDK links, new tabs, and mobile layout.",
    );
  } finally {
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
