import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import assert from "node:assert/strict";

async function visibleIssueIds(page: Page) {
  return page.locator(".issue-list-row").evaluateAll((links) =>
    links.map((link) => {
      const href = (link as HTMLAnchorElement).href;
      return Number(new URL(href).searchParams.get("issue"));
    }),
  );
}

async function openFilters(page: Page) {
  const button = page.getByRole("button", {
    name: "Issue filters",
    exact: true,
  });
  if ((await button.getAttribute("aria-expanded")) !== "true")
    await button.click();
}

async function checkNoHorizontalOverflow(page: Page) {
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    true,
  );
}

async function main() {
  const temp = mkdtempSync(join(tmpdir(), "crashguard-history-"));
  process.env.DATABASE_PATH = join(temp, "test.sqlite");
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const base = `http://localhost:${address.port}`;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const { db, createProject, saveEvents, setStatus } =
    await import("../src/lib/db");
  const project = createProject("History test", "node");
  const oldDate = new Date(Date.now() - 45 * 86400000)
    .toISOString()
    .slice(0, 10);
  const oldMidnight = Date.parse(`${oldDate}T00:00:00.000Z`);
  const eventId = (id: number) => id.toString(16).padStart(32, "0");
  const historicalEvents = Array.from({ length: 65 }, (_, index) => ({
    event_id: eventId(index + 1),
    message: `Historical error ${String(index + 1).padStart(2, "0")}`,
    fingerprint: ["history-test", String(index)],
    environment: "history-test",
  }));
  saveEvents(project.id, historicalEvents);
  // One old issue has 120 occurrences, spanning three pages of event history.
  saveEvents(
    project.id,
    Array.from({ length: 119 }, (_, index) => ({
      ...historicalEvents[0],
      event_id: eventId(1000 + index),
      tags: { occurrence: String(index + 2) },
    })),
  );
  const recentEventId = eventId(10000);
  saveEvents(project.id, [
    {
      event_id: recentEventId,
      message: "Current error",
      fingerprint: ["history-test", "current"],
      environment: "history-test",
    },
  ]);
  const at = (milliseconds: number) => new Date(milliseconds).toISOString();
  const setEventTime = db().prepare(
    "UPDATE events SET received_at=?, occurred_at=? WHERE event_id=?",
  );
  db().transaction(() => {
    // Inclusive date boundaries and tied timestamps exercise filtering and
    // deterministic issue pagination, independently of the machine's timezone.
    for (const [index, event] of historicalEvents.entries()) {
      const timestamp = at(
        oldMidnight +
          (index === 0 ? 0 : index === 64 ? 86400000 - 1 : 12 * 3600000),
      );
      setEventTime.run(timestamp, timestamp, event.event_id);
    }
    for (let index = 0; index < 119; index++) {
      const timestamp = at(oldMidnight + (index + 1) * 60000);
      setEventTime.run(timestamp, timestamp, eventId(1000 + index));
    }
    const timestamp = at(Date.now() - 60000);
    setEventTime.run(timestamp, timestamp, recentEventId);
    db()
      .prepare(
        `UPDATE issues SET
        first_seen=(SELECT MIN(received_at) FROM events WHERE issue_id=issues.id),
        last_seen=(SELECT MAX(received_at) FROM events WHERE issue_id=issues.id)`,
      )
      .run();
  })();
  const allIssueIds = db()
    .prepare("SELECT id FROM issues WHERE project_id=? ORDER BY id")
    .all(project.id) as { id: number }[];
  assert.equal(allIssueIds.length, 66);
  const historicalIssue = db()
    .prepare("SELECT issue_id FROM events WHERE event_id=?")
    .get(historicalEvents[0].event_id) as { issue_id: number };
  const occurrenceIds = (
    db()
      .prepare(
        "SELECT event_id FROM events WHERE issue_id=? ORDER BY received_at DESC,id DESC",
      )
      .all(historicalIssue.issue_id) as { event_id: string }[]
  ).map((event) => event.event_id);
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
            .then((response) => response.status)
            .catch(() => 0),
        { timeout: 30000 },
      )
      .toBe(200);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
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
    await page.getByLabel("Passkey name").fill("History test");
    await page
      .getByRole("button", { name: "Create passkey", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Issues list", exact: true }),
    ).toBeVisible();
    mkdirSync("test-results", { recursive: true });

    // No explicit time filter must expose the entire stored issue history.
    await page.goto(`${base}/?view=issues&project=${project.id}`);
    const footer = page.locator(".table-footer");
    await expect(footer).toContainText("Showing 1–30 of 66 issues");
    await expect(page.locator(".issue-list-row")).toHaveCount(30);
    const firstPage = await visibleIssueIds(page);
    const seen = [...firstPage];
    for (const [start, end] of [
      [31, 60],
      [61, 66],
    ]) {
      await page
        .getByRole("button", { name: "Next page", exact: true })
        .click();
      await expect(footer).toContainText(
        `Showing ${start}–${end} of 66 issues`,
      );
      await expect(page.locator(".issue-list-row")).toHaveCount(
        end - start + 1,
      );
      seen.push(...(await visibleIssueIds(page)));
    }
    await expect(
      page.getByRole("button", { name: "Next page", exact: true }),
    ).toBeDisabled();
    assert.equal(new Set(seen).size, 66);
    assert.deepEqual(
      [...seen].sort((a, b) => a - b),
      allIssueIds.map((issue) => issue.id),
    );
    await page.screenshot({
      path: "test-results/history-last-issue-page.png",
      fullPage: true,
    });
    await page.goto(`${base}/?view=issues&project=${project.id}`);
    await expect(footer).toContainText("Showing 1–30 of 66 issues");
    assert.deepEqual(await visibleIssueIds(page), firstPage);
    await openFilters(page);
    await expect(page.getByLabel("Time range", { exact: true })).toHaveValue(
      "all",
    );
    await page.getByLabel("Time range", { exact: true }).selectOption("24");
    await expect(footer).toContainText("Showing 1–1 of 1 issues");
    await expect(page.locator(".issue-list-row")).toHaveText(/Current error/);

    // Status filtering remains available independently of the time window.
    const resolvedId = allIssueIds[1].id;
    setStatus(resolvedId, "resolved");
    await page.goto(
      `${base}/?view=issues&project=${project.id}&status=resolved`,
    );
    await expect(footer).toContainText("Showing 1–1 of 1 issues");
    assert.deepEqual(await visibleIssueIds(page), [resolvedId]);
    await page.goto(`${base}/?view=issues&project=${project.id}&status=all`);
    await expect(footer).toContainText("Showing 1–30 of 66 issues");
    await openFilters(page);
    await page.getByLabel("Time range", { exact: true }).selectOption("custom");
    await page.getByLabel("From date (UTC)", { exact: true }).fill(oldDate);
    await page.getByLabel("Through date (UTC)", { exact: true }).fill(oldDate);
    await page
      .getByRole("button", { name: "Apply dates", exact: true })
      .click();
    await expect(footer).toContainText("Showing 1–30 of 65 issues");
    await expect(page).toHaveURL(new RegExp(`from=${oldDate}.*to=${oldDate}`));
    await page.reload();
    await expect(footer).toContainText("Showing 1–30 of 65 issues");
    await openFilters(page);
    await expect(
      page.getByLabel("From date (UTC)", { exact: true }),
    ).toHaveValue(oldDate);
    await expect(
      page.getByLabel("Through date (UTC)", { exact: true }),
    ).toHaveValue(oldDate);
    await page.screenshot({
      path: "test-results/history-custom-dates.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await checkNoHorizontalOverflow(page);
    await expect(
      page.getByLabel("From date (UTC)", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Through date (UTC)", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/history-custom-dates-mobile.png",
      fullPage: true,
    });

    // Event history is independently paginated and can reach the oldest event.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(
      `${base}/?view=issues&project=${project.id}&status=all&issue=${historicalIssue.issue_id}&tab=raw`,
    );
    const occurrence = page.getByLabel("Event occurrence", { exact: true });
    const older = page.getByRole("button", {
      name: "Older occurrences",
      exact: true,
    });
    const newer = page.getByRole("button", {
      name: "Newer occurrences",
      exact: true,
    });
    const observedOccurrences: string[] = [];
    for (const [offset, count] of [
      [0, 50],
      [50, 50],
      [100, 20],
    ]) {
      if (offset) await older.click();
      await expect(
        page.getByText(
          `Showing occurrences ${offset + 1}–${offset + count} of 120`,
          { exact: true },
        ),
      ).toBeVisible();
      await expect(occurrence.locator("option")).toHaveCount(count);
      const values = await occurrence
        .locator("option")
        .evaluateAll((options) =>
          options.map((option) => (option as HTMLOptionElement).value),
        );
      assert.deepEqual(values, occurrenceIds.slice(offset, offset + count));
      observedOccurrences.push(...values);
      if (offset === 0) await expect(newer).toBeDisabled();
      else await expect(newer).toBeEnabled();
    }
    assert.deepEqual(observedOccurrences, occurrenceIds);
    await expect(older).toBeDisabled();
    await occurrence.selectOption(historicalEvents[0].event_id);
    await expect(page).toHaveURL(
      new RegExp(`event=${historicalEvents[0].event_id}`),
    );
    await page.reload();
    await expect(occurrence).toHaveValue(historicalEvents[0].event_id);
    await expect(
      page.getByText("Showing occurrences 101–120 of 120", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/history-oldest-occurrence.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await checkNoHorizontalOverflow(page);
    await expect(newer).toBeVisible();
    await expect(older).toBeVisible();
    await page.screenshot({
      path: "test-results/history-oldest-occurrence-mobile.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await newer.click();
    await expect(
      page.getByText("Showing occurrences 51–100 of 120", { exact: true }),
    ).toBeVisible();
    assert.equal(new URL(page.url()).searchParams.get("event"), null);
    assert.equal(new URL(page.url()).searchParams.get("tab"), "raw");
    await expect(occurrence).toHaveValue(occurrenceIds[50]);
    await page
      .getByRole("link", { name: "Current error", exact: true })
      .click();
    await expect(occurrence.locator("option")).toHaveCount(1);
    await expect(occurrence).toHaveValue(recentEventId);
    assert.equal(new URL(page.url()).searchParams.get("eventOffset"), null);
    await expect(older).not.toBeVisible();
    assert.deepEqual(errors, []);
    console.log(
      "History browser checks passed: 66 issues across three pages, all-time default, status and inclusive UTC date filters, mobile layout, and all 120 occurrences across three pages.",
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
