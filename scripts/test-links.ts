import { chromium, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createProject, dashboard, envelope } from "./test-data";

async function expectThreeColumns(page: Page) {
  const columns = [
    page.locator(".sidebar"),
    page.locator(".section-list-pane"),
    page.locator(".section-detail-pane"),
  ];
  for (const column of columns) await expect(column).toBeVisible();
  const [sidebar, list, detail] = await Promise.all(
    columns.map((column) => column.boundingBox()),
  );
  expect(sidebar!.x + sidebar!.width).toBeLessThanOrEqual(list!.x + 1);
  expect(list!.x + list!.width).toBeLessThanOrEqual(detail!.x + 1);
  expect(Math.abs(list!.y - detail!.y)).toBeLessThanOrEqual(1);
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

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
    mkdirSync("test-results", { recursive: true });
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
            release: "panels@1.0",
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
    await page
      .getByRole("button", { name: "Issue filters", exact: true })
      .click();
    await expect(page.getByLabel("Project", { exact: true })).toHaveValue(
      String(project.id),
    );
    await expect(page.getByLabel("Environment", { exact: true })).toHaveValue(
      "links",
    );
    await expect(page.getByLabel("Time range")).toHaveValue("168");
    await expect(page.getByLabel("Search issues")).toHaveValue("Shareable");
    await expect(page.getByLabel("Sort issues")).toHaveValue("frequency");
    await page.getByRole("button", { name: "Close filters" }).click();
    await expectThreeColumns(page);
    await page
      .getByRole("link", { name: "Shareable error", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`issue=${issue.id}`));
    const issueDetails = page.getByRole("region", {
      name: "Issue details",
      exact: true,
    });
    await expect(issueDetails).toBeVisible();
    await expectThreeColumns(page);
    await page.screenshot({
      path: "test-results/three-panel-issue-desktop.png",
      fullPage: true,
    });
    await expect(
      page.locator(".issue-list-row[aria-current=true]"),
    ).toHaveCount(1);
    await page.goBack();
    await expect(issueDetails).toHaveCount(0);
    await page.goForward();
    await expect(issueDetails).toBeVisible();
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
      page.getByRole("heading", { name: /^Projects(?: |$)/ }),
    ).toBeVisible();
    const card = page
      .locator(".project-card")
      .filter({ hasText: project.name });
    await card.click();
    await expect(page).toHaveURL(new RegExp(`projectDetail=${project.id}`));
    const projectDetails = page.getByRole("region", {
      name: "Project details",
      exact: true,
    });
    await expect(projectDetails).toBeVisible();
    await expectThreeColumns(page);
    await page.screenshot({
      path: "test-results/three-panel-project-desktop.png",
      fullPage: true,
    });
    await expect(card).toHaveAttribute("aria-current", "true");
    const projectUrl = page.url();
    await page.reload();
    await expect(projectDetails).toBeVisible();
    await page.goBack();
    await expect(
      projectDetails.getByRole("heading", { name: "Select a project" }),
    ).toBeVisible();
    await page.goForward();
    await expect(projectDetails).toBeVisible();
    const setupLink = projectDetails.getByRole("link", { name: "SDK setup" });
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
    await page
      .getByRole("navigation")
      .getByRole("link", {
        name: "Releases",
        exact: true,
      })
      .click();
    await expect(page).not.toHaveURL(/projectDetail=/);
    await page.getByLabel("Filter project").selectOption(String(project.id));
    await page
      .locator(".release-list-row")
      .filter({ hasText: "panels@1.0" })
      .click();
    const releaseUrl = page.url();
    expect(new URL(releaseUrl).searchParams.get("releaseId")).toBeTruthy();
    await expectThreeColumns(page);
    await expect(page.locator(".section-detail-pane")).toContainText(
      "panels@1.0",
    );
    await page.screenshot({
      path: "test-results/three-panel-release-desktop.png",
      fullPage: true,
    });
    await page.reload();
    await expect(
      page.locator(".release-list-row[aria-current=true]"),
    ).toHaveCount(1);
    await page.goBack();
    await expect(page).not.toHaveURL(/releaseId=/);
    await page.goForward();
    await expect(page.locator(".section-detail-pane")).toContainText(
      "panels@1.0",
    );

    const logName = `Three panel log ${Date.now()}`;
    const logResponse = await context.request.post(
      `${base}/api/${project.id}/envelope/?sentry_key=${project.public_key}`,
      {
        data: `{}\n{"type":"log"}\n${JSON.stringify({
          items: [
            { timestamp: Date.now() / 1000, level: "info", body: logName },
          ],
        })}\n`,
      },
    );
    expect(logResponse.status()).toBe(200);
    await page.reload();
    await page
      .getByRole("navigation")
      .getByRole("link", {
        name: "Logs",
        exact: true,
      })
      .click();
    await expect(page).not.toHaveURL(/releaseId=/);
    await page.getByLabel("Telemetry project").selectOption(String(project.id));
    const logLink = page
      .locator(".telemetry-record-row")
      .filter({ hasText: logName });
    await logLink.click();
    const logUrl = page.url();
    expect(new URL(logUrl).searchParams.get("record")).toBeTruthy();
    await expectThreeColumns(page);
    await expect(
      page.getByRole("region", { name: "Logs details" }),
    ).toContainText(logName);
    await expect(logLink).toHaveAttribute("aria-current", "true");
    await page.screenshot({
      path: "test-results/three-panel-log-desktop.png",
      fullPage: true,
    });
    await page.reload();
    await expect(
      page.getByRole("region", { name: "Logs details" }),
    ).toContainText(logName);
    await page.goBack();
    await expect(page).not.toHaveURL(/record=/);
    await page.goForward();
    await expect(
      page.getByRole("region", { name: "Logs details" }),
    ).toContainText(logName);
    await page.goto(`${listUrl}&offset=30`);
    await page.reload();
    await expect(page).toHaveURL(/offset=30/);
    await expect(page.locator(".issue-list-row")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Issue filters", exact: true })
      .click();
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
    await expectNoHorizontalOverflow(page);
    await page.goto(sharedUrl);
    await expect(page.locator(".panel-content pre")).toContainText(ids[53]);
    await page.screenshot({
      path: "test-results/links-issue-mobile.png",
      fullPage: true,
    });
    await expect(page.locator(".section-list-pane")).not.toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.getByRole("button", { name: "Close issue" }).click();
    await expect(page.locator(".section-list-pane")).toBeVisible();
    const mobileIssueLink = page.getByRole("link", {
      name: "Shareable error",
      exact: true,
    });
    await mobileIssueLink.focus();
    await mobileIssueLink.press("Enter");
    await expect(page.locator(".section-detail-pane")).toBeFocused();
    await page.getByRole("button", { name: "Close issue" }).click();
    await expect(mobileIssueLink).toBeFocused();
    for (const [detailUrl, back] of [
      [
        projectUrl,
        page.getByRole("link", { name: "Back to projects", exact: true }),
      ],
      [
        releaseUrl,
        page.getByRole("button", {
          name: "Close release details",
          exact: true,
        }),
      ],
      [logUrl, page.getByRole("link", { name: "Back to list", exact: true })],
    ] as const) {
      await page.goto(detailUrl);
      await expect(page.locator(".section-detail-pane")).toBeVisible();
      await expect(page.locator(".section-list-pane")).not.toBeVisible();
      await expectNoHorizontalOverflow(page);
      await back.click();
      await expect(page.locator(".section-list-pane")).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
    expect(errors).toEqual([]);
    console.log(
      "PASS: three-column Issues/Projects/Releases/Logs navigation, reload/history, mobile detail/back, issue/occurrence links, older events, missing links, filters/pagination, SDK links, and new tabs.",
    );
  } finally {
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
